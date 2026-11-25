// Unit tests for the gesture recognition module (pure geometry — runs in Node).
// Usage: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSign, GestureStabilizer, SENSITIVITY } from '../extension/gesture/gestureRecognition.js';
import { SIGNS, registerSign, getSign } from '../extension/gesture/signs.js';

const DEG = Math.PI / 180;
const ASPECT = 16 / 9;

/**
 * Build a synthetic hand with forward kinematics.
 * Hand-local frame: palm in the XY plane, fingers along +Y, curling towards +Z.
 *
 * @param flex   per-finger bend per joint in degrees (0 = straight, ~85 = fist)
 * @param spread per-finger sideways angle in degrees (splay in the palm plane)
 * @param rotationDeg rotation of the whole hand in the image plane (0 = fingers up)
 * @param center normalised image position of the wrist
 */
function makeHand({ flex = {}, spread = {}, rotationDeg = 0, center = { x: 0.5, y: 0.6 } } = {}) {
  const fingers = {
    thumb: { base: [-0.035, 0.03], bones: [0.035, 0.03, 0.025], splay: -40 },
    index: { base: [-0.019, 0.09], bones: [0.04, 0.025, 0.02], splay: -1 },
    middle: { base: [0, 0.095], bones: [0.045, 0.028, 0.022], splay: 0 },
    ring: { base: [0.02, 0.09], bones: [0.04, 0.026, 0.02], splay: 3 },
    pinky: { base: [0.038, 0.08], bones: [0.03, 0.02, 0.018], splay: 6 },
  };
  const points = [{ x: 0, y: 0, z: 0 }];
  for (const [name, def] of Object.entries(fingers)) {
    const bend = (flex[name] ?? 0) * DEG;
    const splay = ((spread[name] ?? 0) + def.splay) * DEG;
    let p = { x: def.base[0], y: def.base[1], z: 0 };
    points.push(p);
    let pitch = 0;
    for (const length of def.bones) {
      pitch += bend;
      const forward = Math.cos(pitch) * length;
      p = {
        x: p.x + Math.sin(splay) * forward,
        y: p.y + Math.cos(splay) * forward,
        z: p.z + Math.sin(pitch) * length,
      };
      points.push(p);
    }
  }
  const rot = rotationDeg * DEG;
  const world = points.map((p) => ({
    x: p.x * Math.cos(rot) - p.y * Math.sin(rot),
    y: -(p.x * Math.sin(rot) + p.y * Math.cos(rot)), // image y grows downwards
    z: p.z,
  }));
  // Project to normalised image coords: 1 m ≈ 1.6 image heights.
  const landmarks = world.map((p) => ({
    x: center.x + (p.x * 1.6) / ASPECT,
    y: center.y + p.y * 1.6,
    z: p.z,
  }));
  return { landmarks, worldLandmarks: world };
}

const SEAL = { index: 0, middle: 0, ring: 85, pinky: 85, thumb: 30 };
const FIST = { index: 85, middle: 85, ring: 85, pinky: 85, thumb: 40 };
const opts = { aspect: ASPECT, tolerance: SENSITIVITY.medium.tolerance };
const confrontation = SIGNS.confrontation;

test('seal of confrontation is recognised', () => {
  assert.equal(matchSign(confrontation, [makeHand({ flex: SEAL })], opts), true);
});

test('recognised with slightly bent fingers and a small tilt', () => {
  const hand = makeHand({ flex: { ...SEAL, index: 12, middle: 10 }, rotationDeg: 15 });
  assert.equal(matchSign(confrontation, [hand], opts), true);
});

test('recognised when it is the second of two hands', () => {
  const hands = [makeHand({ flex: FIST, center: { x: 0.2, y: 0.6 } }), makeHand({ flex: SEAL })];
  assert.equal(matchSign(confrontation, hands, opts), true);
});

test('no hands → no match', () => {
  assert.equal(matchSign(confrontation, [], opts), false);
});

test('open palm does not trigger', () => {
  assert.equal(matchSign(confrontation, [makeHand({ flex: {} })], opts), false);
});

test('fist does not trigger', () => {
  assert.equal(matchSign(confrontation, [makeHand({ flex: FIST })], opts), false);
});

test('pointing with only the index finger does not trigger', () => {
  assert.equal(matchSign(confrontation, [makeHand({ flex: { ...FIST, index: 0 } })], opts), false);
});

test('spread "peace" sign does not trigger', () => {
  const hand = makeHand({ flex: SEAL, spread: { index: -16, middle: 16 } });
  assert.equal(matchSign(confrontation, [hand], opts), false);
});

