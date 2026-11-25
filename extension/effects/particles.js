/**
 * Pooled particle system drawn with Canvas 2D.
 *
 * Struct-of-arrays in typed arrays + swap-remove, so a few thousand particles
 * cost no allocations per frame. Two motion modes:
 *
 *   FREE — velocity + drag, with an upward lift and a swirl around a centre
 *          point (used when the body disintegrates).
 *   SEEK — travels from a start point to a target along a curved, eased path
 *          and dies on arrival (used for energy gathering and re-assembly).
 */
(function (root) {
  'use strict';
  const NS = (root.__shinobiMeet = root.__shinobiMeet || {});
  const { makeCanvas } = NS.util;

  const MODE_FREE = 0;
  const MODE_SEEK = 1;

  /** Soft additive glow sprite: white core → cyan → transparent blue. */
  function createGlowSprite(size) {
    const canvas = makeCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const r = size / 2;
    const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.18, 'rgba(170,235,255,0.95)');
    gradient.addColorStop(0.45, 'rgba(40,150,255,0.45)');
    gradient.addColorStop(1, 'rgba(0,60,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return canvas;
  }

  class ParticleSystem {
    constructor(capacity = 3200) {
      this.capacity = capacity;
      this.count = 0;
      this.x = new Float32Array(capacity);
      this.y = new Float32Array(capacity);
      this.vx = new Float32Array(capacity);
      this.vy = new Float32Array(capacity);
      this.age = new Float32Array(capacity);
      this.life = new Float32Array(capacity);
      this.size = new Float32Array(capacity);
      this.mode = new Uint8Array(capacity);
      // SEEK path
      this.sx = new Float32Array(capacity);
      this.sy = new Float32Array(capacity);
      this.tx = new Float32Array(capacity);
      this.ty = new Float32Array(capacity);
      this.curve = new Float32Array(capacity);
      /** CSS colour of the solid "fragment" drawn under the glow ('' = glow only). */
      this.color = new Array(capacity).fill('');

      // FREE-mode force field
      this.centerX = 0;
      this.centerY = 0;
      this.swirl = 0; // tangential acceleration, px/s²
      this.lift = 0; // upward acceleration, px/s²
      this.drag = 1.2; // 1/s

      this._sprite = createGlowSprite(48);
    }

    clear() {
      this.count = 0;
    }

    _alloc() {
      if (this.count >= this.capacity) return -1;
      return this.count++;
    }

    spawnFree(x, y, vx, vy, life, size, color = '') {
      const i = this._alloc();
      if (i < 0) return;
      this.mode[i] = MODE_FREE;
      this.x[i] = x;
      this.y[i] = y;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.age[i] = 0;
      this.life[i] = life;
      this.size[i] = size;
      this.color[i] = color;
    }

    spawnSeek(sx, sy, tx, ty, life, size, curve = 0, color = '') {
      const i = this._alloc();
      if (i < 0) return;
      this.mode[i] = MODE_SEEK;
      this.sx[i] = this.x[i] = sx;
      this.sy[i] = this.y[i] = sy;
      this.tx[i] = tx;
      this.ty[i] = ty;
      this.curve[i] = curve;
      this.age[i] = 0;
      this.life[i] = life;
      this.size[i] = size;
      this.color[i] = color;
    }

    _remove(i) {
      const last = --this.count;
      if (i === last) return;
      this.x[i] = this.x[last];
      this.y[i] = this.y[last];
      this.vx[i] = this.vx[last];
      this.vy[i] = this.vy[last];
      this.age[i] = this.age[last];
      this.life[i] = this.life[last];
      this.size[i] = this.size[last];
      this.mode[i] = this.mode[last];
      this.sx[i] = this.sx[last];
      this.sy[i] = this.sy[last];
      this.tx[i] = this.tx[last];
      this.ty[i] = this.ty[last];
      this.curve[i] = this.curve[last];
      this.color[i] = this.color[last];
    }

    update(dt) {
      const dragFactor = Math.exp(-this.drag * dt);
      for (let i = this.count - 1; i >= 0; i--) {
        const age = (this.age[i] += dt);
        if (age >= this.life[i]) {
          this._remove(i);
          continue;
        }
        if (this.mode[i] === MODE_SEEK) {
          const t = age / this.life[i];
          const eased = t * t * (3 - 2 * t);
          const dx = this.tx[i] - this.sx[i];
          const dy = this.ty[i] - this.sy[i];
          // Bow the path sideways; the offset vanishes at both ends.
          const bow = Math.sin(Math.PI * t) * this.curve[i];
          this.x[i] = this.sx[i] + dx * eased - dy * bow;
          this.y[i] = this.sy[i] + dy * eased + dx * bow;
        } else {
          const rx = this.x[i] - this.centerX;
          const ry = this.y[i] - this.centerY;
          const dist = Math.hypot(rx, ry) || 1;
          this.vx[i] = (this.vx[i] + (-ry / dist) * this.swirl * dt) * dragFactor;
          this.vy[i] = (this.vy[i] + ((rx / dist) * this.swirl - this.lift) * dt) * dragFactor;
          this.x[i] += this.vx[i] * dt;
          this.y[i] += this.vy[i] * dt;
        }
      }
    }

    _alpha(i) {
      const t = this.age[i] / this.life[i];
      if (this.mode[i] === MODE_SEEK) return Math.min(1, t * 5) * (0.55 + 0.45 * t);
      return Math.min(1, this.age[i] / 0.05) * (1 - t) * (1 - t * 0.4);
    }

    /**
     * @param ctx     output context — solid body-coloured fragments go here
     * @param glowCtx context of a transparent "additive layer" — the glows are
     *                drawn there with normal blending and the caller adds the
     *                whole layer to the picture once.
     *
     * Why a layer: measured on an integrated GPU, 2000 sprites drawn directly
     * with the 'lighter' blend mode cost ~130 ms (each non-default blend is
     * its own GPU pass); via a layer the same sprites cost ~10 ms.
     */
    render(ctx, glowCtx) {
      if (this.count === 0) return;
      ctx.save();

      // Pass 1: solid body-coloured fragments (so the body visibly breaks apart).
      ctx.globalCompositeOperation = 'source-over';
      for (let i = 0; i < this.count; i++) {
        const color = this.color[i];
        if (!color) continue;
        const s = this.size[i];
        ctx.globalAlpha = this._alpha(i);
        ctx.fillStyle = color;
        ctx.fillRect(this.x[i] - s * 0.5, this.y[i] - s * 0.5, s, s);
      }

      ctx.restore();

      // Pass 2: energy glow, onto the additive layer.
      const sprite = this._sprite;
      for (let i = 0; i < this.count; i++) {
        const s = this.size[i] * 2.6;
        glowCtx.globalAlpha = this._alpha(i);
        glowCtx.drawImage(sprite, this.x[i] - s, this.y[i] - s, s * 2, s * 2);
      }
      glowCtx.globalAlpha = 1;
    }
  }

  NS.ParticleSystem = ParticleSystem;
})(globalThis);
