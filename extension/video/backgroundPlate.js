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

  const MASK_DILATE_PASSES = 6;

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
     * @param source canvas holding the camera frame the mask was computed from
     * @param mask   canvas whose alpha is the person probability
     */
    update(source, mask) {
      const width = source.width;
      const height = source.height;
      if (resizeCanvas(this._plate, width, height)) this.hasData = false; // resize clears
      resizeCanvas(this._hole, width, height);

      // Grow (dilate) the person mask so no hair/edge pixels of the person
      // leak into the plate: stacking a blurred copy several times pushes the
      // soft edge outwards. Done at quarter resolution — a full-resolution
      // blur here was measured to stall the GPU for most of a second.
      const smallWidth = Math.max(2, Math.round(width / 4));
      const smallHeight = Math.max(2, Math.round(height / 4));
      resizeCanvas(this._dilated, smallWidth, smallHeight);
      const dilated = this._dilatedCtx;
      dilated.clearRect(0, 0, smallWidth, smallHeight);
      if (typeof dilated.filter === 'string') dilated.filter = `blur(${Math.max(2, Math.round(smallWidth * 0.03))}px)`;
      for (let i = 0; i < MASK_DILATE_PASSES; i++) dilated.drawImage(mask, 0, 0, smallWidth, smallHeight);
      dilated.filter = 'none';

      // Frame with the (dilated) person cut out.
      const hole = this._holeCtx;
      hole.globalCompositeOperation = 'source-over';
      hole.clearRect(0, 0, width, height);
      hole.drawImage(source, 0, 0);
      hole.globalCompositeOperation = 'destination-out';
      hole.imageSmoothingEnabled = true;
      hole.drawImage(this._dilated, 0, 0, width, height);

      this._plateCtx.drawImage(this._hole, 0, 0);
      this.hasData = true;
    }

    /**
     * @returns a new fully opaque canvas with unknown regions inpainted,
     *          or null if nothing has been learned yet.
     */
    snapshot() {
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
      const out = makeCanvas(width, height);
      const ctx = out.getContext('2d');
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
