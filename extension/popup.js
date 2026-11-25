/**
 * Popup: settings, live status of the Meet tab, a local animation preview and
 * the "test teleportation" button.
 */
import { SIGNS } from './gesture/signs.js';

const { ShinobiSettings } = globalThis;
const NS = globalThis.__shinobiMeet;
const MEET_URL = 'https://meet.google.com/*';
const $ = (id) => document.getElementById(id);

let settings = ShinobiSettings.sanitize({});
let targetTabId = null;

// ------------------------------------------------------------------ settings

function renderSettings() {
  $('enabled').checked = settings.enabled;
  $('returnMode').value = settings.returnMode;
  $('holdRow').hidden = settings.returnMode !== 'timer';
  $('hold').value = settings.holdSeconds;
  $('holdOut').textContent = Number(settings.holdSeconds).toFixed(1);
  $('sensitivity').value = settings.sensitivity;
  $('sign').value = settings.sign;
  $('signHelp').textContent = (SIGNS[settings.sign] || {}).description || '';
}

async function update(patch) {
  settings = ShinobiSettings.sanitize({ ...settings, ...patch });
  renderSettings();
  await ShinobiSettings.save(patch); // content scripts pick this up via storage.onChanged
}

function initControls() {
  for (const sign of Object.values(SIGNS)) {
    const option = document.createElement('option');
    option.value = sign.id;
    option.textContent = sign.label;
    $('sign').appendChild(option);
  }
  $('enabled').addEventListener('change', (e) => update({ enabled: e.target.checked }));
  $('sign').addEventListener('change', (e) => update({ sign: e.target.value }));
  $('returnMode').addEventListener('change', (e) => update({ returnMode: e.target.value }));
  $('sensitivity').addEventListener('change', (e) => update({ sensitivity: e.target.value }));
  $('hold').addEventListener('input', (e) => {
    $('holdOut').textContent = Number(e.target.value).toFixed(1);
  });
  $('hold').addEventListener('change', (e) => update({ holdSeconds: Number(e.target.value) }));
  $('testBtn').addEventListener('click', testInMeet);
  $('previewBtn').addEventListener('click', () => preview.play(settings.holdSeconds * 1000));
}

// -------------------------------------------------------------------- status

function setRow(name, level, text) {
  $(`dot${name}`).className = `dot ${level}`;
  $(`val${name}`).textContent = text;
}

/** Ask every open Meet tab for its status and pick the most relevant one. */
async function queryMeetTabs() {
  const tabs = await chrome.tabs.query({ url: MEET_URL });
  const results = await Promise.all(
    tabs.map(async (tab) => {
      try {
        const reply = await chrome.tabs.sendMessage(tab.id, { type: 'get-status' });
        return { tab, reply };
      } catch (_) {
        return { tab, reply: null }; // content script not present (tab predates install)
      }
    })
  );
  const score = ({ tab, reply }) =>
    (reply?.status?.liveStreams > 0 ? 4 : 0) + (tab.active ? 2 : 0) + (reply ? 1 : 0);
  results.sort((a, b) => score(b) - score(a));
  return results;
}

async function refreshStatus() {
  let results = [];
  try {
    results = await queryMeetTabs();
  } catch (_) {
    /* tabs API hiccup — show "no tab" */
  }
  const best = results[0];
  let hint = '';
  let canTest = false;
  let progress = 0;
  let testLabel = '⚡ Test teleportation in Meet';
  targetTabId = null;

  if (!best) {
    setRow('Meet', 'warn', 'No Meet tab open');
    setRow('Camera', '', '—');
    setRow('Gesture', '', '—');
    hint = 'Open meet.google.com and join or start a call.';
  } else if (!best.reply) {
    setRow('Meet', 'bad', 'Reload required');
    setRow('Camera', '', '—');
    setRow('Gesture', '', '—');
    hint = 'This Meet tab was opened before the extension was installed or updated. Reload the tab.';
  } else {
    const status = best.reply.status;
    targetTabId = best.tab.id;
    setRow('Meet', 'ok', results.length > 1 ? `Connected (${results.length} tabs)` : 'Connected');

    if (!settings.enabled) {
      setRow('Camera', '', 'Disabled');
      setRow('Gesture', '', 'Disabled');
    } else if (!status || status.liveStreams === 0) {
      setRow('Camera', 'warn', 'Waiting for camera');
      setRow('Gesture', '', 'Idle');
      hint =
        'Turn your camera on in Meet. If it is already on, switch it off and on once (or reload the tab) so the jutsu can attach. No virtual camera needs to be selected — keep your normal webcam.';
    } else {
      canTest = true;
      const fallback = status.mode !== 'insertable-streams';
      if (status.awaitingReturn) {
        setRow('Camera', 'warn', 'Invisible');
        hint = 'You are hidden. Release your hand, then make the seal again to come back.';
        testLabel = '↩ Bring me back';
      } else {
        setRow('Camera', 'ok', status.effectActive ? 'Teleporting…' : 'Active · visible to everyone');
      }
      if (fallback) hint = 'Compatibility mode: keep the Meet tab visible while teleporting.';

      const gesture = status.gesture || {};
      if (status.engine === 'ready') {
        if (gesture.matched || gesture.progress > 0) {
          setRow('Gesture', 'ok', `Seal recognised ${Math.round(gesture.progress * 100)}%`);
        } else if (gesture.hands > 0) {
          setRow('Gesture', 'ok', `${gesture.hands} hand${gesture.hands > 1 ? 's' : ''} in view`);
        } else {
          setRow('Gesture', 'ok', 'Watching for the seal');
        }
        progress = gesture.progress || 0;
      } else if (status.engine === 'loading') {
        setRow('Gesture', 'warn', 'Loading hand model…');
      } else if (status.engine === 'error') {
        setRow('Gesture', 'bad', 'Unavailable');
        hint = `${status.engineMessage || 'Hand detection failed to start.'} The test button still works.`;
      } else {
        setRow('Gesture', '', 'Idle');
      }
    }
  }

  $('holdMeter').style.width = `${Math.round(progress * 100)}%`;
  $('hint').textContent = hint;
  $('testBtn').disabled = !canTest;
  $('testBtn').textContent = testLabel;
}

