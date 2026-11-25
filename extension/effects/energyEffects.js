/**
 * "Chakra" drawing helpers used by the teleportation timeline: body aura,
 * flash, shockwave ring, heat-haze distortion, lightning arcs and a vignette.
 *
 * The light-emitting helpers (aura, flash, shockwave, lightning) draw with
 * normal blending and are meant to be pointed at a transparent "additive
 * layer" that the caller adds to the picture once per frame. Drawing each of
 * them directly with the 'lighter' blend mode costs a separate GPU pass per
 * call, which is what makes naive canvas glow effects slow.
 */
(function (root) {
  'use strict';
  const NS = (root.__shinobiMeet = root.__shinobiMeet || {});
  const { makeCanvas, resizeCanvas } = NS.util;

  class EnergyEffects {
    constructor() {
      // Quarter-resolution scratch buffers: the aura is blurry anyway, so
      // tinting and blurring at low resolution is ~16× cheaper.
      this._tint = makeCanvas(2, 2);
      this._tintCtx = this._tint.getContext('2d');
      this._blur = makeCanvas(2, 2);
      this._blurCtx = this._blur.getContext('2d');
      this._supportsFilter = typeof this._blurCtx.filter === 'string';
    }

    /**
     * Glowing aura in the shape of `mask` (any canvas whose alpha channel is
     * the person silhouette).
     */
    drawAura(ctx, mask, width, height, intensity, color = 'rgb(40,150,255)', blurPx = 5) {
      if (intensity <= 0.003 || !mask) return;
      const sw = Math.max(2, Math.round(width / 4));
      const sh = Math.max(2, Math.round(height / 4));
      resizeCanvas(this._tint, sw, sh);
      resizeCanvas(this._blur, sw, sh);

      const tint = this._tintCtx;
      tint.globalCompositeOperation = 'source-over';
      tint.clearRect(0, 0, sw, sh);
      tint.drawImage(mask, 0, 0, sw, sh);
      tint.globalCompositeOperation = 'source-in';
      tint.fillStyle = color;
      tint.fillRect(0, 0, sw, sh);

      const blur = this._blurCtx;
      blur.clearRect(0, 0, sw, sh);
      if (this._supportsFilter) blur.filter = `blur(${blurPx}px)`;
      blur.drawImage(this._tint, 0, 0);
      if (this._supportsFilter) blur.filter = 'none';

      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = Math.min(1, intensity);
      ctx.drawImage(this._blur, 0, 0, width, height);
      if (intensity > 1) {
        ctx.globalAlpha = Math.min(1, intensity - 1);
        ctx.drawImage(this._blur, 0, 0, width, height);
      }
      ctx.restore();
    }

    /** Full-frame radial light burst. */
    drawFlash(ctx, width, height, cx, cy, intensity) {
      if (intensity <= 0.003) return;
      const radius = Math.hypot(width, height) * 0.75;
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      gradient.addColorStop(0, `rgba(235,250,255,${intensity})`);
      gradient.addColorStop(0.25, `rgba(120,200,255,${intensity * 0.85})`);
      gradient.addColorStop(0.6, `rgba(30,110,255,${intensity * 0.45})`);
      gradient.addColorStop(1, 'rgba(0,40,200,0)');
      ctx.save();
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    /** Expanding energy ring. */
    drawShockwave(ctx, cx, cy, radius, alpha, thickness) {
      if (alpha <= 0.003 || radius <= 0) return;
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy, radius, radius * 0.92, 0, 0, Math.PI * 2);
      ctx.lineWidth = thickness * 2.6;
      ctx.strokeStyle = `rgba(40,140,255,${alpha * 0.35})`;
      ctx.stroke();
      ctx.lineWidth = thickness;
      ctx.strokeStyle = `rgba(190,235,255,${alpha})`;
      ctx.stroke();
      ctx.restore();
    }

    /**
     * Energy distortion: draws `source` (the composed picture, on a separate
     * canvas) in horizontal bands shifted by a travelling sine wave — a cheap
     * heat-haze / warp. The source must not be the destination canvas: copying
     * a canvas onto itself forces a full snapshot per band (measured ~30 ms).
     */
    drawDistortion(ctx, source, width, height, amplitude, timeSec) {
      // Many thin bands following a smooth travelling wave read as a liquid
      // warp; few bands with unrelated offsets read as a blocky glitch.
      const bands = 72;
      const bandHeight = Math.ceil(height / bands);
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(source, 0, 0, width, height); // fills the edges the shifted bands uncover
      for (let i = 0; i < bands; i++) {
        const y = i * bandHeight;
        const offset = Math.sin(i * 0.26 + timeSec * 15) * amplitude * (0.6 + 0.4 * Math.sin(i * 0.09 - timeSec * 6));
        ctx.drawImage(source, 0, y, width, bandHeight, offset, y, width, bandHeight);
      }
      ctx.restore();
    }

    /** Jagged lightning arc between two points. `seed` changes its shape. */
    drawLightning(ctx, x1, y1, x2, y2, seed, alpha, scale = 1) {
      if (alpha <= 0.003) return;
      const segments = 9;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      for (let i = 1; i < segments; i++) {
        const t = i / segments;
        // Cheap deterministic hash → jitter in [-1, 1].
        const hash = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453;
        const jitter = (hash - Math.floor(hash)) * 2 - 1;
        const wobble = jitter * len * 0.14 * Math.sin(Math.PI * t);
        ctx.lineTo(x1 + dx * t + nx * wobble, y1 + dy * t + ny * wobble);
      }
      ctx.lineTo(x2, y2);
      ctx.lineWidth = 7 * scale;
      ctx.strokeStyle = `rgba(40,130,255,${alpha * 0.4})`;
      ctx.stroke();
      ctx.lineWidth = 2 * scale;
      ctx.strokeStyle = `rgba(215,240,255,${alpha})`;
      ctx.stroke();
      ctx.restore();
    }

    /** Darkened, blue-tinted edges to make the energy read brighter. */
    drawVignette(ctx, width, height, strength) {
      if (strength <= 0.003) return;
      const gradient = ctx.createRadialGradient(
        width / 2,
        height / 2,
        Math.min(width, height) * 0.25,
        width / 2,
        height / 2,
        Math.hypot(width, height) * 0.6
      );
      gradient.addColorStop(0, 'rgba(0,10,40,0)');
      gradient.addColorStop(1, `rgba(0,8,36,${strength})`);
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
  }

  NS.EnergyEffects = EnergyEffects;
})(globalThis);
