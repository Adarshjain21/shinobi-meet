/**
 * Shared namespace + small canvas helpers.
 *
 * These files run as classic scripts in the Meet page's MAIN world (and in the
 * popup for the preview), so they share one namespace object instead of using
 * ES module imports, which MAIN-world content scripts don't support.
 */
(function (root) {
  'use strict';
  const NS = (root.__shinobiMeet = root.__shinobiMeet || {});

  /** OffscreenCanvas when available (no DOM needed), else a detached <canvas>. */
  function makeCanvas(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  function resizeCanvas(canvas, width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      return true;
    }
    return false;
  }

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeIn = (t) => t * t * t;

  NS.util = { makeCanvas, resizeCanvas, clamp01, lerp, easeInOut, easeOut, easeIn };
})(globalThis);