test('three fingers up does not trigger', () => {
  assert.equal(matchSign(confrontation, [makeHand({ flex: { ...SEAL, ring: 0 } })], opts), false);
});

test('seal pointing sideways or down does not trigger', () => {
  assert.equal(matchSign(confrontation, [makeHand({ flex: SEAL, rotationDeg: 90 })], opts), false);
  assert.equal(matchSign(confrontation, [makeHand({ flex: SEAL, rotationDeg: 180 })], opts), false);
});

test('sensitivity changes how strict the pose is', () => {
  const sloppy = makeHand({ flex: { ...SEAL, index: 26, middle: 26 } }); // 78° total bend
  assert.equal(matchSign(confrontation, [sloppy], { aspect: ASPECT, tolerance: SENSITIVITY.low.tolerance }), false);
  assert.equal(matchSign(confrontation, [sloppy], { aspect: ASPECT, tolerance: SENSITIVITY.high.tolerance }), true);
});

test('clone seal needs both hands crossed', () => {
  const upright = makeHand({ flex: SEAL, center: { x: 0.5, y: 0.6 } });
  const sideways = makeHand({ flex: SEAL, rotationDeg: 90, center: { x: 0.56, y: 0.5 } });
  assert.equal(matchSign(SIGNS.cross, [upright, sideways], opts), true);
  assert.equal(matchSign(SIGNS.cross, [sideways, upright], opts), true, 'hand order must not matter');
  assert.equal(matchSign(SIGNS.cross, [upright], opts), false, 'one hand is not enough');

  const parallel = makeHand({ flex: SEAL, center: { x: 0.56, y: 0.6 } });
  assert.equal(matchSign(SIGNS.cross, [upright, parallel], opts), false, 'parallel hands are not crossed');

  const farAway = makeHand({ flex: SEAL, rotationDeg: 90, center: { x: 0.95, y: 0.2 } });
  assert.equal(matchSign(SIGNS.cross, [upright, farAway], opts), false, 'hands must be together');
});

test('custom signs can be registered', () => {
  registerSign({
    id: 'test-open-palm',
    label: 'Open palm',
    hands: [{ fingers: { index: 'extended', middle: 'extended', ring: 'extended', pinky: 'extended' } }],
  });
  assert.equal(matchSign(getSign('test-open-palm'), [makeHand({ flex: {} })], opts), true);
  assert.equal(matchSign(getSign('test-open-palm'), [makeHand({ flex: FIST })], opts), false);
  assert.equal(getSign('does-not-exist').id, 'confrontation');
});

test('stabilizer: fires once after the hold time', () => {
  const s = new GestureStabilizer({ holdMs: 500, graceMs: 150, cooldownMs: 3000, releaseMs: 300 });
  let fired = 0;
  for (let t = 0; t <= 2000; t += 50) if (s.update(true, t).triggered) fired++;
  assert.equal(fired, 1, 'holding the pose must not loop');
  assert.equal(s.update(true, 450).triggered, false);
});

test('stabilizer: a brief flash of the pose does not fire', () => {
  const s = new GestureStabilizer({ holdMs: 500, graceMs: 150 });
  let fired = false;
  for (let t = 0; t <= 300; t += 50) fired ||= s.update(true, t).triggered;
  for (let t = 350; t <= 2000; t += 50) fired ||= s.update(false, t).triggered;
  assert.equal(fired, false);
});

test('stabilizer: tolerates single dropped frames', () => {
  const s = new GestureStabilizer({ holdMs: 500, graceMs: 150 });
  let fired = false;
  for (let t = 0; t <= 700; t += 50) fired ||= s.update(t !== 200 && t !== 350, t).triggered;
  assert.equal(fired, true);
});

test('stabilizer: long gaps reset the hold', () => {
  const s = new GestureStabilizer({ holdMs: 500, graceMs: 150 });
  let fired = false;
  // 300 ms on, 300 ms off, repeated — never 500 ms continuous.
  for (let t = 0; t <= 3000; t += 50) fired ||= s.update(t % 600 < 300, t).triggered;
  assert.equal(fired, false);
});

test('stabilizer: needs release + cooldown before firing again', () => {
  const s = new GestureStabilizer({ holdMs: 500, graceMs: 150, cooldownMs: 3000, releaseMs: 300 });
  const times = [];
  for (let t = 0; t <= 10000; t += 50) {
    const showing = t < 1000 || (t >= 1500 && t < 2500) || t >= 5000; // release, retry early, retry late
    if (s.update(showing, t).triggered) times.push(t);
  }
  assert.equal(times.length, 2);
  assert.equal(times[0], 500);
  assert.ok(times[1] >= 5500, `second trigger only after cooldown, got ${times[1]}`);
});
