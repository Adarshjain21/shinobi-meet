/**
 * MAIN-world entry point (runs at document_start, before Meet's own code).
 *
 * Wraps navigator.mediaDevices.getUserMedia so that whenever Meet asks for the
 * camera it receives a stream whose video track passes through our pipeline.
 * Meet then sends that track over its own WebRTC connection — which is what
 * makes the effect visible to every participant, not just locally.
 *
 * An isolated-world content script cannot do this: it has a separate JS
 * global, so patching getUserMedia there would not affect Meet. That is why
 * this file is declared with "world": "MAIN" in the manifest.
 */
(function () {
  'use strict';
  const NS = globalThis.__shinobiMeet;
  if (!NS || NS.installed) return;
  NS.installed = true;

  if (!navigator.mediaDevices || typeof MediaDevices === 'undefined') return;

  const manager = (NS.manager = new NS.StreamManager());
  const nativeGetUserMedia = MediaDevices.prototype.getUserMedia;

  MediaDevices.prototype.getUserMedia = async function getUserMedia(constraints) {
    // Camera permission errors etc. propagate to Meet unchanged.
    const stream = await nativeGetUserMedia.call(this, constraints);
    try {
      // When disabled at request time the stream is handed over untouched,
      // so a disabled extension has zero footprint on the call.
      if (constraints && constraints.video && manager.settings.enabled) {
        return manager.wrapStream(stream);
      }
    } catch (error) {
      console.warn('[Shinobi Meet] could not attach to the camera stream; using it unmodified.', error);
    }
    return stream;
  };
})();
