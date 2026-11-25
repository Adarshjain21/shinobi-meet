/**
 * Gesture recognition — pure geometry, no DOM, no MediaPipe dependency.
 *
 * Input:  hand landmarks in MediaPipe's 21-point layout.
 * Output: whether a configured sign (gesture/signs.js) is being shown, and a
 *         stabilizer that turns "sign is visible" into a single debounced
 *         trigger (hold time + dropout grace + cooldown + release-to-rearm).
 *
 * Kept separate from camera and animation code so it can be unit-tested in
 * Node (see tests/gesture.test.mjs).
 */

// MediaPipe hand landmark indices: [mcp, pip, dip, tip] per finger.
export const FINGER_JOINTS = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};
const WRIST = 0;

/**
 * Sensitivity presets.
 *   tolerance — multiplier on every angular / distance threshold (>1 = looser).
 *   holdMs    — how long the sign must be held before it fires.
 */
export const SENSITIVITY = {
  low: { tolerance: 0.8, holdMs: 900 },
  medium: { tolerance: 1.0, holdMs: 550 },
  high: { tolerance: 1.25, holdMs: 300 },
};

// Base thresholds (at tolerance 1.0).
const EXTENDED_MAX_FLEXION_DEG = 70; // total bend over MCP+PIP+DIP for a "straight" finger
const CURLED_MIN_FLEXION_DEG = 115; // total bend for a "folded" finger
// "Together" thresholds are calibrated against real MediaPipe output: touching
// index+middle fingertips are ~0.2 hand sizes apart, while even a narrow
// "peace" V measures ~0.42 (11° between the fingers). The gap is the reliable
// discriminator, so it only loosens with the square root of the tolerance.
const TOGETHER_MAX_ANGLE_DEG = 14; // angle between two adjacent fingers
const TOGETHER_MAX_TIP_GAP = 0.33; // fingertip gap, in hand sizes

const RAD2DEG = 180 / Math.PI;

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
}
function length(v) {
  return Math.hypot(v.x, v.y, v.z || 0);
}
function angleBetweenDeg(a, b) {
  const la = length(a);
  const lb = length(b);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const cos = (a.x * b.x + a.y * b.y + (a.z || 0) * (b.z || 0)) / (la * lb);
  return Math.acos(Math.min(1, Math.max(-1, cos))) * RAD2DEG;
}

/**
 * Total flexion of a finger in degrees: the sum of the bend at the MCP, PIP
 * and DIP joints. ~0-50° for a straight finger, 180°+ for a fully folded one.
 * Summing three joints is far more robust than testing a single joint or
 * comparing tip/knuckle heights, and it is independent of hand rotation.
 */
function fingerFlexionDeg(points, joints) {
  const [mcp, pip, dip, tip] = joints.map((i) => points[i]);
  const wrist = points[WRIST];
  const palmBone = sub(mcp, wrist);
  const proximal = sub(pip, mcp);
  const middle = sub(dip, pip);
  const distal = sub(tip, dip);
  return (
    angleBetweenDeg(palmBone, proximal) + angleBetweenDeg(proximal, middle) + angleBetweenDeg(middle, distal)
  );
}

/**
 * Reduce a raw hand to the features the sign matcher needs.
 *
 * @param hand   { landmarks: [{x,y,z}]×21 (normalised image coords),
 *                 worldLandmarks?: [{x,y,z}]×21 (metres, hand-centred) }
 * @param aspect image width / height — normalised x and y have different
 *               scales, so 2D directions must be aspect-corrected.
 */
export function describeHand(hand, aspect = 16 / 9) {
  const image = hand.landmarks.map((p) => ({ x: p.x * aspect, y: p.y, z: 0 }));
  // World landmarks are true 3D and undistorted; prefer them for joint angles.
  const metric = hand.worldLandmarks && hand.worldLandmarks.length === 21 ? hand.worldLandmarks : image;

  const fingers = {};
  for (const [name, joints] of Object.entries(FINGER_JOINTS)) {
    const dir2 = sub(image[joints[3]], image[joints[0]]);
    const len2 = length(dir2) || 1;
    fingers[name] = {
      flexionDeg: fingerFlexionDeg(metric, joints),
      direction3d: sub(metric[joints[3]], metric[joints[0]]),
      direction2d: { x: dir2.x / len2, y: dir2.y / len2, z: 0 },
      tip3d: metric[joints[3]],
    };
  }

  const center = {
    x: (image[WRIST].x + image[5].x + image[17].x) / 3,
    y: (image[WRIST].y + image[5].y + image[17].y) / 3,
    z: 0,
  };

  return {
    fingers,
    center,
    size2d: length(sub(image[9], image[WRIST])),
    size3d: length(sub(metric[9], metric[WRIST])) || 1,
  };
}

function fingerStateMatches(finger, required, tolerance) {
  if (required === 'extended') return finger.flexionDeg <= EXTENDED_MAX_FLEXION_DEG * tolerance;
  if (required === 'curled') return finger.flexionDeg >= CURLED_MIN_FLEXION_DEG / tolerance;
  return true;
}

