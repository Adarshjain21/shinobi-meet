# Shinobi Meet - Teleportation Jutsu for Google Meet

Make a ninja hand seal at your webcam during a Google Meet call and vanish in a burst of blue chakra - then reappear when you make the seal again. **Everyone in the call sees it**, your camera never turns off, and you never leave the meeting.

- Chrome extension only. **No companion app, no OBS, no virtual camera to install or select.**
- Everything runs locally in your browser. No video, image or landmark data leaves your machine; the extension makes no network requests.

---

## Quick start

1. Open `chrome://extensions`, switch on **Developer mode** (top right).
2. Click **Load unpacked** and choose the `extension/` folder of this project.
3. Open (or **reload**) `https://meet.google.com` and join a call with your camera on.
   Keep your normal webcam selected - there is nothing to change in Meet's settings.
4. Click the extension icon. When it shows **Camera processing: Active** and **Gesture detection: Watching for the seal**, you're ready.
5. Hold the seal (default: index + middle fingers together, pointing up, other fingers folded) steadily in view for about half a second - or press **Test teleportation in Meet** in the popup.

> A Meet tab that was already open before you installed or reloaded the extension must be reloaded once. If your camera was already on when you enabled the extension, toggle the camera off and on once.

---

## How it works (and why no companion app is needed)

The hard requirement is that **remote participants** see the effect. That rules out drawing an overlay on the page: an overlay is only visible on your own screen. The effect has to be inside the video track that Meet sends.

```
 physical webcam ──getUserMedia──▶ [ MAIN-world hook: inject.js ]
                                          │ original camera track (kept alive, never stopped)
                                          ▼
                    MediaStreamTrackProcessor → TransformStream → MediaStreamTrackGenerator
                                          │            ▲                    │
                 small ImageBitmaps ◀─────┘            │                    ▼
                          │                 composites effect     processed track ──▶ Google Meet
                          ▼                 on OffscreenCanvas                        │ (its own WebRTC)
      [ hidden extension iframe: engine/ ]             │                              ▼
        MediaPipe Hand Landmarker  ── "seal held" ─────┤                     every participant
        MediaPipe Selfie Segmenter ── person mask ─────┘
```

1. **`inject.js` runs in the page's MAIN world at `document_start`** and wraps `navigator.mediaDevices.getUserMedia`. When Meet asks for the camera it gets a stream whose video track is ours. Meet then sends that track through its own `RTCPeerConnection`, so the effect is in the pixels everyone receives.
2. **The video path uses WebRTC Insertable Streams.** While nothing is happening, frames are forwarded *untouched* (zero copy - no quality loss and essentially no CPU). Only while the jutsu plays is each frame composited on an `OffscreenCanvas` and re-wrapped as a new `VideoFrame`. Because frames are pulled by the camera and not by `requestAnimationFrame`, it keeps working when the Meet tab is in the background.
3. **Detection runs in a hidden extension-origin iframe.** MediaPipe needs to load WASM and a JS loader, which Meet's CSP / Trusted Types would block inside the page. The iframe runs under the extension's own CSP and in a separate process. It receives small downscaled frames taken from the *existing* camera stream - a second camera stream is never opened.
4. **The "empty room"** shown while you are invisible is a background plate learned continuously from the pixels the segmenter marks as not-you. Areas you have never uncovered are inpainted from their surroundings.

### Approaches evaluated

| Approach | Verdict |
|---|---|
| Isolated-world content script + DOM overlay | ❌ Local-only. Remote participants see nothing. |
| Isolated-world content script patching `getUserMedia` | ❌ Content scripts have their own JS global; Meet never sees the patch. |
| **MAIN-world script wrapping `getUserMedia` + Insertable Streams** | ✅ **Chosen.** Meet itself sends the processed track. No install beyond the extension. |
| `RTCRtpSender.replaceTrack` on Meet's peer connection | ⚠️ Works, but requires hooking `RTCPeerConnection` and guessing which sender is the camera; breaks Meet's own preview/effects. Wrapping at the source is simpler and sturdier. |
| Offscreen document / service worker in the video path | ❌ A service worker has no DOM/camera and is suspended when idle; an offscreen document can process video but cannot hand a `MediaStreamTrack` to the Meet page (tracks and `VideoFrame`s cannot cross that process boundary - verified, see below). |
| Companion desktop app with a virtual camera driver | ⚠️ Works with any app, but needs a native driver install (signed on Windows/macOS) and a second program running. Unnecessary for Meet-in-Chrome. |
| OBS Virtual Camera | ⚠️ Same trade-off: heavy install and manual scene setup for something the browser can do itself. |

