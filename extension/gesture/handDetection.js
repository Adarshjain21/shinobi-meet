/**
 * MediaPipe wrappers: hand landmark detection and person segmentation.
 *
 * Runs inside the extension-origin engine iframe (engine/engine.html), never
 * in the Meet page itself — Meet's CSP and Trusted Types policy would block
 * MediaPipe's WASM loader there.
 */
import { FilesetResolver, HandLandmarker, ImageSegmenter } from '../vendor/mediapipe/vision_bundle.mjs';

const WASM_DIR = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const HAND_MODEL = new URL('../models/hand_landmarker.task', import.meta.url).href;
const SEGMENTER_MODEL = new URL('../models/selfie_segmenter.tflite', import.meta.url).href;

let filesetPromise = null;
function getFileset() {
  if (!filesetPromise) filesetPromise = FilesetResolver.forVisionTasks(WASM_DIR);
  return filesetPromise;
}

/** Try the preferred delegate first; fall back to the other one. */
async function createWithFallback(create, preferred = 'GPU') {
  const fallback = preferred === 'GPU' ? 'CPU' : 'GPU';
  try {
    return { task: await create(preferred), delegate: preferred };
  } catch (error) {
    console.warn(`[Shinobi Meet] ${preferred} delegate failed, falling back to ${fallback}:`, error);
    return { task: await create(fallback), delegate: fallback };
  }
}

export class HandDetector {
  constructor() {
    this._task = null;
    this.delegate = null;
  }

  async init() {
    const fileset = await getFileset();
    const { task, delegate } = await createWithFallback((d) =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate: d },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.5,
      })
    );
    this._task = task;
    this.delegate = delegate;
  }

  /**
   * @param image       ImageData (or any MediaPipe image source)
   * @param timestampMs strictly increasing timestamp
   * @returns array of { landmarks, worldLandmarks, handedness }
   */
  detect(image, timestampMs) {
    if (!this._task) return [];
    const result = this._task.detectForVideo(image, timestampMs);
    const hands = [];
    for (let i = 0; i < result.landmarks.length; i++) {
      hands.push({
        landmarks: result.landmarks[i],
        worldLandmarks: result.worldLandmarks[i],
        handedness: result.handednesses?.[i]?.[0]?.categoryName ?? 'Unknown',
      });
    }
    return hands;
  }

  close() {
    this._task?.close();
    this._task = null;
  }
}

export class PersonSegmenter {
  constructor() {
    this._task = null;
    this.delegate = null;
  }

  async init() {
    const fileset = await getFileset();
    // CPU on purpose. The segmenter runs many times per second exactly while
    // the teleport effect is rendering; on the GPU delegate its inference and
    // mask readbacks compete with the effect for the GPU and were measured to
    // cut the outgoing video from ~18 to ~7 fps. The model is tiny (256×256),
    // so WASM/CPU inference is cheap and leaves the GPU to the video.
    const { task, delegate } = await createWithFallback(
      (d) =>
        ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: SEGMENTER_MODEL, delegate: d },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        }),
      'CPU'
    );
    this._task = task;
    this.delegate = delegate;
  }

  /**
   * @returns { width, height, alpha: Uint8Array } person-probability mask
   *          (255 = person), or null.
   */
  segment(image, timestampMs) {
    if (!this._task) return null;
    const result = this._task.segmentForVideo(image, timestampMs);
    try {
      const masks = result.confidenceMasks;
      if (!masks || masks.length === 0) return null;
      // selfie_segmenter outputs one mask (person). Multi-class models output
      // background first, so the last mask is the safest "person" choice here.
      const mask = masks[masks.length - 1];
      const confidence = mask.getAsFloat32Array();
      const alpha = new Uint8Array(confidence.length);
      for (let i = 0; i < confidence.length; i++) alpha[i] = confidence[i] * 255;
      return { width: mask.width, height: mask.height, alpha };
    } finally {
      result.close();
    }
  }

  close() {
    this._task?.close();
    this._task = null;
  }
}
