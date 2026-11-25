/**
 * VideoPipeline — wraps ONE physical camera track and exposes a processed
 * track that Google Meet uses (and therefore sends to every participant).
 *
 * Primary path: WebRTC Insertable Streams ("breakout box")
 *     camera track → MediaStreamTrackProcessor → TransformStream → MediaStreamTrackGenerator
 *   - Frames are pulled by the camera, not requestAnimationFrame, so it keeps
 *     running when the Meet tab is in the background.
 *   - While no effect is playing, frames are forwarded untouched (zero copy,
 *     no quality loss, practically no CPU).
 *   - While the jutsu plays, each frame is composited on an OffscreenCanvas
 *     and re-wrapped as a new VideoFrame with the original timestamp.
 *
 * Fallback path (browsers without the breakout box):
 *     camera track → <video> → canvas → canvas.captureStream()
 *
 * The original camera track is never stopped or replaced while Meet still
 * holds the processed track; it is stopped only when Meet stops ours
 * (i.e. when the user turns the camera off or leaves).
 */
(function (root) {
  'use strict';
  const NS = (root.__shinobiMeet = root.__shinobiMeet || {});
  const { makeCanvas, resizeCanvas } = NS.util;

  // Shortly after a stream starts, a few frames are routed through the canvas
  // path with no effect drawn (the picture is unchanged). This primes the
  // "canvas → VideoFrame → encoder" route, whose one-time setup would otherwise
  // cause a visible hitch at the start of the first teleport.
  const PRIME_AFTER_FRAMES = 45;
  const PRIME_FRAME_COUNT = 10;

  const HAS_BREAKOUT_BOX =
    typeof root.MediaStreamTrackProcessor === 'function' && typeof root.MediaStreamTrackGenerator === 'function';

  class VideoPipeline {
    /**
     * @param originalTrack the real camera MediaStreamTrack
     * @param hooks { onFrame(pipeline, source, width, height, now), onClosed(pipeline) }
     */
    constructor(originalTrack, hooks) {
      this.original = originalTrack;
      this.hooks = hooks;
      this.effect = new NS.TeleportEffect();
      this.lastFrameAt = 0;
      this.closed = false;
      this._frameCount = 0;
      this.mode = HAS_BREAKOUT_BOX ? 'insertable-streams' : 'canvas-capture';
      this._liveOutputs = new Set();
      this._abort = new AbortController();

      const output = HAS_BREAKOUT_BOX ? this._buildBreakoutBox() : this._buildCanvasCapture();
      this.track = this._decorate(output);

      // Camera unplugged / revoked: propagate "ended" to the track Meet holds.
      this._onOriginalEnded = () => {
        for (const track of [...this._liveOutputs]) {
          track.__shinobiNativeStop();
          track.dispatchEvent(new Event('ended'));
        }
        this._liveOutputs.clear();
        this._close();
      };
      originalTrack.addEventListener('ended', this._onOriginalEnded);
    }

    // ------------------------------------------------------ breakout box path

    _buildBreakoutBox() {
      const processor = new MediaStreamTrackProcessor({ track: this.original, maxBufferSize: 2 });
      const generator = new MediaStreamTrackGenerator({ kind: 'video' });
      this._canvas = makeCanvas(2, 2);
      this._ctx = this._canvas.getContext('2d', { alpha: false });

      const transformer = new TransformStream({
        transform: (frame, controller) => {
          let output = frame;
          try {
            output = this._processFrame(frame);
          } catch (error) {
            // Never let an effect bug freeze the camera: fall back to the raw frame.
            console.warn('[Shinobi Meet] frame processing failed:', error);
            this.effect.stop();
          }
          if (output !== frame) frame.close();
          controller.enqueue(output);
        },
      });

      processor.readable
        .pipeThrough(transformer, { signal: this._abort.signal })
        .pipeTo(generator.writable)
        .catch(() => {
          /* aborted on close, or the track ended */
        });
      return generator;
    }

    /** @returns the frame to send: the input itself (pass-through) or a new composited frame. */
    _processFrame(frame) {
      const now = performance.now();
      const width = frame.displayWidth;
      const height = frame.displayHeight;
      this.lastFrameAt = now;
      this.hooks.onFrame(this, frame, width, height, now);

      const count = ++this._frameCount;
      if (!this.effect.active) {
        const priming = count > PRIME_AFTER_FRAMES && count <= PRIME_AFTER_FRAMES + PRIME_FRAME_COUNT;
        if (!priming) return frame; // normal case: untouched camera frame
        resizeCanvas(this._canvas, width, height);
        this._ctx.drawImage(frame, 0, 0, width, height);
      } else {
        resizeCanvas(this._canvas, width, height);
        const stillActive = this.effect.render(this._ctx, frame, now);
        if (!stillActive) return frame;
      }

      return new VideoFrame(this._canvas, {
        timestamp: frame.timestamp,
        duration: frame.duration || undefined,
        alpha: 'discard',
      });
    }

    // --------------------------------------------------- canvas capture path

    _buildCanvasCapture() {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([this.original]);
      video.play().catch(() => {});
      this._video = video;

      // captureStream() needs a real HTMLCanvasElement.
      const canvas = document.createElement('canvas');
      const settings = this.original.getSettings();
      canvas.width = settings.width || 1280;
      canvas.height = settings.height || 720;
      this._canvas = canvas;
      this._ctx = canvas.getContext('2d', { alpha: false });

      const draw = () => {
        if (this.closed) return;
        try {
          const width = video.videoWidth;
          const height = video.videoHeight;
          if (width && height) {
            const now = performance.now();
            this.lastFrameAt = now;
            resizeCanvas(canvas, width, height);
            this.hooks.onFrame(this, video, width, height, now);
            this.effect.render(this._ctx, video, now); // draws the plain frame when idle
          }
        } catch (error) {
          console.warn('[Shinobi Meet] frame processing failed:', error);
          this.effect.stop();
        }
        schedule();
      };
      const schedule = () => {
        if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(draw);
        else setTimeout(draw, 33);
      };
      schedule();

      return canvas.captureStream(settings.frameRate || 30).getVideoTracks()[0];
    }

    // ------------------------------------------------------- track façade

    /**
     * Make the processed track behave like the camera track for the page:
     * Meet reads settings/capabilities (device id, resolution) and calls
     * applyConstraints() to adapt resolution — forward all of that to the
     * real camera. stop()/clone() are reference counted so the camera turns
     * off exactly when Meet has stopped every copy.
     */
    _decorate(track) {
      const original = this.original;
      const nativeStop = track.stop.bind(track);
      const nativeClone = track.clone.bind(track);
      this._liveOutputs.add(track);

      Object.defineProperties(track, {
        __shinobiNativeStop: { value: nativeStop },
        label: { get: () => original.label, configurable: true },
        getSettings: { value: () => original.getSettings(), configurable: true },
        getCapabilities: { value: () => original.getCapabilities(), configurable: true },
        getConstraints: { value: () => original.getConstraints(), configurable: true },
        applyConstraints: { value: (constraints) => original.applyConstraints(constraints), configurable: true },
        stop: {
          value: () => {
            nativeStop();
            if (this._liveOutputs.delete(track) && this._liveOutputs.size === 0) this._close();
          },
          configurable: true,
        },
        clone: { value: () => this._decorate(nativeClone()), configurable: true },
      });
      return track;
    }

    _close() {
      if (this.closed) return;
      this.closed = true;
      this.effect.stop();
      this.original.removeEventListener('ended', this._onOriginalEnded);
      try {
        this._abort.abort();
      } catch (_) {
        /* already torn down */
      }
      this.original.stop(); // releases the physical camera
      if (this._video) {
        this._video.srcObject = null;
        this._video = null;
      }
      this.hooks.onClosed(this);
    }
  }

  VideoPipeline.HAS_BREAKOUT_BOX = HAS_BREAKOUT_BOX;
  NS.VideoPipeline = VideoPipeline;
})(globalThis);