**Limitation of the chosen approach:** it only affects Google Meet in Chrome (and Chromium browsers that support MV3 `world: "MAIN"`, Chrome 111+). It does not create a system-wide camera for Zoom/Teams desktop apps - that would need the virtual-camera route.

---

## Popup

- **Enable / disable** toggle.
- **Status**: Meet tab connection, camera processing, gesture detection (with a live hold-progress bar), companion app (not needed).
- **Hand seal** selector, **gesture sensitivity**.
- **Reappear**: *When I make the seal again* (default) - you stay invisible until you release your hand and make the seal a second time (or press **Bring me back** in the popup; there is a 10-minute safety limit). *Automatically after a set time* - reappear after 0.5–10 s.
- **Preview**: plays the real effect code on a drawn scene inside the popup.
- **Test teleportation in Meet**: fires the jutsu in the call without a gesture.

The toolbar icon shows an `ON` badge on tabs whose camera stream is being processed.

### Hand seals

| Seal | How |
|---|---|
| **Seal of Confrontation** (default) | One hand. Index + middle fingers straight and touching, pointing up. Ring and pinky folded. |
| **Clone Seal** | Both hands make the same two-finger shape and cross in a “+” (one upright, one sideways). |

The one-hand seal is the default because a single unoccluded hand is what hand tracking follows most reliably. Recognition uses joint angles (total bend per finger from 3D landmarks), finger adjacency and pointing direction - not mere hand presence. The seal must be held (`low` 0.9 s / `medium` 0.55 s / `high` 0.3 s), short tracking dropouts are tolerated, and after firing it will not fire again until the animation is over **and** you have released the pose.

### Adding a new seal

Seals are data. Add an entry to `extension/gesture/signs.js` (or call `registerSign()`); it appears in the popup automatically:

```js
thumbsUp: {
  id: 'thumbsUp',
  label: 'Thumbs up',
  description: 'Thumb up, all other fingers folded.',
  hands: [{
    fingers: { thumb: 'extended', index: 'curled', middle: 'curled', ring: 'curled', pinky: 'curled' },
    pointing: { fingers: ['thumb'], toward: 'up', maxDeg: 35 },
  }],
},
```

Per-hand options: `fingers` (`'extended'` / `'curled'`), `together` (finger pairs that must touch), `pointing` (`up` / `down` / `left` / `right` / `sideways`). Two-hand seals add `relation` (`maxDistance` in hand sizes, `fingerAngleDeg` range).

---

## The animation

| Phase | Duration | What happens |
|---|---|---|
| Activation | 0.45 s | Ignition flash, blue aura in the shape of your body, energy particles spiral inward, lightning arcs. |
| Dissolve | 0.75 s | The body breaks apart cell by cell (feet first). Each vanishing cell ejects a fragment carrying the body's colour that swirls upward; a warp ripples through the picture; flash + shockwave. |
| Invisible | **until you make the seal again** (or a set time, 2 s default) | Output is the empty-room plate with a fading afterglow and a few drifting sparks. The real camera keeps running underneath. |
| Reappear | 0.75 s | Particles converge on your silhouette (tracking your *current* pose) and each cell snaps back to live video as they land; flash + shockwave. |
| Settle | 0.3 s | Aura fades; frames are passed through untouched again. |

---

## Project structure

```
extension/
  manifest.json
  inject.js                 MAIN world: wraps getUserMedia
  content.js                isolated world: settings bridge, popup messages, hosts the engine iframe
  background.js             service worker: default settings, per-tab badge
  popup.html / .css / .js
  shared/settings.js        defaults + validation (popup, content script, worker)
  video/
    streamManager.js        orchestration: detection scheduling, trigger, engine link, status
    videoProcessor.js       one camera track → one processed track (insertable streams; canvas fallback)
    backgroundPlate.js      learned "room without you" + inpainting
    canvasUtil.js           namespace + helpers
  effects/
    teleportation.js        the timeline; per-cell dissolve / re-assembly
    particles.js            pooled particle system
    energyEffects.js        aura, flash, shockwave, warp, lightning, vignette
  engine/
    engine.html / engine.js detection iframe (MediaPipe host)
  gesture/
    handDetection.js        MediaPipe Hand Landmarker + Selfie Segmenter wrappers
    gestureRecognition.js   pure geometry: sign matching + hold/cooldown stabilizer
    signs.js                seal definitions (data)
  vendor/mediapipe/         @mediapipe/tasks-vision 0.10.21 (Apache-2.0), bundled - MV3 forbids remote code
  models/                   hand_landmarker.task, selfie_segmenter.tflite
  assets/                   icons
tests/
  gesture.test.mjs          unit tests (Node, no dependencies)
  e2e/pipeline.e2e.mjs      real-browser end-to-end test
tools/make-icons.mjs        regenerates the icons
```

