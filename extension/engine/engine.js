/**
 * Detection engine — runs in a hidden extension-origin iframe inside the Meet tab.
 *
 * Why an iframe: MediaPipe needs to load a WASM runtime and a JS glue script.
 * Inside the Meet page that is blocked by Meet's CSP / Trusted Types; inside
 * an extension page it runs under the extension's own CSP.
 *
 * Protocol (over a MessagePort handed to us by the content script):
 *   in : { type: 'config', settings }
 *        { type: 'frame', id, bitmap, wantHands, wantMask }
 *   out: { type: 'ready', delegate } | { type: 'error', message }
 *        { type: 'result', id, hands, matched, progress, triggered, mask, colors }
 *
 * Frames arrive as small downscaled ImageBitmaps taken from the *existing*
 * camera stream by the video pipeline — the engine never opens the camera.
 * (VideoFrames cannot be posted across the process boundary between the Meet
 * page and this iframe; ImageBitmaps can.) All pixel readbacks happen here,
 * in the extension's process, so they never stall Meet's main thread.
 */
import { HandDetector, PersonSegmenter } from '../gesture/handDetection.js';
import { matchSign, GestureStabilizer, SENSITIVITY } from '../gesture/gestureRecognition.js';
import { getSign } from '../gesture/signs.js';

// The page embedding this iframe. Chrome only lets origins listed under
// web_accessible_resources.matches (i.e. Google Meet) embed it at all.
const PARENT_ORIGIN = location.ancestorOrigins?.[0] || 'https://meet.google.com';

const hands = new HandDetector();
const segmenter = new PersonSegmenter();
const stabilizer = new GestureStabilizer();

let port = null;
let handsReady = false;
let segmenterReady = false;
let sign = getSign('confrontation');
let tolerance = SENSITIVITY.medium.tolerance;
let lastTimestamp = 0;

// Tiny CPU canvas used to tell the effect what colour the body is per grid cell.
const THUMB_WIDTH = 96;
const thumbCanvas = new OffscreenCanvas(THUMB_WIDTH, 54);
const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });

function applySettings(settings) {
  const preset = SENSITIVITY[settings.sensitivity] || SENSITIVITY.medium;
  sign = getSign(settings.sign);
  tolerance = preset.tolerance;
  stabilizer.configure({
    holdMs: preset.holdMs,
    // 'timer' mode: never re-fire while the previous teleport is still playing.
    // 'gesture' mode: the same seal brings the user back, so only block for
    // the vanish animation; the stabilizer additionally requires the pose to
    // be released and made again, so holding it never vanishes-and-returns.
    cooldownMs: settings.returnMode === 'timer' ? (Number(settings.holdSeconds) || 2) * 1000 + 3500 : 1500,
  });
}

/** MediaPipe VIDEO mode requires strictly increasing timestamps. */
function nextTimestamp() {
  lastTimestamp = Math.max(lastTimestamp + 1, performance.now());
  return lastTimestamp;
}

function handleFrame(msg) {
  const reply = {
    type: 'result',
    id: msg.id,
    hands: 0,
    matched: false,
    progress: 0,
    triggered: false,
    mask: null,
    colors: null,
  };
  const transfer = [];
  const image = msg.bitmap;
  try {

    if (msg.wantHands && handsReady) {
      const detected = hands.detect(image, nextTimestamp());
      const matched = matchSign(sign, detected, { aspect: image.width / image.height, tolerance });
      const state = stabilizer.update(matched, performance.now());
      reply.hands = detected.length;
      reply.matched = matched;
      reply.progress = state.progress;
      reply.triggered = state.triggered;
    }

    if (msg.wantMask && segmenterReady) {
      const mask = segmenter.segment(image, nextTimestamp());
      if (mask) {
        reply.mask = { width: mask.width, height: mask.height, buffer: mask.alpha.buffer };
        transfer.push(mask.alpha.buffer);
      }

      // Downsampled frame colours, used to tint the disintegration particles.
      const thumbHeight = Math.max(2, Math.round((THUMB_WIDTH * image.height) / image.width));
      if (thumbCanvas.height !== thumbHeight) thumbCanvas.height = thumbHeight;
      thumbCtx.drawImage(image, 0, 0, THUMB_WIDTH, thumbHeight);
      const colors = thumbCtx.getImageData(0, 0, THUMB_WIDTH, thumbHeight).data;
      reply.colors = { width: THUMB_WIDTH, height: thumbHeight, buffer: colors.buffer };
      transfer.push(colors.buffer);
    }
  } catch (error) {
    console.error('[Shinobi Meet] detection failed:', error);
    reply.error = String(error?.message || error);
  } finally {
    image?.close?.();
  }
  port.postMessage(reply, transfer);
}

/**
 * MediaPipe builds its graph lazily: the first inference after init() takes
 * seconds, later ones tens of milliseconds. Run one throwaway inference on a
 * blank image so "ready" really means ready and the first real frame is fast.
 */
function blankImage() {
  const canvas = new OffscreenCanvas(64, 64);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#444';
  ctx.fillRect(0, 0, 64, 64);
  return canvas;
}

async function start() {
  try {
    await hands.init();
    hands.detect(blankImage(), nextTimestamp());
    handsReady = true;
    port.postMessage({ type: 'ready', delegate: hands.delegate });
  } catch (error) {
    console.error('[Shinobi Meet] hand detector failed to load:', error);
    port.postMessage({ type: 'error', message: `Hand detector failed to load: ${error?.message || error}` });
  }
  try {
    await segmenter.init();
    segmenter.segment(blankImage(), nextTimestamp());
    segmenterReady = true;
  } catch (error) {
    // Non-fatal: the effect falls back to an approximate body mask.
    console.error('[Shinobi Meet] segmenter failed to load:', error);
  }
}

function onPortMessage(event) {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === 'config') applySettings(msg.settings || {});
  else if (msg.type === 'frame') handleFrame(msg);
}

window.addEventListener('message', (event) => {
  if (event.origin !== PARENT_ORIGIN || port) return;
  if (event.data?.type !== 'shinobi-engine-port' || !event.ports[0]) return;
  port = event.ports[0];
  port.onmessage = onPortMessage;
  if (event.data.settings) applySettings(event.data.settings);
  start();
});

// Tell the content script we are listening; it answers with the MessagePort.
window.parent.postMessage({ type: 'shinobi-engine-hello' }, PARENT_ORIGIN);

// Release GPU/WASM resources when the iframe is removed.
window.addEventListener('pagehide', () => {
  hands.close();
  segmenter.close();
});
