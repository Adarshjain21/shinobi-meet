/**
 * Teleportation timeline: activation → dissolve → invisible → reappear → settle.
 *
 * How the "disappearance" works (it is not an opacity fade):
 *   - The frame is divided into a coarse grid of cells.
 *   - A person mask (from the segmenter) says which cells belong to the body.
 *   - Each cell has its own vanish time (a bottom-to-top sweep + noise). When a
 *     body cell vanishes it is replaced by the clean background plate and it
 *     ejects a particle carrying the body's colour at that spot, so the body
 *     visibly breaks apart into energy.
 *   - Once every cell is gone the output is the empty-room background plate
 *     (plus residual energy), while the real camera keeps running untouched.
 *   - Reappearance runs the same thing in reverse: particles converge on each
 *     body cell and the cell switches back to live video when they arrive.
 *
 * The class only draws. It owns no camera, stream or detection logic.
 */
(function (root) {
  'use strict';
  const NS = (root.__shinobiMeet = root.__shinobiMeet || {});
  const { makeCanvas, resizeCanvas, clamp01, easeOut } = NS.util;

  const PHASE_MS = Object.freeze({ activate: 450, dissolve: 750, reappear: 750, settle: 300 });
  const GRID_COLS = 96;
  const PERSON_ALPHA_MIN = 110; // mask alpha above which a cell counts as "body"
  const CELL_FADE = 0.05; // width of a cell's own fade, in phase-progress units
  const PROGRESS_OVERSHOOT = 1.06; // guarantees every cell finishes before the phase ends

  const rand = (min, max) => min + Math.random() * (max - min);

  /**
   * Head-and-shoulders silhouette used when no segmentation mask is available.
   * Built from plain bytes (two ellipses) so that using it never needs a
   * canvas readback. Returns the canvas (for the aura) and the same bytes.
   */
  function createFallbackMask() {
    const width = 160;
    const height = 90;
    const data = new Uint8Array(width * height);
    const image = new ImageData(width, height);
    const inside = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (inside(x, y, 80, 36, 17, 21) || inside(x, y, 80, 98, 46, 44)) {
          const i = y * width + x;
          data[i] = 255;
          image.data.fill(255, i * 4, i * 4 + 4);
        }
      }
    }
    const canvas = makeCanvas(width, height);
    canvas.getContext('2d').putImageData(image, 0, 0);
    return { canvas, alpha: { data, width, height } };
  }

  class TeleportEffect {
    /**
     * @param allowReadback permit canvas pixel readbacks to sample the mask and
     *   frame colours when no pre-computed data is supplied. Fine for the popup
     *   preview; kept off in the live video path, where a synchronous GPU
     *   readback could stall the camera.
     */
    constructor({ allowReadback = false } = {}) {
      this._allowReadback = allowReadback;
      this.active = false;
      this.particles = new NS.ParticleSystem();
      this.energy = new NS.EnergyEffects();
      this._width = 0;
      this._height = 0;
      this._mask = null;
      this._plate = null;
      this._fallbackMask = null;
    }

    static totalMs(holdMs) {
      return PHASE_MS.activate + PHASE_MS.dissolve + holdMs + PHASE_MS.reappear + PHASE_MS.settle;
    }

    /**
     * @param now    performance.now() timestamp of the trigger
     * @param holdMs time to stay invisible
     * @param plate  canvas with the clean background (no person), or null
     * @param mask   canvas whose alpha is the person silhouette, or null.
     *               The owner may keep redrawing it; call maskUpdated() after.
     * @param maskAlpha optional { data, width, height }: the same mask as bytes
     * @param colors    optional { data (RGBA), width, height }: downsampled frame
     */
    start({ now, holdMs, plate, mask, maskAlpha = null, colors = null }) {
      this.active = true;
      this._startTime = now;
      this._lastTime = now;
      this._holdMs = holdMs;
      this._plate = plate || null;
      this._ownsPlate = false;
      this._mask = mask || null;
      this._maskAlpha = maskAlpha;
      this._frameColors = colors;
      this._maskDirty = true;
      this._phase = '';
      this.particles.clear();
    }

    stop() {
      this.active = false;
      this.particles.clear();
    }

    /** Tell the effect that the mask canvas passed to start() has new content. */
    maskUpdated(mask, maskAlpha = null, colors = null) {
      if (mask) this._mask = mask;
      this._maskAlpha = maskAlpha;
      if (colors) this._frameColors = colors;
      this._maskDirty = true;
    }

    // ---------------------------------------------------------------- layout

    _layout(width, height) {
      if (width === this._width && height === this._height) return;
      this._width = width;
      this._height = height;
      this._scale = height / 720;
      this._cols = GRID_COLS;
      this._rows = Math.max(8, Math.round((GRID_COLS * height) / width));
      const cells = this._cols * this._rows;
      this._cellW = width / this._cols;
      this._cellH = height / this._rows;

      this._noise = new Float32Array(cells);
      for (let i = 0; i < cells; i++) this._noise[i] = Math.random();
      this._person = new Uint8Array(cells);
      this._emitted = new Uint8Array(cells);
      this._personCells = [];
      this._ghostCells = [];
      this._colors = new Uint8ClampedArray(cells * 4);

      // Low-res alpha maps that are scaled up (smoothed) when composited.
      this._goneCanvas = makeCanvas(this._cols, this._rows);
      this._goneCtx = this._goneCanvas.getContext('2d');
      this._goneImage = this._goneCtx.createImageData(this._cols, this._rows);
      this._edgeCanvas = makeCanvas(this._cols, this._rows);
      this._edgeCtx = this._edgeCanvas.getContext('2d');
      this._edgeImage = this._edgeCtx.createImageData(this._cols, this._rows);

      // Tiny CPU canvas for reading the mask / frame colours per cell.
      this._sampleCanvas = makeCanvas(this._cols, this._rows);
      this._sampleCtx = this._sampleCanvas.getContext('2d', { willReadFrequently: true });

      this._scratch = makeCanvas(width, height);
      this._scratchCtx = this._scratch.getContext('2d');
      this._base = makeCanvas(width, height);
      this._baseCtx = this._base.getContext('2d', { alpha: false });
      // Additive layer (half resolution — everything on it is soft light).
      this._glowLayer = makeCanvas(Math.ceil(width / 2), Math.ceil(height / 2));
      this._glowCtx = this._glowLayer.getContext('2d');
      this._ghostMask = makeCanvas(this._cols * 2, this._rows * 2);
      this._ghostMaskCtx = this._ghostMask.getContext('2d');
      this._maskDirty = true;
    }

    /** Read the person mask into the cell grid and derive body bounds. */
    _samplePerson() {
      this._maskDirty = false;
      const { _cols: cols, _rows: rows } = this;
      // alphaAt(i): mask value for cell i — from plain bytes when available,
      // otherwise by drawing the mask canvas into a tiny CPU canvas.
      const fromBytes = ({ data, width, height }) => (i) => {
        const x = Math.min(width - 1, ((((i % cols) + 0.5) * width) / cols) | 0);
        const y = Math.min(height - 1, (((((i / cols) | 0) + 0.5) * height) / rows) | 0);
        return data[y * width + x];
      };
      const fromCanvas = (mask) => {
        this._sampleCtx.clearRect(0, 0, cols, rows);
        this._sampleCtx.drawImage(mask, 0, 0, cols, rows);
        const data = this._sampleCtx.getImageData(0, 0, cols, rows).data;
        return (i) => data[i * 4 + 3];
      };
      const read = (alphaAt) => {
        const list = [];
        let sumX = 0;
        let sumY = 0;
        let top = rows;
        let bottom = 0;
        for (let i = 0; i < cols * rows; i++) {
          const alpha = alphaAt(i);
          this._person[i] = alpha;
          if (alpha > PERSON_ALPHA_MIN) {
            list.push(i);
            const row = (i / cols) | 0;
            sumX += i % cols;
            sumY += row;
            if (row < top) top = row;
            if (row > bottom) bottom = row;
          }
        }
        return { list, sumX, sumY, top, bottom };
      };

      let result = { list: [] };
      if (this._maskAlpha) result = read(fromBytes(this._maskAlpha));
      else if (this._mask && this._allowReadback) result = read(fromCanvas(this._mask));
      // No mask, or nobody found in it: use a generic silhouette so the jutsu
      // still plays instead of silently doing nothing.
      if (result.list.length < 12) {
        this._fallbackMask = this._fallbackMask || createFallbackMask();
        this._mask = this._fallbackMask.canvas;
        this._maskAlpha = this._fallbackMask.alpha;
        result = read(fromBytes(this._maskAlpha));
      }

      this._personCells = result.list;
      const n = result.list.length || 1;
      this._bodyX = ((result.sumX / n + 0.5) * this._width) / cols;
      this._bodyY = ((result.sumY / n + 0.5) * this._height) / rows;
      this._bodyTop = result.top;
      this._bodySpan = Math.max(1, result.bottom - result.top);
    }

    /** Capture the frame's colour per cell (tints the body fragments). */
    _sampleColors(source) {
      const { _cols: cols, _rows: rows, _colors: out } = this;
      const thumb = this._frameColors;
      if (thumb) {
        for (let i = 0; i < cols * rows; i++) {
          const x = Math.min(thumb.width - 1, ((((i % cols) + 0.5) * thumb.width) / cols) | 0);
          const y = Math.min(thumb.height - 1, (((((i / cols) | 0) + 0.5) * thumb.height) / rows) | 0);
          const o = (y * thumb.width + x) * 4;
          out[i * 4] = thumb.data[o];
          out[i * 4 + 1] = thumb.data[o + 1];
          out[i * 4 + 2] = thumb.data[o + 2];
        }
      } else if (this._allowReadback) {
        this._sampleCtx.drawImage(source, 0, 0, cols, rows);
        out.set(this._sampleCtx.getImageData(0, 0, cols, rows).data);
      } else {
        // No colour data and readbacks are off: pure-energy fragments.
        for (let i = 0; i < cols * rows; i++) {
          out[i * 4] = 120;
          out[i * 4 + 1] = 190;
          out[i * 4 + 2] = 255;
        }
      }
    }

    /** Body colour at a cell, pulled towards chakra blue. */
    _cellColor(i) {
      const c = this._colors;
      const r = (c[i * 4] * 0.6 + 70 * 0.4) | 0;
      const g = (c[i * 4 + 1] * 0.6 + 190 * 0.4) | 0;
      const b = (c[i * 4 + 2] * 0.6 + 255 * 0.4) | 0;
      return `rgb(${r},${g},${b})`;
    }

    /** 0 at the bottom of the body, 1 at the top → the body goes feet-first. */
    _sweep(i) {
      const row = (i / this._cols) | 0;
      return clamp01(1 - (row - this._bodyTop) / this._bodySpan);
    }

    _vanishThreshold(i) {
      return this._person[i] > PERSON_ALPHA_MIN
        ? 0.04 + 0.78 * (0.62 * this._sweep(i) + 0.38 * this._noise[i])
        : 0.9 + 0.08 * this._noise[i]; // background flips last (invisible: plate ≈ live)
    }

    _returnThreshold(i) {
      return this._person[i] > PERSON_ALPHA_MIN
        ? 0.12 + 0.78 * (0.62 * this._sweep(i) + 0.38 * this._noise[i])
        : 0.02 + 0.06 * this._noise[i]; // background returns first
    }

    // ------------------------------------------------------------- particles

    _emitGather(dt) {
      const cells = this._personCells;
      if (!cells.length) return;
      const s = this._scale;
      const count = Math.round(900 * dt);
      for (let n = 0; n < count; n++) {
        const i = cells[(Math.random() * cells.length) | 0];
        const tx = (i % this._cols + Math.random()) * this._cellW;
        const ty = (((i / this._cols) | 0) + Math.random()) * this._cellH;
        const angle = Math.random() * Math.PI * 2;
        const radius = rand(160, 420) * s;
        this.particles.spawnSeek(
          tx + Math.cos(angle) * radius,
          ty + Math.sin(angle) * radius,
          tx,
          ty,
          rand(0.28, 0.5),
          rand(1.8, 3.6) * s,
          rand(-0.45, 0.45)
        );
      }
    }

    _emitDissolve(i) {
      const s = this._scale;
      const x = (i % this._cols + Math.random()) * this._cellW;
      const y = (((i / this._cols) | 0) + Math.random()) * this._cellH;
      const dx = x - this._bodyX;
      const dy = y - this._bodyY;
      const dist = Math.hypot(dx, dy) || 1;
      const burst = rand(40, 230) * s;
      // One fragment per body cell keeps the peak near ~1500 live particles,
      // which fits a 30 fps budget on integrated graphics.
      this.particles.spawnFree(
        x,
        y,
        (dx / dist) * burst + rand(-60, 60) * s,
        (dy / dist) * burst * 0.5 - rand(60, 260) * s,
        rand(0.45, 1.0),
        rand(2.6, 6.5) * s,
        this._cellColor(i)
      );
    }

    _emitAssemble(i, secondsUntilArrival) {
      if (Math.random() > 0.75) return;
      const s = this._scale;
      const tx = (i % this._cols + 0.5) * this._cellW;
      const ty = (((i / this._cols) | 0) + 0.5) * this._cellH;
      const angle = rand(-Math.PI, 0) + rand(-0.6, 0.6); // mostly from above/sides
      const radius = rand(120, 380) * s;
      this.particles.spawnSeek(
        tx + Math.cos(angle) * radius,
        ty + Math.sin(angle) * radius,
        tx,
        ty,
        Math.max(0.1, secondsUntilArrival),
        rand(2.2, 5) * s,
        rand(-0.5, 0.5),
        this._cellColor(i)
      );
    }

    _emitResidual(dt) {
      const cells = this._ghostCells;
      if (!cells.length) return;
      const s = this._scale;
      const count = Math.random() < 40 * dt ? 1 : 0;
      for (let n = 0; n < count; n++) {
        const i = cells[(Math.random() * cells.length) | 0];
        this.particles.spawnFree(
          (i % this._cols + Math.random()) * this._cellW,
          (((i / this._cols) | 0) + Math.random()) * this._cellH,
          rand(-20, 20) * s,
          -rand(20, 60) * s,
          rand(0.8, 1.5),
          rand(1.4, 2.8) * s
        );
      }
    }

    // ------------------------------------------------------------- rendering

    /**
     * Fill the low-res "gone" and "edge" alpha maps for this frame and emit
     * particles for cells that just changed state.
     * @returns true if at least one cell is (partly) gone
     */
    _updateCells(phase, progress) {
      const gone = this._goneImage.data;
      const edge = this._edgeImage.data;
      const cells = this._cols * this._rows;
      const scaled = progress * PROGRESS_OVERSHOOT;
      const assembleLead = 0.38;
      let any = false;

      for (let i = 0; i < cells; i++) {
        const isPerson = this._person[i] > PERSON_ALPHA_MIN;
        let g;
        if (phase === 'dissolve') {
          g = clamp01((scaled - this._vanishThreshold(i)) / CELL_FADE);
          if (g > 0 && isPerson && !this._emitted[i]) {
            this._emitted[i] = 1;
            this._emitDissolve(i);
          }
        } else if (phase === 'reappear') {
          const threshold = this._returnThreshold(i);
          g = 1 - clamp01((scaled - threshold) / CELL_FADE);
          if (isPerson && !this._emitted[i] && scaled >= threshold - assembleLead) {
            this._emitted[i] = 1;
            const remaining = ((threshold - scaled) / PROGRESS_OVERSHOOT) * (PHASE_MS.reappear / 1000);
            this._emitAssemble(i, remaining);
          }
        } else {
          g = phase === 'hold' ? 1 : 0;
        }

        gone[i * 4 + 3] = g * 255;
        // Bright rim on body cells that are mid-transition.
        const rim = isPerson && g > 0 && g < 1 ? Math.sin(Math.PI * g) : 0;
        edge[i * 4] = 170;
        edge[i * 4 + 1] = 230;
        edge[i * 4 + 2] = 255;
        edge[i * 4 + 3] = rim * 255;
        if (g > 0) any = true;
      }
      this._goneCtx.putImageData(this._goneImage, 0, 0);
      this._edgeCtx.putImageData(this._edgeImage, 0, 0);
      return any;
    }

    _ensurePlate(source, width, height) {
      if (this._plate) return;
      // No clean background available: synthesise one from a heavily blurred
      // frame so the effect still has something to dissolve into.
      const plate = makeCanvas(width, height);
      const ctx = plate.getContext('2d');
      if (typeof ctx.filter === 'string') ctx.filter = `blur(${Math.round(48 * this._scale)}px)`;
      ctx.drawImage(source, 0, 0, width, height);
      this._plate = plate;
    }

    /**
     * Draw one output frame.
     * @param ctx    2D context of the output canvas (sized to the video)
     * @param source current camera frame (VideoFrame, <video> or canvas)
     * @param now    performance.now()
     * @returns whether the effect is still running
     */
    render(ctx, source, now) {
      const width = ctx.canvas.width;
      const height = ctx.canvas.height;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;

      if (!this.active) {
        ctx.drawImage(source, 0, 0, width, height);
        return false;
      }

      this._layout(width, height);
      const elapsed = now - this._startTime;
      const dt = Math.min(0.05, Math.max(0, (now - this._lastTime) / 1000));
      this._lastTime = now;

      // ---- which phase are we in?
      const tDissolve = PHASE_MS.activate;
      const tHold = tDissolve + PHASE_MS.dissolve;
      const tReappear = tHold + this._holdMs;
      const tSettle = tReappear + PHASE_MS.reappear;
      const tEnd = tSettle + PHASE_MS.settle;

      let phase;
      let progress;
      if (elapsed < tDissolve) {
        phase = 'activate';
        progress = elapsed / PHASE_MS.activate;
      } else if (elapsed < tHold) {
        phase = 'dissolve';
        progress = (elapsed - tDissolve) / PHASE_MS.dissolve;
      } else if (elapsed < tReappear) {
        phase = 'hold';
        progress = (elapsed - tHold) / this._holdMs;
      } else if (elapsed < tSettle) {
        phase = 'reappear';
        progress = (elapsed - tReappear) / PHASE_MS.reappear;
      } else if (elapsed < tEnd) {
        phase = 'settle';
        progress = (elapsed - tSettle) / PHASE_MS.settle;
      } else {
        this.stop();
        ctx.drawImage(source, 0, 0, width, height);
        return false;
      }

      if (this._maskDirty) this._samplePerson();
      this._ensurePlate(source, width, height);

      // ---- phase transitions
      if (phase !== this._phase) {
        this._phase = phase;
        if (phase === 'dissolve' || phase === 'reappear') {
          this._emitted.fill(0);
          this._sampleColors(source);
        }
        if (phase === 'hold') {
          // Freeze the silhouette: the residual energy lingers where the body was.
          this._ghostCells = this._personCells.slice();
          this._ghostMaskCtx.clearRect(0, 0, this._ghostMask.width, this._ghostMask.height);
          this._ghostMaskCtx.drawImage(this._mask, 0, 0, this._ghostMask.width, this._ghostMask.height);
        }
      }

      const particles = this.particles;
      particles.centerX = this._bodyX;
      particles.centerY = this._bodyY;
      const s = this._scale;
      if (phase === 'hold') {
        particles.swirl = 110 * s;
        particles.lift = 60 * s;
      } else {
        particles.swirl = 520 * s;
        particles.lift = 260 * s;
      }

      // All light (aura, particle glow, lightning, flashes) is drawn onto one
      // transparent layer in full-frame coordinates and added to the picture
      // in a single blend at the end of the frame.
      const glow = this._glowCtx;
      glow.setTransform(1, 0, 0, 1, 0, 0);
      glow.globalAlpha = 1;
      glow.globalCompositeOperation = 'source-over';
      glow.clearRect(0, 0, this._glowLayer.width, this._glowLayer.height);
      glow.setTransform(this._glowLayer.width / width, 0, 0, this._glowLayer.height / height, 0, 0);

      // Energy distortion strength for this frame. When active, the picture is
      // composed on a separate base canvas and then warped onto the output.
      let distortion = 0;
      if (phase === 'activate') distortion = 3 * progress;
      else if (phase === 'dissolve') distortion = 3 + 12 * Math.sin(Math.PI * progress);
      else if (phase === 'reappear') distortion = 10 * Math.sin(Math.PI * progress);
      distortion *= s;
      const warped = distortion >= 0.5;
      const output = ctx;
      if (warped) {
        resizeCanvas(this._base, width, height);
        ctx = this._baseCtx;
      }

      // ---- 1. video + background plate through the per-cell "gone" map
      const anyGone = this._updateCells(phase, progress);
      if (phase === 'hold') {
        ctx.drawImage(this._plate, 0, 0, width, height); // fully invisible
      } else {
        ctx.drawImage(source, 0, 0, width, height);
        if (anyGone) {
          const scratch = this._scratchCtx;
          resizeCanvas(this._scratch, width, height);
          scratch.globalCompositeOperation = 'source-over';
          scratch.clearRect(0, 0, width, height);
          scratch.drawImage(this._plate, 0, 0, width, height);
          scratch.globalCompositeOperation = 'destination-in';
          scratch.imageSmoothingEnabled = true;
          scratch.drawImage(this._goneCanvas, 0, 0, width, height);
          ctx.drawImage(this._scratch, 0, 0);
        }
      }

      // ---- 2. energy distortion of the composed picture
      ctx = output;
      if (warped) this.energy.drawDistortion(ctx, this._base, width, height, distortion, now / 1000);

      // ---- 3. vignette
      let vignette = 0;
      if (phase === 'activate') vignette = 0.45 * easeOut(progress);
      else if (phase === 'dissolve') vignette = 0.45;
      else if (phase === 'hold') vignette = 0.2 + 0.25 * clamp01(1 - (elapsed - tHold) / 400);
      else if (phase === 'reappear') vignette = 0.2 + 0.25 * Math.sin(Math.PI * progress);
      else vignette = 0.2 * (1 - progress);
      this.energy.drawVignette(ctx, width, height, vignette);

      // ---- 4. body aura
      const flicker = 1 + 0.15 * Math.sin(now * 0.045);
      if (phase === 'activate') {
        this.energy.drawAura(glow, this._mask, width, height, 1.6 * easeOut(progress) * flicker);
      } else if (phase === 'dissolve') {
        this.energy.drawAura(glow, this._mask, width, height, 1.6 * clamp01(1 - progress * 1.15) * flicker);
      } else if (phase === 'hold') {
        const sinceVanish = elapsed - tHold;
        const afterglow = 0.4 * clamp01(1 - sinceVanish / 600);
        const shimmer = 0.07 * (0.6 + 0.4 * Math.sin(now / 180));
        this.energy.drawAura(glow, this._ghostMask, width, height, afterglow + shimmer, 'rgb(30,110,255)', 7);
      } else if (phase === 'reappear') {
        this.energy.drawAura(glow, this._mask, width, height, 1.3 * easeOut(progress) * flicker);
      } else {
        this.energy.drawAura(glow, this._mask, width, height, 1.3 * (1 - progress));
      }

      // ---- 5. glowing rim on cells that are breaking apart / forming
      if (phase === 'dissolve' || phase === 'reappear') {
        glow.imageSmoothingEnabled = true;
        glow.drawImage(this._edgeCanvas, 0, 0, width, height);
      }

      // ---- 6. particles
      if (phase === 'activate') this._emitGather(dt);
      else if (phase === 'hold') this._emitResidual(dt);
      particles.update(dt);
      particles.render(ctx, glow);

      // ---- 7. lightning arcs crackling around the body
      let lightning = 0;
      if (phase === 'activate') lightning = clamp01((progress - 0.3) / 0.3);
      else if (phase === 'dissolve') lightning = clamp01(1 - progress * 1.6);
      else if (phase === 'reappear') lightning = clamp01((progress - 0.45) / 0.3);
      else if (phase === 'settle') lightning = 1 - progress;
      if (lightning > 0) {
        const seed = Math.floor(now / 60);
        const reach = this._bodySpan * this._cellH * 0.6 + 60 * s;
        for (let a = 0; a < 3; a++) {
          const h1 = Math.sin((seed + a * 17) * 12.9898) * 43758.5453;
          const h2 = Math.sin((seed + a * 31) * 78.233) * 43758.5453;
          const angle1 = (h1 - Math.floor(h1)) * Math.PI * 2;
          const angle2 = angle1 + 1.2 + (h2 - Math.floor(h2)) * 1.6;
          this.energy.drawLightning(
            glow,
            this._bodyX + Math.cos(angle1) * reach * 0.35,
            this._bodyY + Math.sin(angle1) * reach * 0.5,
            this._bodyX + Math.cos(angle2) * reach,
            this._bodyY + Math.sin(angle2) * reach,
            seed + a * 7,
            lightning * 0.85,
            s
          );
        }
      }

      // ---- 8. flashes + shockwaves at the vanish and return moments
      const maxRadius = Math.max(width, height) * 0.75;
      const burst = (momentMs, strength) => {
        const since = elapsed - momentMs;
        const flash = since < 0 ? clamp01(1 + since / 160) : clamp01(1 - since / 280);
        this.energy.drawFlash(glow, width, height, this._bodyX, this._bodyY, flash * strength);
        if (since >= 0 && since < 520) {
          const k = easeOut(since / 520);
          this.energy.drawShockwave(glow, this._bodyX, this._bodyY, k * maxRadius, 1 - k, 10 * s);
        }
      };
      if (elapsed < 160) {
        // brief ignition glow right when the seal is recognised
        this.energy.drawFlash(glow, width, height, this._bodyX, this._bodyY, 0.35 * (1 - elapsed / 160));
      }
      burst(tDissolve + PHASE_MS.dissolve * 0.8, 0.9);
      burst(tReappear + PHASE_MS.reappear * 0.85, 0.75);

      // ---- 9. add all the light to the picture in one blend
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this._glowLayer, 0, 0, width, height);
      ctx.restore();

      return true;
    }
  }

  TeleportEffect.PHASE_MS = PHASE_MS;
  NS.TeleportEffect = TeleportEffect;
})(globalThis);