Gesture recognition, animation and camera processing are independent: `gesture/` knows nothing about video, `effects/` only draws, `video/` owns streams.

---

## Testing

```bash
npm test                                  # gesture unit tests - no dependencies

npm install --no-save puppeteer           # once, for the browser test
node tests/e2e/pipeline.e2e.mjs --headful # add --images <dir> to run real photos through the models
```

### What has been verified

The end-to-end test loads the **shipped extension** into a real Chrome with a fake camera device and reproduces what Meet does (`getUserMedia` → `RTCPeerConnection.addTrack` → a second peer renders the video). Last run: **30/30 checks passed**, including:

- The page receives the processed track, and it reports the real camera's label / settings / device id.
- **The remote WebRTC peer sees the effect**, and during the invisible phase it sees the frozen background plate, not live video; live video returns afterwards; the camera track stays live throughout.
- The effect ends by itself after ≈ 4.25 s at the default 2 s invisibility.
- MediaPipe loads and runs inside the extension iframe.
- No false trigger on a scene without hands. Real photos of a peace sign, a pointing finger, a fist and a thumbs-up are detected as hands but **not** mistaken for the seal, even at high sensitivity. A real portrait is segmented correctly.
- Stopping the track releases the camera only when the last clone is stopped; when disabled the page gets the raw, untouched camera track.
- Unit tests (18): seal recognised incl. slight bend/tilt; open palm, fist, single finger, spread V, three fingers, sideways/upside-down seal rejected; two-hand seal; hold time, dropout tolerance, cooldown and release-to-rearm.

Measured on a laptop with Intel Iris Xe graphics at 1280×720: idle overhead ≈ 0 ms per frame (pass-through); during the effect, compositing takes ≈ 2 ms of main-thread time per frame (p95 ≈ 6–8 ms) and the outgoing video stays at the camera's frame rate with no stalls, including on the first teleport of a session.

### What has NOT been verified

Be aware of these before relying on it in an important meeting:

- **A live Google Meet call.** Meet cannot be automated without a signed-in Google account, so the test uses a local page that makes the same API calls. The mechanism (wrapping `getUserMedia` in the MAIN world) is the standard way camera-effect extensions work with Meet, but this build has not yet been run in a real call.
- **Recognition of the seal on a real hand.** Rejection of other gestures was tested on real photos; *acceptance* of the seal was tested only on synthetic landmarks (no photo of the seal was available). Thresholds were calibrated from real MediaPipe output, but you may need to change the sensitivity.
- A physical webcam (the test uses Chrome's fake device), and frame rates above the fake device's 20–30 fps.

Please do a quick solo test call (meet.google.com → *New meeting* → *Start an instant meeting*), ideally joining from a second device to see the remote view.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup says **Reload required** | The Meet tab predates the extension install/update. Reload the tab. |
| **Waiting for camera** although the camera is on | The camera was started before the extension attached. Toggle the camera off/on in Meet or reload the tab. |
| Seal is not recognised | Watch the popup: “1 hand in view” means tracking works but the pose doesn't match. Keep the two fingers touching and pointing up, fold ring + pinky fully, palm side or back toward the camera, hand not too close. Try **High** sensitivity. |
| Triggers by accident | Use **Low** sensitivity, or switch to the two-hand Clone Seal. |
| The “empty room” has a soft blurry patch where you were | The plate can only show background it has seen. It learns continuously - lean out of frame once and it fills in for real. |
| Gesture detection **Unavailable** | MediaPipe failed to start (see the tab's console). The test button still works, using a generic silhouette. |
| Meet's own background blur/effects | Meet applies them to whatever camera track it receives, so they should stack on top of the jutsu - not tested yet. |

## Notes

- Uses `MediaStreamTrackProcessor` / `MediaStreamTrackGenerator` (available in Chrome on the main thread). If a browser lacks them, the pipeline falls back to `<video>` → canvas → `captureStream()`; that mode needs the Meet tab to stay visible while teleporting, and the popup says so.
- Multiple Meet tabs are independent: each has its own pipeline and loads the detection engine only while its camera is on; the engine is unloaded (MediaPipe/WebGL resources released) 15 s after the camera stops or immediately when disabled.
- Meet's internal DOM and class names are never touched.
