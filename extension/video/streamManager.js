/**
 * StreamManager — one per Meet page. Coordinates everything in the MAIN world:
 *
 *   - wraps camera streams returned by getUserMedia in VideoPipelines
 *   - samples small frames from the existing camera stream and sends them to
 *     the detection engine (hands + person mask) — no second camera stream
 *   - maintains the background plate
 *   - starts the teleport effect on a gesture trigger or the popup's test button
 *   - reports status to the content script (→ popup)
 *
 * Talks to the isolated-world content script with window.postMessage, and to
 * the engine iframe over a MessagePort the content script hands over.
 */
(function (root) {
  'use strict';
  const NS = (root.__shinobiMeet = root.__shinobiMeet || {});
  const { makeCanvas, resizeCanvas } = NS.util;

  const TAG = '__shinobiMeet';
  const ENABLED_CACHE_KEY = 'shinobiMeet.enabled';

  const DETECT_WIDTH = 480; // detection frame width (height follows aspect)
  const DETECT_INTERVAL_MS = 70; // ≈14 detections/s — plenty for a held pose
  const IDLE_MASK_INTERVAL_MS = 1000; // background-plate refresh rate
  const EFFECT_MASK_INTERVAL_MS = 120; // person-mask refresh while the jutsu plays
  const PLATE_MAX_WIDTH = 1280;
  const ARM_TIMEOUT_MS = 400; // max wait for a fresh mask before the effect starts
  const ENGINE_REPLY_TIMEOUT_MS = 2500;
  const ENGINE_RELEASE_DELAY_MS = 15000;
  const STATUS_INTERVAL_MS = 300;

  class StreamManager {
    constructor() {
      this.settings = { enabled: readEnabledCache(), holdSeconds: 2, sensitivity: 'medium', sign: 'confrontation' };
      this.pipelines = new Set();
      this._primary = null;

      this._port = null;
      this._engineState = 'off'; // off | loading | ready | error
      this._engineMessage = '';
      this._engineRequested = false;
      this._releaseTimer = null;
      this._awaitingSince = 0;
      this._frameId = 0;
      this._lastSendAt = 0;
      this._lastMaskAt = 0;

      this._plateSource = makeCanvas(2, 2);
      this._plateSourceCtx = this._plateSource.getContext('2d');
      this._plateSourcePending = false;
      this._plate = new NS.BackgroundPlate();
      this._mask = makeCanvas(2, 2);
      this._maskCtx = this._mask.getContext('2d');
      this._maskAlpha = null; // { data, width, height } — same mask as plain bytes
      this._bodyColors = null; // { data, width, height } — downsampled frame colours

      this._arming = false;
      this._armDeadline = 0;
      this._gesture = { hands: 0, matched: false, progress: 0 };
      this._lastTriggerAt = 0;
      this._lastStatusAt = 0;
      this._warmedUp = false;

      window.addEventListener('message', (event) => this._onWindowMessage(event));
      this._toContent({ type: 'hello' });
    }

    // ------------------------------------------------------------ streams

    /** Replace the video tracks of a getUserMedia stream with processed ones. */
    wrapStream(stream) {
      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length === 0) return stream;

      const wrapped = new MediaStream(stream.getAudioTracks());
      for (const track of videoTracks) {
        const pipeline = new NS.VideoPipeline(track, {
          onFrame: (p, source, width, height, now) => this._onFrame(p, source, width, height, now),
          onClosed: (p) => this._onPipelineClosed(p),
        });
        this.pipelines.add(pipeline);
        wrapped.addTrack(pipeline.track);
      }
      this._syncEngine();
      this._postStatus(true);
      return wrapped;
    }

    _onPipelineClosed(pipeline) {
      this.pipelines.delete(pipeline);
      if (this._primary === pipeline) this._primary = null;
      this._syncEngine();
      this._postStatus(true);
    }

    get _effectActive() {
      for (const p of this.pipelines) if (p.effect.active) return true;
      return false;
    }

    // --------------------------------------------------------- per frame

    _onFrame(pipeline, source, width, height, now) {
      if (now - this._lastStatusAt > STATUS_INTERVAL_MS) this._postStatus();
      if (!this.settings.enabled) return;

      // Meet often holds several streams of the same camera (preview, call,
      // clones). Only one of them feeds detection.
      if (!this._primary || this._primary.closed || now - this._primary.lastFrameAt > 1000) this._primary = pipeline;
      if (pipeline !== this._primary) return;

      if (!this._warmedUp) {
        this._warmedUp = true;
        this._warmUp(source, width, height);
      }

      if (this._arming && now > this._armDeadline) this._fire(now);

      if (!this._port || this._engineState !== 'ready') return;
      if (this._awaitingSince) {
        if (now - this._awaitingSince < ENGINE_REPLY_TIMEOUT_MS) return; // engine busy
        this._awaitingSince = 0; // engine stalled; try again
      }

      const effectActive = this._effectActive;
      const wantHands = !effectActive && !this._arming;
      // Masks: constantly while the jutsu plays (they drive the particles),
      // immediately when arming, otherwise ~1/s to keep the plate fresh.
      const wantMask = effectActive || this._arming || now - this._lastMaskAt > IDLE_MASK_INTERVAL_MS;
      const interval = effectActive ? EFFECT_MASK_INTERVAL_MS : DETECT_INTERVAL_MS;
      if (!this._arming && now - this._lastSendAt < interval) return;

      this._sendFrame(source, width, height, now, wantHands, wantMask, effectActive);
    }

    /**
     * One-time hidden dry run of the whole effect, shortly after the camera
     * starts. The first time each kind of draw call reaches the GPU the
     * browser has to compile shaders for it; measured without this, the first
     * teleport of a session stalled the outgoing video for over a second,
     * while later ones ran at full frame rate. The dry run renders to a
     * throwaway canvas while the real video keeps passing through untouched.
     */
    _warmUp(source, width, height) {
      let still;
      let canvas;
      let ctx;
      const effect = new NS.TeleportEffect();
      const HOLD_MS = 300;
      const STEP_MS = 120;
      const total = NS.TeleportEffect.totalMs(HOLD_MS);
      try {
        still = makeCanvas(width, height);
        still.getContext('2d').drawImage(source, 0, 0, width, height);
        canvas = makeCanvas(width, height);
        ctx = canvas.getContext('2d', { alpha: false });
        // Varied colours, like a real body: uniformly coloured fragments would
        // be batched differently and leave a shader variant uncompiled.
        const colors = { data: new Uint8ClampedArray(16 * 9 * 4), width: 16, height: 9 };
        for (let i = 0; i < colors.data.length; i++) colors.data[i] = (i * 37) % 256;
        // Build the plate the same way a real teleport does (cut-out + inpaint
        // pyramid), so those draw calls are warmed up as well.
        const cutout = makeCanvas(64, 36);
        const cutoutCtx = cutout.getContext('2d');
        cutoutCtx.beginPath();
        cutoutCtx.ellipse(32, 22, 12, 14, 0, 0, Math.PI * 2);
        cutoutCtx.fill();
        const warmPlate = new NS.BackgroundPlate();
        warmPlate.update(still, cutout);
        effect.start({ now: 0, holdMs: HOLD_MS, plate: warmPlate.snapshot() || still, mask: null, colors });
      } catch (_) {
        return; // warm-up is best effort
      }

      let fakeTime = 0;
      const step = () => {
        if (fakeTime >= total) {
          effect.stop();
          return;
        }
        try {
          effect.render(ctx, still, fakeTime);
          // Canvas drawing is deferred; turning the canvas into a bitmap makes
          // the GPU actually execute (and compile shaders for) what was drawn.
          createImageBitmap(canvas).then(
            (bitmap) => bitmap.close(),
            () => {}
          );
        } catch (_) {
          return;
        }
        fakeTime += STEP_MS;
        setTimeout(step, 60); // spread out so it never competes with the call
      };
      setTimeout(step, 400);
    }

    _sendFrame(source, width, height, now, wantHands, wantMask, effectActive) {
      const detectHeight = Math.max(2, Math.round((DETECT_WIDTH * height) / width));

      // Keep the exact frame the mask will describe, to update the plate with
      // it when the mask comes back (mask and pixels must match).
      this._plateSourcePending = false;
      if (wantMask && !effectActive) {
        const scale = Math.min(1, PLATE_MAX_WIDTH / width);
        resizeCanvas(this._plateSource, width * scale, height * scale);
        this._plateSourceCtx.drawImage(source, 0, 0, this._plateSource.width, this._plateSource.height);
        this._plateSourcePending = true;
      }

      this._awaitingSince = now;
      this._lastSendAt = now;
      if (wantMask) this._lastMaskAt = now;
      const id = ++this._frameId;

      // Downscale asynchronously into an ImageBitmap and transfer it to the
      // engine. Deliberately NO getImageData here: a synchronous GPU readback
      // on Meet's main thread can stall the video for hundreds of ms while the
      // GPU is busy. The frame must stay alive until the bitmap is ready, so
      // work on a clone (the pipeline closes/forwards the original).
      const isVideoFrame = typeof VideoFrame !== 'undefined' && source instanceof VideoFrame;
      const input = isVideoFrame ? source.clone() : source;
      createImageBitmap(input, { resizeWidth: DETECT_WIDTH, resizeHeight: detectHeight, resizeQuality: 'low' })
        .then((bitmap) => {
          if (!this._port) {
            bitmap.close();
            return;
          }
          this._port.postMessage({ type: 'frame', id, bitmap, wantHands, wantMask }, [bitmap]);
        })
        .catch(() => {
          this._awaitingSince = 0; // frame could not be sampled; try the next one
        })
        .finally(() => {
          if (isVideoFrame) input.close();
        });
    }

    // ------------------------------------------------------------ engine

    _onEngineMessage(msg) {
      if (!msg) return;
      if (msg.type === 'ready') {
        this._engineState = 'ready';
        this._engineMessage = `MediaPipe (${msg.delegate})`;
        this._postStatus(true);
      } else if (msg.type === 'error') {
        this._engineState = 'error';
        this._engineMessage = msg.message;
        this._postStatus(true);
      } else if (msg.type === 'result') {
        this._onDetection(msg);
      }
    }

    _onDetection(result) {
      this._awaitingSince = 0;
      const now = performance.now();
      const effectActive = this._effectActive;

      if (!effectActive && !this._arming) {
        this._gesture = { hands: result.hands, matched: result.matched, progress: result.progress };
      }

      if (result.mask) {
        const { width, height, buffer } = result.mask;
        const alpha = new Uint8Array(buffer);
        const image = new ImageData(width, height);
        for (let i = 0; i < alpha.length; i++) {
          // Steepen the segmenter's confidence into a firm mask: below ~38 %
          // → background, above ~70 % → person. Without this, low-confidence
          // haze over the background accumulates when the mask is dilated and
          // punches holes into the background plate.
          const a = (alpha[i] - 96) * 3;
          const firm = a < 0 ? 0 : a > 255 ? 255 : a;
          alpha[i] = firm;
          image.data[i * 4] = 255;
          image.data[i * 4 + 1] = 255;
          image.data[i * 4 + 2] = 255;
          image.data[i * 4 + 3] = firm;
        }
        resizeCanvas(this._mask, width, height);
        this._maskCtx.putImageData(image, 0, 0);
        this._maskAlpha = { data: alpha, width, height };
        if (result.colors) {
          this._bodyColors = {
            data: new Uint8ClampedArray(result.colors.buffer),
            width: result.colors.width,
            height: result.colors.height,
          };
        }

        if (effectActive) {
          for (const p of this.pipelines) {
            if (p.effect.active) p.effect.maskUpdated(this._mask, this._maskAlpha, this._bodyColors);
          }
        } else if (this._plateSourcePending) {
          this._plate.update(this._plateSource, this._mask);
        }
        this._plateSourcePending = false;

        if (this._arming) this._fire(now);
      }

      if (result.triggered && !effectActive && !this._arming) this.trigger();
    }

    /**
     * Start the jutsu. With the engine available we first "arm": grab one
     * fresh person mask (and refresh the plate with it) so the effect starts
     * from the user's current pose. Otherwise it starts immediately.
     * @returns false if there is no live camera stream to affect
     */
    trigger() {
      if (!this.settings.enabled || this.pipelines.size === 0) return false;
      if (this._effectActive || this._arming) return true;
      const now = performance.now();
      if (this._port && this._engineState === 'ready') {
        this._arming = true;
        this._armDeadline = now + ARM_TIMEOUT_MS;
      } else {
        this._fire(now);
      }
      return true;
    }

    _fire(now) {
      this._arming = false;
      this._lastTriggerAt = Date.now();
      this._gesture = { hands: 0, matched: false, progress: 0 };
      const plate = this._plate.snapshot();
      for (const pipeline of this.pipelines) {
        pipeline.effect.start({
          now,
          holdMs: this.settings.holdSeconds * 1000,
          plate,
          mask: this._maskAlpha ? this._mask : null,
          maskAlpha: this._maskAlpha,
          colors: this._bodyColors,
        });
      }
      this._postStatus(true);
    }

    /** Load the engine only while it is needed; release it when it is not. */
    _syncEngine() {
      const needed = this.settings.enabled && this.pipelines.size > 0;
      if (needed) {
        clearTimeout(this._releaseTimer);
        this._releaseTimer = null;
        if (!this._engineRequested) {
          this._engineRequested = true;
          this._engineState = 'loading';
          this._engineMessage = '';
          this._toContent({ type: 'need-engine' });
        }
      } else if (this._engineRequested && !this._releaseTimer) {
        // Small delay: Meet tears streams down and re-creates them when
        // joining a call or switching cameras.
        const delay = this.settings.enabled ? ENGINE_RELEASE_DELAY_MS : 0;
        this._releaseTimer = setTimeout(() => this._releaseEngine(), delay);
      }
    }

    _releaseEngine() {
      this._releaseTimer = null;
      this._engineRequested = false;
      this._engineState = 'off';
      this._awaitingSince = 0;
      this._gesture = { hands: 0, matched: false, progress: 0 };
      if (this._port) {
        this._port.close();
        this._port = null;
      }
      this._toContent({ type: 'release-engine' }); // content script removes the iframe → MediaPipe freed
      this._postStatus(true);
    }

    _sendEngineConfig() {
      if (this._port) this._port.postMessage({ type: 'config', settings: this.settings });
    }

    // --------------------------------------------- content-script bridge

    _toContent(message) {
      window.postMessage({ [TAG]: 'to-content', ...message }, window.location.origin);
    }

    _onWindowMessage(event) {
      if (event.source !== window || !event.data || event.data[TAG] !== 'to-page') return;
      const msg = event.data;

      if (msg.type === 'settings') {
        this.settings = { ...this.settings, ...msg.settings };
        if (!this.settings.enabled) {
          this._arming = false;
          for (const p of this.pipelines) p.effect.stop();
        }
        this._sendEngineConfig();
        this._syncEngine();
        this._postStatus(true);
      } else if (msg.type === 'engine-port' && event.ports[0]) {
        if (this._port) this._port.close();
        this._port = event.ports[0];
        this._port.onmessage = (e) => this._onEngineMessage(e.data);
        this._awaitingSince = 0;
        this._sendEngineConfig();
      } else if (msg.type === 'engine-failed') {
        this._engineState = 'error';
        this._engineMessage = msg.message || 'Detection engine failed to start';
        this._postStatus(true);
      } else if (msg.type === 'test-trigger') {
        const started = this.trigger();
        this._toContent({ type: 'test-result', started });
      } else if (msg.type === 'get-status') {
        this._postStatus(true);
      }
    }

    _postStatus(force = false) {
      const now = performance.now();
      if (!force && now - this._lastStatusAt < STATUS_INTERVAL_MS) return;
      this._lastStatusAt = now;
      // A stream counts as live only if frames are actually flowing.
      let live = 0;
      for (const p of this.pipelines) if (now - p.lastFrameAt < 2000) live++;
      const any = this.pipelines.values().next().value;
      this._toContent({
        type: 'status',
        status: {
          enabled: this.settings.enabled,
          streams: this.pipelines.size,
          liveStreams: live,
          mode: any ? any.mode : NS.VideoPipeline.HAS_BREAKOUT_BOX ? 'insertable-streams' : 'canvas-capture',
          engine: this._engineState,
          engineMessage: this._engineMessage,
          gesture: this._gesture,
          effectActive: this._effectActive || this._arming,
          lastTriggerAt: this._lastTriggerAt,
        },
      });
    }
  }

  function readEnabledCache() {
    try {
      return localStorage.getItem(ENABLED_CACHE_KEY) !== '0';
    } catch (_) {
      return true;
    }
  }

  NS.StreamManager = StreamManager;
})(globalThis);
