/**
 * Hand-sign definitions.
 *
 * A sign is pure data. To add a new one, add an entry here (or call
 * registerSign() at runtime) — no recognition code needs to change.
 *
 * Per-hand spec:
 *   fingers   — required state per finger: 'extended' | 'curled'. Fingers that
 *               are not listed are ignored (the thumb is ignored by default
 *               because its pose varies a lot between people).
 *   together  — pairs of fingers that must be side by side (small angle between
 *               them and fingertips close), e.g. distinguishes the ninja seal
 *               from a spread "peace" sign.
 *   pointing  — where the listed fingers must point in the camera image:
 *               { fingers, toward: 'up'|'down'|'left'|'right'|'sideways', maxDeg }.
 *
 * Two-hand signs add `relation`:
 *   maxDistance      — max distance between the two hands, measured in hand sizes.
 *   fingerAngleDeg   — [min, max] angle between the pointing directions of the
 *                      two hands (e.g. ~90° for crossed fingers).
 */

const TWO_FINGER_SEAL = {
  fingers: { index: 'extended', middle: 'extended', ring: 'curled', pinky: 'curled' },
  together: [['index', 'middle']],
};

export const SIGNS = {
  /**
   * Seal of Confrontation — one hand in front of the chest, index and middle
   * fingers together pointing straight up, the other fingers folded.
   * This is the default: a single unoccluded hand is what MediaPipe tracks
   * most reliably.
   */
  confrontation: {
    id: 'confrontation',
    label: 'Seal of Confrontation (one hand)',
    description: 'Index + middle fingers together, pointing up. Other fingers folded.',
    hands: [
      {
        ...TWO_FINGER_SEAL,
        pointing: { fingers: ['index', 'middle'], toward: 'up', maxDeg: 35 },
      },
    ],
  },

  /**
   * Clone Seal — both hands make the two-finger seal and cross in a "+":
   * one hand's fingers point up, the other's point sideways.
   */
  cross: {
    id: 'cross',
    label: 'Clone Seal (two hands crossed)',
    description: 'Both hands: index + middle extended. Cross them in a “+” shape.',
    hands: [
      {
        ...TWO_FINGER_SEAL,
        pointing: { fingers: ['index', 'middle'], toward: 'up', maxDeg: 40 },
      },
      {
        ...TWO_FINGER_SEAL,
        pointing: { fingers: ['index', 'middle'], toward: 'sideways', maxDeg: 40 },
      },
    ],
    relation: { maxDistance: 2.4, fingerAngleDeg: [50, 130] },
  },
};

/** Register an additional sign at runtime. */
export function registerSign(sign) {
  if (!sign || !sign.id || !Array.isArray(sign.hands) || sign.hands.length < 1 || sign.hands.length > 2) {
    throw new Error('Invalid sign definition');
  }
  SIGNS[sign.id] = sign;
}

export function getSign(id) {
  return SIGNS[id] || SIGNS.confrontation;
}
