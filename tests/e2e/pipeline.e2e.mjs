/**
 * End-to-end test of the real extension in a real Chrome (no Google account needed).
 *
 * Google Meet itself cannot be automated without a logged-in account, so this
 * test reproduces exactly what Meet does with the camera on a local page:
 *   getUserMedia → RTCPeerConnection.addTrack → remote peer renders the video.
 * The extension is loaded from a temp copy whose manifest additionally matches
 * http://localhost, so every code path (MAIN-world hook, content script,
 * engine iframe, MediaPipe, effect, WebRTC encode) is the shipped code.
 *
 * Usage:
 *   npm install --no-save puppeteer
 *   node tests/e2e/pipeline.e2e.mjs [--images <dir>] [--shots <dir>]
 *
 *   --images  directory with optional real photos for model checks:
 *             portrait.jpg (a person), victory.jpg / pointing_up.jpg / fist.jpg (hands)
 *   --shots   directory to write screenshots of the effect to
 *   --headful show the browser window (uses the real GPU → realistic performance numbers)
 */
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const puppeteer = (await import(process.env.PUPPETEER_MODULE || 'puppeteer')).default;

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const imagesDir = argValue('--images');
const shotsDir = argValue('--shots');
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- temp copy of the extension that also runs on http://localhost
const extensionDir = mkdtempSync(join(tmpdir(), 'shinobi-e2e-'));
cpSync(join(here, '../../extension'), extensionDir, { recursive: true });
const manifestPath = join(extensionDir, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const LOCAL = 'http://localhost/*';
manifest.host_permissions.push(LOCAL);
manifest.content_scripts.forEach((cs) => cs.matches.push(LOCAL));
manifest.web_accessible_resources.forEach((war) => war.matches.push(LOCAL));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// ---- local "meeting" page
const PAGE = `<!doctype html><meta charset="utf-8"><title>loopback call</title>
<body style="margin:0;background:#111;display:flex;gap:8px">
<video id="local" autoplay muted playsinline width="640"></video>
<video id="remote" autoplay muted playsinline width="640"></video>
<script>
  window.statuses = [];
  window.addEventListener('message', (e) => {
    if (e.data && e.data.__shinobiMeet === 'to-content' && e.data.type === 'status') {
      window.lastStatus = e.data.status;
      window.statuses.push({ t: performance.now(), active: e.data.status.effectActive });
    }
  });
  window.startCall = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    const track = stream.getVideoTracks()[0];
    document.getElementById('local').srcObject = stream;
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    b.ontrack = (e) => { document.getElementById('remote').srcObject = e.streams[0]; };
    a.addTrack(track, stream);
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    window.track = track;
    return { kind: track.constructor.name, label: track.label, settings: track.getSettings() };
  };
  const PW = 160, PH = 90;
  const probe = document.createElement('canvas'); probe.width = PW; probe.height = PH;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  // Downsampled pixels of a <video>, for comparing frames.
  window.grab = (id) => {
    const v = document.getElementById(id);
    pctx.drawImage(v, 0, 0, PW, PH);
    return Array.from(pctx.getImageData(0, 0, PW, PH).data);
  };
</script>`;

const server = createServer((req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0].slice(1));
  if (name.startsWith('img/') && imagesDir && existsSync(join(imagesDir, name.slice(4)))) {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*' });
    res.end(readFileSync(join(imagesDir, name.slice(4))));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, 'localhost', r));
const origin = `http://localhost:${server.address().port}`;

