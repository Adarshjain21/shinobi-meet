/**
 * Background plate — a continuously learned picture of the room WITHOUT the
 * person, so that "vanishing" can reveal a believable empty background.
 *
 * Every time a person mask arrives, the pixels outside the (dilated) mask are
 * copied from the matching camera frame into the plate. Areas the person has
 * never uncovered stay transparent and are filled in at snapshot time with a
 * push-pull inpaint (colours bleed inward from the surrounding known pixels).
 */
(function (root) {
  'use strict';
  const NS = (root.__shinobiMeet = root.__shinobiMeet || {});
  const { makeCanvas, resizeCanvas } = NS.util;

  const MASK_MARGIN = 0.035; // safety margin around the person, as a fraction of frame width
  const PERSON_MIN = 32; // mask value above which a pixel counts as person

  class BackgroundPlate {
    constructor() {
      this._plate = makeCanvas(2, 2);
      this._plateCtx = this._plate.getContext('2d');
      this._hole = makeCanvas(2, 2);
      this._holeCtx = this._hole.getContext('2d');
      this._dilated = makeCanvas(2, 2);
      this._dilatedCtx = this._dilated.getContext('2d');
      this._levels = [];
      this.hasData = false;
    }

    reset() {
      this._plateCtx.clearRect(0, 0, this._plate.width, this._plate.height);
      this.hasData = false;
    }

    /**
     * @param source    canvas holding the camera frame the mask was computed from
     * @param maskAlpha { data, width, height }: person mask as plain bytes
     * @param fillOnly  only fill areas the plate has never seen and leave known
     *                  background untouched (used while the user is invisible,
     *                  so the picture others see stays frozen apart from the
     *                  guessed patch being replaced by the real background)
     */
    update(source, maskAlpha, { fillOnly = false } = {}) {
      if (!maskAlpha) return;
      const width = source.width;
      const height = source.height;
      if (resizeCanvas(this._plate, width, height)) this.hasData = false; // resize clears
      resizeCanvas(this._hole, width, height);

      this._drawDilatedMask(maskAlpha);

      // Frame with the (dilated) person cut out.
      const hole = this._holeCtx;
      hole.globalCompositeOperation = 'source-over';
      hole.clearRect(0, 0, width, height);
      hole.drawImage(source, 0, 0);
      hole.globalCompositeOperation = 'destination-out';
      hole.imageSmoothingEnabled = true;
      hole.drawImage(this._dilated, 0, 0, width, height);

      const plate = this._plateCtx;
      plate.globalCompositeOperation = fillOnly ? 'destination-over' : 'source-over';
      plate.drawImage(this._hole, 0, 0);
      plate.globalCompositeOperation = 'source-over';
      this.hasData = true;
    }

    /**
     * Grow the person mask by a hard safety margin and draw it (opaque where
     * the person may be) into the small `_dilated` canvas.
     *
     * The margin must be a true cut-off: with a soft edge, the half-transparent
     * fringe lets a little of the person's outline into the plate on every
     * update, and that builds up to solid ghost outlines within seconds. The
     * mask is tiny and already available as bytes, so this runs on the CPU
     * (two sliding-window passes) without any GPU readback.
     */
    _drawDilatedMask({ data, width, height }) {
      const size = width * height;
      if (!this._rowPass || this._rowPass.length !== size || this._maskImage.width !== width) {
        this._rowPass = new Uint8Array(size);
        this._maskImage = new ImageData(width, height);
      }
      const rowPass = this._rowPass;
      const out = this._maskImage.data;
      const r = Math.max(2, Math.round(width * MASK_MARGIN));

      // Horizontal: is there a person pixel within r columns?
      for (let y = 0; y < height; y++) {
        const base = y * width;
        let count = 0;
        for (let x = 0; x < r && x < width; x++) if (data[base + x] > PERSON_MIN) count++;
        for (let x = 0; x < width; x++) {
          const add = x + r;
          if (add < width && data[base + add] > PERSON_MIN) count++;
          const drop = x - r - 1;
          if (drop >= 0 && data[base + drop] > PERSON_MIN) count--;
          rowPass[base + x] = count > 0 ? 1 : 0;
        }
      }
      // Vertical: same on the result, written straight into the alpha channel.
      for (let x = 0; x < width; x++) {
        let count = 0;
        for (let y = 0; y < r && y < height; y++) count += rowPass[y * width + x];
        for (let y = 0; y < height; y++) {
          const add = y + r;
          if (add < height) count += rowPass[add * width + x];
          const drop = y - r - 1;
          if (drop >= 0) count -= rowPass[drop * width + x];
          out[(y * width + x) * 4 + 3] = count > 0 ? 255 : 0;
        }
      }

      resizeCanvas(this._dilated, width, height);
      this._dilatedCtx.putImageData(this._maskImage, 0, 0);
    }

    /**
     * @param target optional canvas to draw into instead of allocating one
     * @returns a fully opaque canvas with unknown regions inpainted,
     *          or null if nothing has been learned yet.
     */
    snapshot(target = null) {
      if (!this.hasData) return null;
      const width = this._plate.width;
      const height = this._plate.height;

      // "Push": build a pyramid of progressively halved copies. Canvas scaling
      // averages premultiplied colour, so transparent (unknown) pixels do not
      // dilute the colour of known ones.
      let previous = this._plate;
      let w = width;
      let h = height;
      let levelCount = 0;
      while (w > 4 && h > 4) {
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
        let level = this._levels[levelCount];
        if (!level) level = this._levels[levelCount] = makeCanvas(w, h);
        resizeCanvas(level, w, h);
        const ctx = level.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(previous, 0, 0, w, h);
        previous = level;
        levelCount++;
      }

      // "Pull": stack coarse → fine. Each finer level covers what it knows and
      // lets the coarser average show through where it has holes.
      const out = target || makeCanvas(width, height);
      resizeCanvas(out, width, height);
      const ctx = out.getContext('2d');
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#0c1018';
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      for (let i = levelCount - 1; i >= 0; i--) {
        for (let pass = 0; pass < 3; pass++) ctx.drawImage(this._levels[i], 0, 0, width, height);
      }
      ctx.drawImage(this._plate, 0, 0);
      ctx.drawImage(this._plate, 0, 0);
      return out;
    }
  }

  NS.BackgroundPlate = BackgroundPlate;
})(globalThis);