const TARGET_DIRECTIONS = {
  up: [{ x: 0, y: -1, z: 0 }],
  down: [{ x: 0, y: 1, z: 0 }],
  left: [{ x: -1, y: 0, z: 0 }],
  right: [{ x: 1, y: 0, z: 0 }],
  sideways: [
    { x: -1, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
  ],
};

/** Mean 2D pointing direction of a set of fingers. */
function pointingDirection(features, fingerNames) {
  let x = 0;
  let y = 0;
  for (const name of fingerNames) {
    x += features.fingers[name].direction2d.x;
    y += features.fingers[name].direction2d.y;
  }
  return { x, y, z: 0 };
}

/** Does one described hand satisfy one per-hand spec? */
export function handMatchesSpec(features, spec, tolerance = 1) {
  for (const [name, required] of Object.entries(spec.fingers || {})) {
    if (!fingerStateMatches(features.fingers[name], required, tolerance)) return false;
  }

  for (const [a, b] of spec.together || []) {
    const fa = features.fingers[a];
    const fb = features.fingers[b];
    if (angleBetweenDeg(fa.direction3d, fb.direction3d) > TOGETHER_MAX_ANGLE_DEG * tolerance) return false;
    const tipGap = length(sub(fa.tip3d, fb.tip3d)) / features.size3d;
    if (tipGap > TOGETHER_MAX_TIP_GAP * Math.sqrt(tolerance)) return false;
  }

  if (spec.pointing) {
    const dir = pointingDirection(features, spec.pointing.fingers);
    const targets = TARGET_DIRECTIONS[spec.pointing.toward] || TARGET_DIRECTIONS.up;
    const best = Math.min(...targets.map((t) => angleBetweenDeg(dir, t)));
    if (best > spec.pointing.maxDeg * tolerance) return false;
  }
  return true;
}

function relationMatches(a, b, specA, specB, relation, tolerance) {
  if (!relation) return true;
  if (relation.maxDistance != null) {
    const handSize = (a.size2d + b.size2d) / 2 || 1;
    const distance = length(sub(a.center, b.center)) / handSize;
    if (distance > relation.maxDistance * tolerance) return false;
  }
  if (relation.fingerAngleDeg) {
    const widen = (tolerance - 1) * 20;
    const [min, max] = relation.fingerAngleDeg;
    const dirA = pointingDirection(a, (specA.pointing && specA.pointing.fingers) || ['index']);
    const dirB = pointingDirection(b, (specB.pointing && specB.pointing.fingers) || ['index']);
    const angle = angleBetweenDeg(dirA, dirB);
    if (angle < min - widen || angle > max + widen) return false;
  }
  return true;
}

/**
 * Is `sign` currently being shown by `hands`?
 * Hands that are merely present never match: every finger state, adjacency,
 * pointing direction and (for two-hand signs) inter-hand relation must hold.
 */
export function matchSign(sign, hands, { aspect = 16 / 9, tolerance = 1 } = {}) {
  if (!sign || !hands || hands.length < sign.hands.length) return false;
  const described = hands.map((h) => describeHand(h, aspect));

  if (sign.hands.length === 1) {
    return described.some((f) => handMatchesSpec(f, sign.hands[0], tolerance));
  }

  // Two-hand sign: try every ordered pair of detected hands against (specA, specB).
  const [specA, specB] = sign.hands;
  for (let i = 0; i < described.length; i++) {
    for (let j = 0; j < described.length; j++) {
      if (i === j) continue;
      if (
        handMatchesSpec(described[i], specA, tolerance) &&
        handMatchesSpec(described[j], specB, tolerance) &&
        relationMatches(described[i], described[j], specA, specB, sign.relation, tolerance)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Debounces raw per-frame matches into a single trigger.
 *
 *   - The sign must be held for `holdMs`.
 *   - Detection dropouts shorter than `graceMs` don't reset the hold
 *     (hand tracking flickers for a frame now and then).
 *   - After firing, nothing fires again until `cooldownMs` has passed AND the
 *     sign has been released for `releaseMs` (holding the pose never loops).
 */
export class GestureStabilizer {
  constructor({ holdMs = 550, graceMs = 180, cooldownMs = 4000, releaseMs = 350 } = {}) {
    this.configure({ holdMs, graceMs, cooldownMs, releaseMs });
    this.reset();
  }

  configure(options) {
    Object.assign(this, options);
  }

  reset() {
    this._holdStart = null;
    this._lastMatch = -Infinity;
    this._lastFire = -Infinity;
    this._armed = true;
  }

  /**
   * @param matched whether the sign matched on this frame
   * @param now     timestamp in ms (monotonic)
   * @returns { progress: 0..1 hold progress, triggered: boolean, coolingDown: boolean }
   */
  update(matched, now) {
    const coolingDown = now - this._lastFire < this.cooldownMs;

    if (matched) {
      this._lastMatch = now;
    } else if (now - this._lastMatch > this.releaseMs) {
      this._armed = true; // sign fully released → allowed to fire again
    }

    const withinGrace = now - this._lastMatch <= this.graceMs;
    if (!withinGrace || !this._armed || coolingDown) {
      this._holdStart = null;
      return { progress: 0, triggered: false, coolingDown };
    }

    if (this._holdStart === null) this._holdStart = now;
    const progress = Math.min(1, (now - this._holdStart) / this.holdMs);

    // Only fire on a frame that actually matched, never during a dropout.
    if (progress >= 1 && matched) {
      this._lastFire = now;
      this._armed = false;
      this._holdStart = null;
      return { progress: 1, triggered: true, coolingDown: true };
    }
    return { progress, triggered: false, coolingDown };
  }
}
