/**
 * Isolated-world content script — the bridge between the extension and the
 * MAIN-world pipeline (inject.js / video/streamManager.js).
 *
 *   chrome.storage  ──settings──▶ page
 *   popup           ──test / status requests──▶ page
 *   page            ──"need-engine"──▶ creates the hidden detection iframe and
 *                     hands each side one end of a MessageChannel
 *
 * It never touches Meet's DOM structure or class names; the only DOM it adds
 * is one hidden iframe.
 */
(function () {
  'use strict';

  const TAG = '__shinobiMeet';
  const ENABLED_CACHE_KEY = 'shinobiMeet.enabled';
  const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
  const ENGINE_START_TIMEOUT_MS = 20000;

  let settings = ShinobiSettings.sanitize({});
  let lastStatus = null;
  let lastStatusAt = 0;
  let engineFrame = null;
  let engineTimer = null;
  let badgeActive = null;
  const pendingTests = [];

  /** False once the extension was reloaded/removed while this page stayed open. */
  function extensionAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  function toPage(message, transfer) {
    window.postMessage({ [TAG]: 'to-page', ...message }, window.location.origin, transfer || []);
  }

  // ------------------------------------------------------------ settings

  function pushSettings() {
    // Synchronous cache so inject.js knows the enabled state at document_start,
    // before chrome.storage (async) has answered.
    try {
      localStorage.setItem(ENABLED_CACHE_KEY, settings.enabled ? '1' : '0');
    } catch (_) {
      /* storage blocked — inject.js defaults to enabled */
    }
    toPage({ type: 'settings', settings });
  }

  ShinobiSettings.load()
    .then((loaded) => {
      settings = loaded;
      pushSettings();
    })
    .catch(() => pushSettings());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const patch = {};
    for (const [key, change] of Object.entries(changes)) patch[key] = change.newValue;
    settings = ShinobiSettings.sanitize({ ...settings, ...patch });
    pushSettings();
  });

  // ------------------------------------------------------ detection engine

  function createEngine() {
    destroyEngine();
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('engine/engine.html');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText =
      'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;z-index:-1;';
    (document.body || document.documentElement).appendChild(frame);
    engineFrame = frame;
    engineTimer = setTimeout(() => {
      engineTimer = null;
      toPage({ type: 'engine-failed', message: 'Detection engine did not start (timed out).' });
    }, ENGINE_START_TIMEOUT_MS);
  }

  function destroyEngine() {
    clearTimeout(engineTimer);
    engineTimer = null;
    if (engineFrame) {
      engineFrame.remove(); // unloads the page → MediaPipe/WebGL resources are released
      engineFrame = null;
    }
  }

  /** The engine says it is listening: give it and the page one port each. */
  function connectEngine() {
    clearTimeout(engineTimer);
    engineTimer = null;
    const channel = new MessageChannel();
    engineFrame.contentWindow.postMessage({ type: 'shinobi-engine-port', settings }, EXTENSION_ORIGIN, [
      channel.port1,
    ]);
    toPage({ type: 'engine-port' }, [channel.port2]);
  }

  // ------------------------------------------------------------ messages

  window.addEventListener('message', (event) => {
    // From the engine iframe
    if (engineFrame && event.source === engineFrame.contentWindow) {
      if (event.origin === EXTENSION_ORIGIN && event.data?.type === 'shinobi-engine-hello') connectEngine();
      return;
    }
    // From the MAIN-world pipeline
    if (event.source !== window || !event.data || event.data[TAG] !== 'to-content') return;
    const msg = event.data;
    switch (msg.type) {
      case 'hello':
        pushSettings();
        break;
      case 'need-engine':
        if (extensionAlive()) createEngine();
        else toPage({ type: 'engine-failed', message: 'Extension was reloaded — refresh this tab.' });
        break;
      case 'release-engine':
        destroyEngine();
        break;
      case 'status':
        lastStatus = msg.status;
        lastStatusAt = Date.now();
        updateBadge();
        break;
      case 'test-result': {
        const respond = pendingTests.shift();
        if (respond) respond({ ok: true, started: msg.started });
        break;
      }
    }
  });

  function updateBadge() {
    const active = Boolean(lastStatus && lastStatus.enabled && lastStatus.liveStreams > 0);
    if (active === badgeActive || !extensionAlive()) return;
    badgeActive = active;
    chrome.runtime.sendMessage({ type: 'badge', active }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'get-status') {
      // Statuses are pushed while frames flow; ask for a fresh one otherwise.
      toPage({ type: 'get-status' });
      sendResponse({ ok: true, status: lastStatus, statusAgeMs: Date.now() - lastStatusAt });
      return false;
    }
    if (message?.type === 'test-trigger') {
      pendingTests.push(sendResponse);
      toPage({ type: 'test-trigger' });
      setTimeout(() => {
        const index = pendingTests.indexOf(sendResponse);
        if (index >= 0) {
          pendingTests.splice(index, 1);
          sendResponse({ ok: false, error: 'The page did not respond. Reload the Meet tab.' });
        }
      }, 1500);
      return true; // async response
    }
    return false;
  });
})();
