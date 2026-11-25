/**
 * Settings shared by the popup, the content script and the service worker.
 * Classic script (no ES module syntax) so it can be loaded with a <script>
 * tag, as a content script, and with importScripts().
 */
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: true,
    /**
     * How the user comes back:
     *   'gesture' — stay invisible until the hand seal is made again
     *   'timer'   — reappear automatically after holdSeconds
     */
    returnMode: 'gesture',
    /** How long the user stays invisible in 'timer' mode, in seconds. */
    holdSeconds: 2,
    /** 'low' | 'medium' | 'high' — see gesture/gestureRecognition.js */
    sensitivity: 'medium',
    /** Id of the hand sign that triggers the jutsu — see gesture/signs.js */
    sign: 'confrontation',
  });

  const LIMITS = Object.freeze({ holdMin: 0.5, holdMax: 10 });

  function sanitize(raw) {
    const s = { ...DEFAULTS, ...(raw || {}) };
    s.enabled = Boolean(s.enabled);
    const hold = Number(s.holdSeconds);
    s.holdSeconds = Number.isFinite(hold)
      ? Math.min(LIMITS.holdMax, Math.max(LIMITS.holdMin, hold))
      : DEFAULTS.holdSeconds;
    if (!['gesture', 'timer'].includes(s.returnMode)) s.returnMode = DEFAULTS.returnMode;
    if (!['low', 'medium', 'high'].includes(s.sensitivity)) s.sensitivity = DEFAULTS.sensitivity;
    if (typeof s.sign !== 'string' || !s.sign) s.sign = DEFAULTS.sign;
    return s;
  }

  async function load() {
    const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS));
    return sanitize(stored);
  }

  async function save(patch) {
    await chrome.storage.sync.set(patch);
  }

  root.ShinobiSettings = { DEFAULTS, LIMITS, sanitize, load, save };
})(globalThis);