async function testInMeet() {
  const message = $('testMsg');
  if (targetTabId == null) return;
  try {
    const reply = await chrome.tabs.sendMessage(targetTabId, { type: 'test-trigger' });
    if (reply?.ok && reply.started) message.textContent = 'Done — check your Meet self-view.';
    else message.textContent = reply?.error || 'No active camera stream to teleport.';
  } catch (_) {
    message.textContent = 'Could not reach the Meet tab. Reload it.';
  }
  setTimeout(() => (message.textContent = ''), 4000);
}

// ------------------------------------------------------------------- preview

/**
 * Runs the real TeleportEffect on a drawn scene, so the popup shows exactly
 * the animation code that runs in the call.
 */
const preview = (() => {
  const canvas = $('preview');
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const effect = new NS.TeleportEffect({ allowReadback: true });
  let running = false;

  const drawFigure = (c, color) => {
    c.fillStyle = color;
    c.beginPath();
    c.ellipse(width / 2, height * 0.4, height * 0.13, height * 0.16, 0, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.moveTo(width * 0.27, height);
    c.quadraticCurveTo(width * 0.3, height * 0.6, width / 2, height * 0.58);
    c.quadraticCurveTo(width * 0.7, height * 0.6, width * 0.73, height);
    c.fill();
  };

  // Background plate: an empty room.
  const plate = NS.util.makeCanvas(width, height);
  const p = plate.getContext('2d');
  const wall = p.createLinearGradient(0, 0, 0, height);
  wall.addColorStop(0, '#26324d');
  wall.addColorStop(1, '#141b2e');
  p.fillStyle = wall;
  p.fillRect(0, 0, width, height);
  p.fillStyle = '#3b4a6e';
  p.fillRect(22, 26, 84, 58); // window
  p.fillStyle = '#9fc4ee';
  p.fillRect(27, 31, 74, 48);
  p.fillStyle = '#31405f';
  p.fillRect(236, 40, 76, 8); // shelf
  p.fillStyle = '#c96a4a';
  p.fillRect(246, 22, 10, 18);
  p.fillStyle = '#4fae8a';
  p.fillRect(262, 26, 14, 14);
  p.fillStyle = '#0f1524';
  p.fillRect(0, height - 26, width, 26); // desk

  // Person mask + the "camera frame" (room with a person in it).
  const mask = NS.util.makeCanvas(width, height);
  drawFigure(mask.getContext('2d'), '#fff');
  const frame = NS.util.makeCanvas(width, height);
  const f = frame.getContext('2d');
  f.drawImage(plate, 0, 0);
  drawFigure(f, '#e0a37c');
  f.fillStyle = '#23283a';
  f.beginPath();
  f.ellipse(width / 2, height * 0.31, height * 0.14, height * 0.09, 0, Math.PI, 0); // hair
  f.fill();
  f.fillStyle = '#ff7a1a'; // jacket
  f.beginPath();
  f.moveTo(width * 0.27, height);
  f.quadraticCurveTo(width * 0.3, height * 0.62, width / 2, height * 0.62);
  f.quadraticCurveTo(width * 0.7, height * 0.62, width * 0.73, height);
  f.fill();

  const tick = (now) => {
    running = effect.render(ctx, frame, now);
    if (running) requestAnimationFrame(tick);
  };

  ctx.drawImage(frame, 0, 0);
  return {
    play(holdMs) {
      effect.start({ now: performance.now(), holdMs: Math.min(holdMs, 2500), plate, mask });
      if (!running) {
        running = true;
        requestAnimationFrame(tick);
      }
    },
  };
})();

// ---------------------------------------------------------------------- init

initControls();
settings = await ShinobiSettings.load();
renderSettings();
refreshStatus();
setInterval(refreshStatus, 500);