const browser = await puppeteer.launch({
  headless: !args.includes('--headful'),
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

// "Motion" between two grabs: the largest mean pixel change of any 10×10 block.
// Chrome's fake camera animates a rotating shape, so live video always has at
// least one block that changes a lot; a frozen picture with a few drifting
// sparks does not.
const PW = 160, PH = 90, BLOCK = 10;
const motion = (a, b) => {
  let worst = 0;
  for (let by = 0; by < PH; by += BLOCK) {
    for (let bx = 0; bx < PW; bx += BLOCK) {
      let sum = 0;
      for (let y = by; y < by + BLOCK; y++) {
        for (let x = bx; x < bx + BLOCK; x++) {
          const i = (y * PW + x) * 4;
          sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        }
      }
      worst = Math.max(worst, sum / (BLOCK * BLOCK * 3));
    }
  }
  return worst;
};
const blueExcess = (a) => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += a[i + 2] - (a[i] + a[i + 1]) / 2;
  return sum / (a.length / 4);
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 400 });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`   [page ${m.type()}] ${m.text()}`);
  });
  await page.goto(origin);

  // ---------------------------------------------------------- camera hook
  const info = await page.evaluate(() => window.startCall());
  check('Page receives a processed track instead of the raw camera', info.kind === 'MediaStreamTrackGenerator', info.kind);
  check('Processed track reports the real camera label', /fake/i.test(info.label), info.label);
  check('Processed track reports the real camera settings', info.settings.width === 1280 && info.settings.height === 720 && Boolean(info.settings.deviceId), `${info.settings.width}x${info.settings.height}`);

  await page.waitForFunction(() => document.getElementById('remote').videoWidth > 0, { timeout: 15000 });
  const remoteSize = await page.evaluate(() => [remote.videoWidth, remote.videoHeight]);
  check('Remote peer receives video over WebRTC', remoteSize[0] > 0, remoteSize.join('x'));

  // --------------------------------------------------------- engine boot
  await page.waitForFunction(() => window.lastStatus && ['ready', 'error'].includes(window.lastStatus.engine), { timeout: 90000 });
  const status = await page.evaluate(() => window.lastStatus);
  check('Detection engine (MediaPipe in extension iframe) loads', status.engine === 'ready', `${status.engine} ${status.engineMessage}`);
  check('Pipeline uses insertable streams', status.mode === 'insertable-streams', status.mode);
  check('Exactly one live processed stream', status.liveStreams === 1, String(status.liveStreams));

  // --------------------------------------------- no false trigger at rest
  await sleep(2500);
  const idle = await page.evaluate(() => window.lastStatus);
  check('No trigger without a hand seal (test pattern only)', !idle.effectActive && idle.lastTriggerAt === 0);

  // Baseline: live video changes from frame to frame (the fake camera animates).
  const live1 = await page.evaluate(() => window.grab('remote'));
  await sleep(600);
  const live2 = await page.evaluate(() => window.grab('remote'));
  const liveMotion = motion(live1, live2);
  const baseBlue = blueExcess(live2);

  // ------------------------------------------------------------ teleport
  await page.evaluate(() => {
    // Test-only instrumentation: time every composited frame and count remote frames.
    const effect = [...globalThis.__shinobiMeet.manager.pipelines][0].effect;
    const render = effect.render.bind(effect);
    window.renderMs = [];
    effect.render = (...a) => {
      const start = performance.now();
      const r = render(...a);
      window.renderMs.push(performance.now() - start);
      return r;
    };
    window.remoteFrames = [];
    const onFrame = (now) => {
      window.remoteFrames.push(now);
      remote.requestVideoFrameCallback(onFrame);
    };
    remote.requestVideoFrameCallback(onFrame);
    window.statuses.length = 0;
    window.t0 = performance.now();
    window.postMessage({ __shinobiMeet: 'to-page', type: 'test-trigger' }, location.origin);
  });
  const samples = [];
  const shotAt = new Set([5, 11, 14, 22, 43, 47]); // ×100 ms
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const t = await page.evaluate(() => performance.now() - window.t0);
    samples.push({ t, px: await page.evaluate(() => window.grab('remote')) });
    if (shotsDir && shotAt.has(i)) await page.screenshot({ path: join(shotsDir, `effect-${String(Math.round(t)).padStart(4, '0')}ms.png`) });
  }
  const statuses = await page.evaluate(() => window.statuses);
  const activeSpan = statuses.filter((s) => s.active);
  check('Effect starts on trigger', activeSpan.length > 0);
  const lastActive = activeSpan.length ? activeSpan[activeSpan.length - 1].t : 0;
  const firstActive = activeSpan.length ? activeSpan[0].t : 0;
  const duration = lastActive - firstActive;
  // 450 activate + 750 dissolve + 2000 hold + 750 reappear + 300 settle = 4250 ms
  check('Effect lasts ≈ 4.25 s with the default 2 s invisibility, then ends by itself', duration > 3500 && duration < 5200 && !statuses[statuses.length - 1].active, `${Math.round(duration)} ms`);

  const perf = await page.evaluate(() => {
    const sorted = [...window.renderMs].sort((a, b) => a - b);
    const during = window.remoteFrames.filter((t) => t - window.t0 > 300 && t - window.t0 < 4000).length / 3.7;
    return {
      frames: sorted.length,
      mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
      p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
      max: sorted[sorted.length - 1] || 0,
      remoteFps: during,
    };
  });
  console.log(`INFO  compositing cost per frame: mean ${perf.mean.toFixed(1)} ms, p95 ${perf.p95.toFixed(1)} ms, max ${perf.max.toFixed(1)} ms over ${perf.frames} frames; remote peer received ${perf.remoteFps.toFixed(1)} fps during the effect`);
  if (args.includes('--headful')) check('Compositing fits a 30 fps budget (p95 < 33 ms)', perf.p95 < 33, `${perf.p95.toFixed(1)} ms`);

  const peakBlue = Math.max(...samples.map((s) => blueExcess(s.px)));
  check('Remote peer sees the blue energy effect', peakBlue > baseBlue + 6, `blue excess ${baseBlue.toFixed(1)} → ${peakBlue.toFixed(1)}`);

  // During the invisible phase the remote must see the frozen background plate,
  // not the live camera (the camera itself keeps running underneath).
  const inHold = samples.filter((s) => s.t > 2100 && s.t < 2900);
  const holdMotion = inHold.length >= 2 ? motion(inHold[0].px, inHold[inHold.length - 1].px) : NaN;
  check('Invisible phase shows the background plate instead of live video', holdMotion < liveMotion * 0.5, `motion live ${liveMotion.toFixed(2)} vs hold ${holdMotion.toFixed(2)}`);

  const after1 = await page.evaluate(() => window.grab('remote'));
  await sleep(600);
  const after2 = await page.evaluate(() => window.grab('remote'));
  const afterMotion = motion(after1, after2);
  check('Live video returns after the effect', afterMotion > Math.max(15, holdMotion * 3), `motion ${afterMotion.toFixed(2)} (frozen plate was ${holdMotion.toFixed(2)})`);
  check('Camera track stayed live the whole time', await page.evaluate(() => window.track.readyState === 'live'));
  const afterBlue = blueExcess(after2);
  check('Blue tint is gone after the effect', Math.abs(afterBlue - baseBlue) < (peakBlue - baseBlue) * 0.4, `${baseBlue.toFixed(1)} before, ${afterBlue.toFixed(1)} after`);

  // -------------------------------------------- real photos through the models
  if (imagesDir) {
    const engineFrame = page.frames().find((f) => f.url().startsWith('chrome-extension://') && f.url().endsWith('engine/engine.html'));
    check('Engine iframe is present', Boolean(engineFrame));
    const model = await engineFrame.evaluate(async (base) => {
      const { HandDetector, PersonSegmenter } = await import('../gesture/handDetection.js');
      const { matchSign, describeHand } = await import('../gesture/gestureRecognition.js');
      const { SIGNS } = await import('../gesture/signs.js');
      const load = async (name) => {
        const response = await fetch(`${base}/img/${name}`);
        if (!response.ok) return null;
        const bitmap = await createImageBitmap(await response.blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const out = { hands: {}, segmentation: null };
      const detector = new HandDetector();
      await detector.init();
      let ts = 1;
      for (const name of ['victory.jpg', 'pointing_up.jpg', 'fist.jpg', 'thumb_up.jpg']) {
        const image = await load(name);
        if (!image) continue;
        let hands = [];
        for (let i = 0; i < 3; i++) hands = detector.detect(image, (ts += 40)); // let tracking settle
        const f = hands[0] && describeHand(hands[0], image.width / image.height);
        const deg = (a, b) => (Math.acos((a.x * b.x + a.y * b.y + a.z * b.z) / (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z))) * 180) / Math.PI;
        const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        out.hands[name] = {
          features: f && {
            flexion: Object.fromEntries(Object.entries(f.fingers).map(([k, v]) => [k, Math.round(v.flexionDeg)])),
            indexMiddleAngle: +deg(f.fingers.index.direction3d, f.fingers.middle.direction3d).toFixed(1),
            tipGap: +(gap(f.fingers.index.tip3d, f.fingers.middle.tip3d) / f.size3d).toFixed(2),
          },
          count: hands.length,
          matchesSeal: matchSign(SIGNS.confrontation, hands, { aspect: image.width / image.height, tolerance: 1.25 }),
        };
      }
      detector.close();
      const portrait = await load('portrait.jpg');
      if (portrait) {
        const segmenter = new PersonSegmenter();
        await segmenter.init();
        const mask = segmenter.segment(portrait, (ts += 40));
        segmenter.close();
        const at = (u, v) => mask.alpha[Math.floor(v * mask.height) * mask.width + Math.floor(u * mask.width)];
        out.segmentation = { center: at(0.5, 0.6), corner: at(0.03, 0.03), size: `${mask.width}x${mask.height}` };
      }
      return out;
    }, origin);

    for (const [name, r] of Object.entries(model.hands)) {
      check(`Real photo ${name}: hand found`, r.count >= 1, `${r.count} hand(s) ${JSON.stringify(r.features)}`);
      check(`Real photo ${name}: is NOT mistaken for the seal (even at high sensitivity)`, r.matchesSeal === false);
    }
    if (model.segmentation) {
      const s = model.segmentation;
      check('Real portrait: person mask marks the person, not the background', s.center > 200 && s.corner < 60, `centre ${s.center}, corner ${s.corner}, mask ${s.size}`);
    }
  }

  // ------------------------------------------------- stop / clone semantics
  const lifecycle = await page.evaluate(async () => {
    const manager = globalThis.__shinobiMeet.manager;
    const pipeline = [...manager.pipelines][0];
    const clone = window.track.clone();
    const cloneOk = clone.getSettings().width === 1280 && clone.label === window.track.label;
    window.track.stop();
    const afterFirstStop = { pipelines: manager.pipelines.size, camera: pipeline.original.readyState };
    clone.stop();
    const afterAllStopped = { pipelines: manager.pipelines.size, camera: pipeline.original.readyState };
    return { cloneOk, afterFirstStop, afterAllStopped };
  });
  check('Cloned track also looks like the camera', lifecycle.cloneOk);
  check('Camera stays on while any copy of the track is in use', lifecycle.afterFirstStop.pipelines === 1 && lifecycle.afterFirstStop.camera === 'live');
  check('Camera is released when the page stops the last copy', lifecycle.afterAllStopped.pipelines === 0 && lifecycle.afterAllStopped.camera === 'ended');

  // ---------------------------------------------------- disabled = untouched
  const worker = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 10000 });
  const sw = await worker.worker();
  await sw.evaluate(() => chrome.storage.sync.set({ enabled: false }));
  await sleep(500);
  const disabledKind = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const kind = stream.getVideoTracks()[0].constructor.name;
    stream.getTracks().forEach((t) => t.stop());
    return kind;
  });
  check('When disabled, the page gets the raw camera track untouched', disabledKind === 'MediaStreamTrack', disabledKind);
  await sw.evaluate(() => chrome.storage.sync.set({ enabled: true }));
} catch (error) {
  check('Test run completed without exceptions', false, error.stack || String(error));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
