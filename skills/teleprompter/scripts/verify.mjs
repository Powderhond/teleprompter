#!/usr/bin/env node
/**
 * End-to-end check for the teleprompter, driven by a headless Chromium with
 * synthetic camera and microphone devices.
 *
 *   node scripts/verify.mjs
 *   node scripts/verify.mjs --headed     # watch it happen
 *
 * It exercises the whole chain the way a person does: pick devices, render the
 * script, switch on segmentation and the gaze meter, record a few seconds,
 * submit the take, then assert the files actually landed on disk. Screenshots
 * go into the session folder as evidence.
 */

import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4499;
const HEADED = process.argv.includes('--headed');

const SCRIPT = `# Verification read

This is the first block, and it carries enough words to make the pace maths
mean something when the engine turns them into a scroll velocity.

(( glance at the lens marker here ))

Second block, shorter.

---

Last block, so the end of the script is reachable inside a short take.
`;

const require = createRequire(import.meta.url);
const checks = [];
let serverLog = '';
const consoleErrors = [];

/**
 * Contrast has to be measured on painted pixels, not on computed CSS. A
 * translucent overlay or a stray mask dims the glyphs while getComputedStyle
 * still cheerfully reports white.
 */
function brightestIn(raw, info, x0, x1, y0, y1) {
  let max = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * info.width + x) * info.channels;
      const lum = (raw[i] + raw[i + 1] + raw[i + 2]) / 3;
      if (lum > max) max = lum;
    }
  }
  return max;
}
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server never became healthy');
}

async function main() {
  const { chromium } = await import('playwright');

  const workdir = await mkdtemp(path.join(tmpdir(), 'teleprompter-verify-'));
  const scriptFile = path.join(workdir, 'script.md');
  const outRoot = path.join(workdir, 'out');
  await writeFile(scriptFile, SCRIPT, 'utf8');

  const server = spawn(
    process.execPath,
    [
      path.join(HERE, 'server.mjs'),
      '--task', 'verification read',
      '--script', scriptFile,
      '--out', outRoot,
      '--port', String(PORT),
      '--no-open',
    ],
    { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  // --- the launcher, before anything else
  // The server has to outlive the thing that started it: a session is minutes
  // of reading and re-reading, and whatever launched it is usually gone long
  // before that. These checks run a real detached launch in its own directory.
  const launchOut = path.join(workdir, 'launched');
  const launchPort = 4590;
  const launcher = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'launch.mjs'), '--out', launchOut, ...args], {
      cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });

  const launched = await launcher(['--task', 'launcher check', '--port', String(launchPort), '--no-open']);
  check('the launcher starts the server and returns', launched.code === 0 && /Teleprompter ready/.test(launched.out),
    launched.out.replace(/\s+/g, ' ').trim().slice(0, 80));

  // The launching process has exited by now, so anything still answering is
  // genuinely detached rather than a child holding the port open.
  const detachedAlive = await (async () => {
    for (let port = launchPort; port < launchPort + 20; port += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) return await res.json();
      } catch { /* next */ }
    }
    return null;
  })();
  check('the server outlives the command that launched it', Boolean(detachedAlive?.ok),
    detachedAlive?.sessionId ?? 'nothing answered');

  const again = await launcher(['--task', 'second', '--port', String(launchPort), '--no-open']);
  check('launching twice reuses the running session rather than piling up',
    /Already running/.test(again.out), again.out.replace(/\s+/g, ' ').trim().slice(0, 60));

  const stopped = await launcher(['--stop']);
  check('the launcher can stop it again', /stopped/.test(stopped.out),
    stopped.out.replace(/\s+/g, ' ').trim().slice(0, 60));

  let browser;
  try {
    const health = await waitForHealth(PORT);
    check('server starts and answers /api/health', Boolean(health.sessionId), health.sessionId);

    // --- the guards a public localhost server needs
    // fetch() cannot forge a Host header, so these go through node:http. Each case
    // was confirmed to come back 200 or 404 on the server before the guards existed.
    const raw = ({ method = 'GET', route = '/api/health', headers = {}, body }) => new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port: PORT, method, path: route, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', () => resolve(0));
      if (body) req.write(body);
      req.end();
    });
    const own = `localhost:${PORT}`;
    check('a request addressed to another hostname is refused (DNS rebinding)',
      (await raw({ route: '/api/session', headers: { host: `attacker.test:${PORT}` } })) === 403);
    check('a write from another site is refused',
      (await raw({ method: 'POST', route: '/api/script', headers: { host: own, origin: 'https://attacker.test', 'content-type': 'text/plain' }, body: '{"text":"x"}' })) === 403);
    check('a write from another local port is refused',
      (await raw({ method: 'POST', route: '/api/script', headers: { host: own, origin: 'http://localhost:1', 'content-type': 'text/plain' }, body: '{"text":"x"}' })) === 403);
    check('a path escape into a sibling folder is refused',
      (await raw({ route: '/app/..%2Fapp-other%2Fx', headers: { host: own } })) === 403);
    check('the page itself is still served', (await raw({ route: '/', headers: { host: own } })) === 200);

    browser = await chromium.launch({
      headless: !HEADED,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['camera', 'microphone'],
    });
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err?.message ?? err)));

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    // The panel ships with some sections collapsed; a person clicks the summary,
    // the harness just opens them all.
    await page.evaluate(() => {
      document.querySelectorAll('#panel details').forEach((d) => { d.open = true; });
    });

    // --- script rendering and pace maths
    await page.waitForSelector('#scriptBody .blk', { timeout: 10000 });
    const blocks = await page.locator('#scriptBody .blk').count();
    check('script parses into blocks', blocks >= 5, `${blocks} blocks`);

    const direction = await page.locator('#scriptBody .blk-direction').count();
    check('double-paren directions become their own block', direction === 1, `${direction} found`);

    const heading = await page.locator('#scriptBody .blk-heading').count();
    check('hash heading is not read aloud', heading === 1, `${heading} found`);

    const estimate = await page.locator('#estimate').textContent();
    check('pace estimate is computed', /\d+ spoken words, about \d+:\d\d/.test(estimate ?? ''), estimate?.trim());

    // --- devices
    // boot() sets this once the devices are open, which removes the race between
    // the script rendering and the camera actually starting.
    const booted = await page
      .waitForFunction(() => document.body.dataset.booted, { timeout: 30000 })
      .then((handle) => handle.jsonValue())
      .catch(() => 'timeout');
    check('app finishes booting with device access', booted === 'ready', booted);

    // Headless Chromium's synthetic camera is usable but often absent from
    // enumerateDevices, so assert the picker agrees with the browser rather than
    // assuming a device count. A real machine reports its real gear here.
    const reported = await page.evaluate(async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        video: devices.filter((d) => d.kind === 'videoinput').length,
        audio: devices.filter((d) => d.kind === 'audioinput').length,
      };
    });
    const videoOptions = await page.locator('#selVideo option').count();
    const audioOptions = await page.locator('#selAudio option').count();
    check('camera picker matches what the browser reports',
      videoOptions === Math.max(1, reported.video),
      `${reported.video} device(s), ${videoOptions} option(s)`);
    check('microphone picker matches what the browser reports',
      audioOptions === Math.max(1, reported.audio),
      `${reported.audio} device(s), ${audioOptions} option(s)`);

    const live = (await page.locator('#deviceNote').textContent())?.trim();
    check('stream opens and reports its frame size', /Live: \d+x\d+/.test(live ?? ''), live);

    const mime = await page.evaluate(() => {
      const candidates = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
      ];
      return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    });
    check('a recordable container is available', Boolean(mime), mime);

    await page.screenshot({ path: path.join(workdir, 'studio.png') });

    // --- perform mode moves the band to the lens
    const focusBefore = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--focus-y'));
    await page.locator('#btnPerform').click();
    await page.waitForTimeout(600);
    const focusAfter = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--focus-y'));
    // The band no longer jumps on going live, because it is already where the
    // position picker put it. What perform mode does now is clear the panel and
    // give the words the full width.
    const stageWidth = await page.evaluate(() => document.getElementById('stage').getBoundingClientRect().width);
    check(
      'going live keeps the band where you put it and widens the stage',
      Math.abs(parseFloat(focusAfter) - parseFloat(focusBefore)) < 20 && stageWidth > 1300,
      `band ${focusBefore.trim()} to ${focusAfter.trim()}, stage ${stageWidth.toFixed(0)}px`,
    );
    // Scroll into the body of the script so the screenshot shows the active and
    // already-read states, not just the opening heading.
    await page.keyboard.press(' ');
    await page.waitForTimeout(3500);
    await page.keyboard.press(' ');
    // The position picker has to actually move the words, not just light up.
    const placed = await page.evaluate(async () => {
      const read = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--focus-y'));
      const click = (x, y) => document.querySelector(`#placeGrid button[data-x="${x}"][data-y="${y}"]`).click();
      click('0.5', '0.07');
      await new Promise((r) => setTimeout(r, 350));
      const top = read();
      click('0.5', '0.78');
      await new Promise((r) => setTimeout(r, 350));
      const bottom = read();
      const fade = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fade-y'));
      click('0.5', '0.07');
      await new Promise((r) => setTimeout(r, 350));
      return { top, bottom, fade, pressed: document.querySelectorAll('#placeGrid button[aria-pressed="true"]').length };
    });
    check('the position picker moves the reading band down the screen',
      placed.bottom > placed.top + 100, `${placed.top.toFixed(0)}px to ${placed.bottom.toFixed(0)}px`);
    check('the fade stays clear of the band when the words sit low',
      placed.fade > placed.bottom + 20, `band ${placed.bottom.toFixed(0)}px, fade ${placed.fade.toFixed(0)}px`);
    check('exactly one position reads as selected', placed.pressed === 1, `${placed.pressed} selected`);

    // Fullscreen. Headless may refuse it, so what is checked is that the button
    // is wired and that a refusal is reported rather than swallowed.
    // Going live already asked for fullscreen, so the button's job here is to
    // toggle. Asserting that it calls requestFullscreen specifically was wrong:
    // from a fullscreen page the correct call is exitFullscreen, and the check
    // failed against a button that worked.
    const before = await page.evaluate(() => Boolean(document.fullscreenElement));
    const hasButton = await page.locator('#btnFullscreen').count();
    check('there is a fullscreen control', hasButton === 1);
    if (hasButton) await page.locator('#btnFullscreen').click();
    await page.waitForTimeout(800);
    const fs = await page.evaluate(() => ({
      now: Boolean(document.fullscreenElement),
      label: document.getElementById('btnFullscreen')?.textContent,
      enabled: document.fullscreenEnabled,
    }));
    check('the fullscreen button toggles fullscreen', fs.now !== before,
      `${before ? 'on' : 'off'} to ${fs.now ? 'on' : 'off'}`);
    check('the control says which way it will go',
      fs.label === (fs.now ? 'Exit fullscreen' : 'Fullscreen'), `reads "${fs.label}"`);

    // Leave it off so the screenshot below is the normal view.
    if (fs.now) {
      await page.locator('#btnFullscreen').click();
      await page.waitForTimeout(500);
    }

    const performShot = path.join(workdir, 'perform.png');
    await page.screenshot({ path: performShot });

    // The reading band has to be legible from across a room.
    const band = await page.evaluate(() => {
      const active = document.querySelector('#scriptBody .blk.active');
      if (!active) return null;
      const r = active.getBoundingClientRect();
      return { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)),
               w: Math.round(r.width), h: Math.round(r.height) };
    });
    if (band && band.h > 0) {
      const sharp = require('sharp');
      const { data, info } = await sharp(performShot).raw().toBuffer({ resolveWithObject: true });
      const lum = brightestIn(data, info, band.x, Math.min(info.width, band.x + band.w),
        band.y, Math.min(info.height, band.y + band.h));
      check('active line is actually painted bright, not just computed bright',
        lum > 180, `brightest glyph pixel ${lum.toFixed(0)}/255`);
    } else {
      check('active line is actually painted bright, not just computed bright', false, 'no active block');
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // --- the scroll engine actually advances
    const scrollBefore = await page.evaluate(() => document.getElementById('scrollInner').style.transform);
    await page.keyboard.press(' ');
    await page.waitForTimeout(1200);
    await page.keyboard.press(' ');
    const scrollAfter = await page.evaluate(() => document.getElementById('scrollInner').style.transform);
    check('scroll advances while playing', scrollBefore !== scrollAfter, `${scrollBefore} to ${scrollAfter}`);
    await page.evaluate(() => document.getElementById('btnRestart').click());

    // --- segmentation
    await page.locator('#bgModes button[data-bg="blur"]').click();
    const composited = await page
      .waitForSelector('#pip.composited', { timeout: 45000 })
      .then(() => true)
      .catch(() => false);
    check('background segmentation loads and takes over the preview', composited,
      (await page.locator('#bgNote').textContent())?.trim());

    if (composited) {
      await page.waitForTimeout(2500);
      const painted = await page.evaluate(() => {
        const canvas = document.getElementById('composite');
        if (!canvas.width) return { drawn: false };
        const probe = document.createElement('canvas');
        probe.width = 64;
        probe.height = 36;
        const ctx = probe.getContext('2d');
        ctx.drawImage(canvas, 0, 0, 64, 36);
        const { data } = ctx.getImageData(0, 0, 64, 36);
        let min = 255;
        let max = 0;
        for (let i = 0; i < data.length; i += 4) {
          const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
          if (lum < min) min = lum;
          if (lum > max) max = lum;
        }
        return { drawn: true, min, max, spread: max - min, width: canvas.width, height: canvas.height };
      });
      check('composited canvas carries real pixels', painted.drawn && painted.spread > 6,
        `${painted.width}x${painted.height}, luminance spread ${painted.spread?.toFixed?.(0)}`);
    }

    // --- gaze meter
    await page.locator('#btnGaze').click();
    const gazeUp = await page
      .waitForFunction(() => {
        const note = document.getElementById('gazeNote').textContent ?? '';
        return /Calibrate|baseline/i.test(note) || /failed/i.test(note);
      }, { timeout: 45000 })
      .then(() => true)
      .catch(() => false);
    const gazeNote = (await page.locator('#gazeNote').textContent())?.trim();
    check('gaze model loads', gazeUp && !/failed/i.test(gazeNote ?? ''), gazeNote);

    const hudLive = await page
      .waitForFunction(() => {
        const text = document.getElementById('gazeScore').textContent ?? '';
        return text && text !== '--';
      }, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    // The synthetic camera shows a rolling pattern, so "no face" is the correct
    // reading here. What matters is that the meter is running every frame.
    check('gaze meter produces a reading each frame', hudLive,
      (await page.locator('#gazeScore').textContent())?.trim());

    await page.screenshot({ path: path.join(workdir, 'effects.png') });

    // --- record, save, submit
    await page.locator('#btnRecord').click();
    await page.waitForFunction(() => document.body.dataset.state === 'recording', { timeout: 15000 });
    check('recording starts after the countdown', true);
    await page.waitForTimeout(4000);
    await page.locator('#btnRecord').click();

    const saved = await page
      .waitForFunction(() => {
        const button = document.querySelector('#takeList .take button.primary');
        return button && !button.disabled;
      }, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    check('take uploads and becomes submittable', saved,
      (await page.locator('#takeList .take-meta').first().textContent())?.trim());

    const sessionDirs = await readdir(outRoot);
    const sessionDir = path.join(outRoot, sessionDirs.find((d) => d !== 'latest.json') ?? '');
    const filesAfterRecord = await readdir(sessionDir);
    check('media file written to the session folder',
      filesAfterRecord.some((f) => /^take-01\.(mp4|webm|weba|m4a)$/.test(f)),
      filesAfterRecord.filter((f) => f.startsWith('take-01')).join(', '));
    check('cue track written as WebVTT', filesAfterRecord.includes('take-01.vtt'));

    if (filesAfterRecord.includes('take-01.vtt')) {
      const vtt = await readFile(path.join(sessionDir, 'take-01.vtt'), 'utf8');
      check('WebVTT has a timed cue', /^WEBVTT/.test(vtt) && /\d\d:\d\d:\d\d\.\d\d\d --> /.test(vtt),
        `${vtt.split('\n').length} lines`);
    }

    const meta = JSON.parse(await readFile(path.join(sessionDir, 'take-01.json'), 'utf8'));
    check('take metadata records duration, pace and gaze',
      meta.durationSec > 1 && meta.wpm > 0 && meta.gaze !== undefined,
      `${meta.durationSec?.toFixed(1)}s at ${meta.wpm} wpm`);

    await page.locator('#takeList .take button.primary').click();
    // Generous: the segmentation and gaze loops keep the main thread busy, so a
    // click can sit in the queue for a while on a loaded machine.
    await page.waitForSelector('#submitDialog[open]', { timeout: 20000 });
    await page.locator('#submitNote').fill('verification run');
    await page.locator('#btnConfirmSubmit').click();

    const submittedOk = await page
      .waitForFunction(() => document.querySelector('#takeList .take.submitted') !== null, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check('submit marks the take as handed back', submittedOk);

    const submission = JSON.parse(await readFile(path.join(sessionDir, 'submission.json'), 'utf8'));
    check('submission manifest points at the media',
      Boolean(submission.media) && submission.note === 'verification run',
      path.basename(submission.media ?? ''));

    const latest = JSON.parse(await readFile(path.join(outRoot, 'latest.json'), 'utf8'));
    check('latest.json lets the agent find the take without watching stdout',
      latest.media === submission.media);

    check('server printed a submission block for the calling session',
      serverLog.includes('=== TELEPROMPTER SUBMISSION ==='));

    await page.screenshot({ path: path.join(workdir, 'submitted.png') });

    // MediaPipe writes its delegate banner to console.error; it is a status line,
    // not a failure.
    // --- the container guard
    // This is the failure that bit in real use: Chrome's MP4 recorder stopped
    // emitting the ftyp/moov initialisation segment once its hardware encoder
    // had been reused, and every take after the second was a run of bare moof
    // fragments. Right size, right duration, would not open anywhere. The test
    // builds that exact file from a healthy one and checks we catch and fix it.
    const container = await page.evaluate(async () => {
      const { inspectContainer, initSegmentLength, probePlayable } = await import('/app/capture.js');
      const good = await (await fetch('/api/takes/take-01/media')).blob();
      const initLen = await initSegmentLength(good);
      if (!initLen) return { initLen: 0 };

      const init = good.slice(0, initLen);
      const headless = good.slice(initLen);                       // what the bug produces
      const repaired = new Blob([init, headless], { type: 'video/mp4' });

      const probe = async (blob) => {
        const url = URL.createObjectURL(blob);
        const res = await probePlayable(url, 7000);
        URL.revokeObjectURL(url);
        return res.ok;
      };

      return {
        initLen,
        good: await inspectContainer(good),
        headless: await inspectContainer(headless),
        repaired: await inspectContainer(repaired),
        headlessPlays: await probe(headless),
        repairedPlays: await probe(repaired),
      };
    });

    check('init segment is located in a healthy recording',
      container.initLen > 0, `${container.initLen} bytes of ftyp+moov`);
    check('a healthy recording passes the container check',
      container.good?.valid === true && container.good?.tag === 'ftyp');
    check('a recording missing its header is caught, not saved as fine',
      container.headless?.valid === false, `first atom "${container.headless?.tag}"`);
    check('that broken shape really is unplayable, so the check is not theatre',
      container.headlessPlays === false);
    check('splicing the session init segment back on makes it play again',
      container.repaired?.valid === true && container.repairedPlays === true);

    // --- the warp maths, on a synthetic face
    // No camera and no real face: draw two eyes with the irises sitting low, as
    // if reading, warp them with a baseline of "centred", and measure what moved.
    // The symmetry check is the regression guard for the sign bug that made a
    // calibrated baseline pull one eye toward the lens and push the other away.
    const warp = await page.evaluate(async () => {
      const { warpFrame, warpEye, ShiftSmoother } = await import('/app/gaze-correct.js');
      const { EYE_SPECS } = await import('/app/vision.js');

      const W = 480;
      const H = 190;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      const rx = 62;
      const ry = 27;
      const irisR = 17;
      const drop = 13;                       // how far the iris sits below centre
      // Corner handedness has to match the real face mesh or this fixture cannot
      // see the bug it exists to guard. On the subject's right eye the outer
      // corner (33) sits at the SMALLER x; on the left eye the outer corner
      // (263) sits at the larger one. Getting that backwards here made the
      // check pass against a deliberately reintroduced sign bug.
      const eyes = [
        { spec: EYE_SPECS[0], cx: 130, cy: 95, outerSide: -1 },
        { spec: EYE_SPECS[1], cx: 350, cy: 95, outerSide: +1 },
      ];

      const draw = () => {
        ctx.fillStyle = '#c79b7d';
        ctx.fillRect(0, 0, W, H);
        for (const { cx, cy } of eyes) {
          ctx.save();
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.clip();
          ctx.fillStyle = '#f1f1ef';
          ctx.fillRect(0, 0, W, H);
          // Veins, so a displacement in the sclera is actually detectable.
          ctx.strokeStyle = '#d98f8f';
          ctx.lineWidth = 1;
          for (let i = 0; i < 14; i += 1) {
            ctx.beginPath();
            ctx.moveTo(cx - rx + i * 9, cy - ry);
            ctx.lineTo(cx - rx + i * 7, cy + ry);
            ctx.stroke();
          }
          ctx.fillStyle = '#20303a';
          ctx.beginPath();
          ctx.arc(cx, cy + drop, irisR, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#05080a';
          ctx.beginPath();
          ctx.arc(cx, cy + drop, irisR * 0.45, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      };

      const points = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
      const put = (i, x, y) => { points[i] = { x: x / W, y: y / H }; };
      for (const { spec, cx, cy, outerSide } of eyes) {
        spec.ring.forEach((idx, n) => {
          const a = (n / spec.ring.length) * Math.PI * 2;
          put(idx, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
        });
        put(spec.outer, cx + outerSide * rx, cy);
        put(spec.inner, cx - outerSide * rx, cy);
        put(spec.top, cx, cy - ry);
        put(spec.bottom, cx, cy + ry);
        put(spec.iris[0], cx, cy + drop);
        spec.iris.slice(1).forEach((idx, n) => {
          const a = (n / 4) * Math.PI * 2;
          put(idx, cx + Math.cos(a) * irisR, cy + drop + Math.sin(a) * irisR);
        });
      }

      // Centroid of the dark iris inside one eye's box.
      const pupil = (cx) => {
        const { data } = ctx.getImageData(cx - rx, 0, rx * 2, H);
        const w = rx * 2;
        let sx = 0;
        let sy = 0;
        let n = 0;
        for (let y = 0; y < H; y += 1) {
          for (let x = 0; x < w; x += 1) {
            const i = (y * w + x) * 4;
            if (data[i] < 90 && data[i + 2] > data[i]) { sx += x; sy += y; n += 1; }
          }
        }
        return n ? { x: sx / n, y: sy / n, n } : null;
      };

      draw();
      const before = eyes.map((e) => pupil(e.cx));
      const result = warpFrame(ctx, points, W, H, { hx: 0, vy: 0 }, 1);
      const after = eyes.map((e) => pupil(e.cx));

      // The horizontal case is the one that matters for the sign convention.
      // A vertical-only baseline cannot catch it, because the signed eye width
      // cancels itself out when the horizontal target is zero. With a sideways
      // target it does not, and the two eyes used to move in opposite
      // directions for the same instruction.
      draw();
      const sideBefore = eyes.map((e) => pupil(e.cx));
      warpFrame(ctx, points, W, H, { hx: 0.12, vy: drop / (ry * 2) }, 1);
      const sideAfter = eyes.map((e) => pupil(e.cx));
      const sideways = sideBefore.map((b, i) => (b && sideAfter[i] ? sideAfter[i].x - b.x : null));

      // Nothing outside either eye opening may change.
      const warped = ctx.getImageData(0, 0, W, H).data;
      draw();
      const plain = ctx.getImageData(0, 0, W, H).data;
      let skinTouched = 0;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const inside = eyes.some(({ cx, cy }) => {
            const nx = (x - cx) / rx;
            const ny = (y - cy) / ry;
            return nx * nx + ny * ny < 1.06;
          });
          if (inside) continue;
          const i = (y * W + x) * 4;
          if (Math.abs(warped[i] - plain[i]) > 4 || Math.abs(warped[i + 1] - plain[i + 1]) > 4) {
            skinTouched += 1;
          }
        }
      }

      // An absurd ask must not produce an absurd move.
      draw();
      const silly = warpEye(ctx, points, EYE_SPECS[0], W, H, { hx: 0, vy: -4 }, 1);

      // Temporal smoothing: a jittery measurement must come out calmer than it
      // went in, which is what stops the warp shimmering frame to frame.
      const jitter = [];
      for (let i = 0; i < 60; i += 1) jitter.push(4 + (i % 2 ? 1.6 : -1.6));
      const smoother = new ShiftSmoother(0.3);
      const smoothed = jitter.map((v) => smoother.smooth('k', v, 0).dx);
      const spread = (xs) => {
        const tail = xs.slice(20);
        const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
        return Math.sqrt(tail.reduce((a, b) => a + (b - mean) ** 2, 0) / tail.length);
      };

      return {
        sideways,
        rises: before.map((b, i) => (b && after[i] ? b.y - after[i].y : null)),
        kept: before.map((b, i) => (b && after[i] ? after[i].n / b.n : null)),
        skinTouched,
        maxShift: result.maxShift,
        bothEyes: result.bothEyes,
        cap: irisR * 0.55,
        sillyShift: silly,
        jitterSpread: spread(jitter),
        smoothedSpread: spread(smoothed),
        asked: drop,
      };
    });

    const [riseR, riseL] = warp.rises;
    check('warp moves the iris toward the lens baseline',
      riseR > 3 && riseL > 3, `right eye ${riseR?.toFixed(1)} px, left eye ${riseL?.toFixed(1)} px`);
    check('both eyes move together, not in opposite directions',
      warp.bothEyes && Math.abs(riseR - riseL) < 1.5,
      `difference ${Math.abs(riseR - riseL).toFixed(2)} px`);
    const [sideR, sideL] = warp.sideways;
    check('a sideways baseline moves both eyes the same way, not apart',
      Math.sign(sideR) === Math.sign(sideL) && Math.abs(sideR) > 1 && Math.abs(sideL) > 1,
      `right eye ${sideR?.toFixed(1)} px, left eye ${sideL?.toFixed(1)} px`);

    check('warp keeps the iris intact rather than smearing it away',
      warp.kept.every((k) => k > 0.6 && k < 1.6),
      warp.kept.map((k) => k?.toFixed(2)).join(' / '));
    check('warp leaves the skin outside the eyes untouched',
      warp.skinTouched === 0, `${warp.skinTouched} pixels changed outside the openings`);
    check('an over-large ask is capped against the iris radius',
      warp.sillyShift > 0 && warp.sillyShift <= warp.cap + 0.01,
      `${warp.sillyShift.toFixed(1)} px against a cap of ${warp.cap.toFixed(1)}`);
    check('temporal smoothing calms a jittery measurement',
      warp.smoothedSpread < warp.jitterSpread * 0.4,
      `spread ${warp.jitterSpread.toFixed(2)} in, ${warp.smoothedSpread.toFixed(2)} out`);

    // --- many takes stay playable, which is the bug that bit in real use
    await page.evaluate(() => {
      document.querySelectorAll('#panel details').forEach((d) => { d.open = true; });
    });
    await page.locator('#bgModes button[data-bg="none"]').click();
    for (let i = 0; i < 3; i += 1) {
      await page.locator('#btnRecord').click();
      await page.waitForFunction(() => document.body.dataset.state === 'recording', { timeout: 20000 });
      await page.waitForTimeout(1500);
      await page.locator('#btnRecord').click();
      await page.waitForFunction(
        (n) => document.querySelectorAll('#takeList .take').length === n,
        i + 2,
        { timeout: 30000 },
      );
    }

    // A take plays from its in-memory blob until the upload lands, which is
    // deliberate so you can review it straight away. Wait for the handover.
    await page.waitForFunction(
      () => [...document.querySelectorAll('#takeList .take video')]
        .every((v) => (v.getAttribute('src') ?? '').startsWith('/api/takes/')),
      { timeout: 30000 },
    );

    const playable = await page.evaluate(async () => {
      const players = [...document.querySelectorAll('#takeList .take video')];
      // One at a time: four parallel loads make this flaky under CPU load, and
      // the thing under test is whether a take can open at all, not concurrency.
      const results = [];
      for (const p of players) {
        results.push(await new Promise((resolve) => {
          const src = p.getAttribute('src');
          if (p.readyState >= 1) { resolve({ src, ok: true }); return; }
          const done = (ok) => resolve({ src, ok, err: p.error?.code ?? null });
          p.addEventListener('loadedmetadata', () => done(true), { once: true });
          p.addEventListener('error', () => done(false), { once: true });
          p.preload = 'metadata';
          p.load();
          setTimeout(() => done(p.readyState >= 1), 15000);
        }));
      }
      return { count: players.length, results };
    });
    // Silence detection. The owner recorded 28 seconds with a dead microphone and
    // the app said nothing, so the only sign was a finished edit with no sound.
    // Both halves are checked: the live meter, and the take itself.
    const silence = await page.evaluate(async () => {
      const { measureLoudness } = await import('/app/capture.js');
      // Hand-built WAV, because a MediaRecorder clip of nothing does not always
      // decode and the thing under test is the measurement, not the recorder.
      const wav = (fill) => {
        const rate = 8000;
        const n = rate;
        const buf = new ArrayBuffer(44 + n * 2);
        const view = new DataView(buf);
        const ascii = (off, str) => [...str].forEach((ch, i) => view.setUint8(off + i, ch.charCodeAt(0)));
        ascii(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); ascii(8, 'WAVE');
        ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
        view.setUint16(22, 1, true); view.setUint32(24, rate, true);
        view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        ascii(36, 'data'); view.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i += 1) view.setInt16(44 + i * 2, fill(i, rate), true);
        return new Blob([buf], { type: 'audio/wav' });
      };

      const quiet = await measureLoudness(wav(() => 0));
      const loud = await measureLoudness(wav((i, rate) => Math.sin((2 * Math.PI * 440 * i) / rate) * 12000));
      return { quiet, loud };
    });
    check('a silent recording measures as silent',
      silence.quiet !== null && silence.quiet < 0.0005,
      silence.quiet === null ? 'would not decode' : `rms ${silence.quiet.toExponential(2)}`);
    check('a recording with sound on it does not', silence.loud !== null && silence.loud > 0.05,
      silence.loud === null ? 'would not decode' : `rms ${silence.loud.toFixed(3)}`);

    const meter = await page.evaluate(() => {
      const bar = document.getElementById('levelBar');
      const text = document.getElementById('levelText');
      return { present: Boolean(bar && text), text: text?.textContent, width: bar?.style.width };
    });
    check('the microphone level is on screen while setting up', meter.present && Boolean(meter.text),
      `reads "${meter.text}", bar ${meter.width || '0'}`);

    // The owner had to press F to find out where the words would land, and the
    // preview sat where it sat. Both now respond in the setup view.
    const placement = await page.evaluate(async () => {
      const read = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--focus-y'));
      const click = (x, y) => document.querySelector(`#placeGrid button[data-x="${x}"][data-y="${y}"]`).click();
      click('0.5', '0.07');
      await new Promise((r) => setTimeout(r, 300));
      const top = read();
      click('0.5', '0.78');
      await new Promise((r) => setTimeout(r, 300));
      const bottom = read();
      click('0.5', '0.07');
      await new Promise((r) => setTimeout(r, 300));
      return { top, bottom, perform: document.body.classList.contains('mode-perform') };
    });
    check('the words move where you put them without going live first',
      !placement.perform && placement.bottom > placement.top + 100,
      `in setup: ${placement.top.toFixed(0)}px to ${placement.bottom.toFixed(0)}px`);

    const pip = await page.evaluate(async () => {
      const el = document.getElementById('pip');
      const before = el.getBoundingClientRect().left;
      const stage = document.getElementById('stage').getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { clientX: before + 20, clientY: 200, bubbles: true, pointerId: 1 }));
      el.dispatchEvent(new PointerEvent('pointermove', { clientX: stage.left + 40, clientY: 150, bubbles: true, pointerId: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { clientX: stage.left + 40, clientY: 150, bubbles: true, pointerId: 1 }));
      await new Promise((r) => setTimeout(r, 200));
      return { before, after: el.getBoundingClientRect().left };
    });
    check('the camera preview can be dragged out of the way',
      Math.abs(pip.after - pip.before) > 20,
      `${pip.before.toFixed(0)}px to ${pip.after.toFixed(0)}px`);

    // The meter has to show a NUMBER, not merely exist. It existed for two
    // rounds while reading dead silence from a working microphone, because an
    // uninitialised peak made its arithmetic NaN and NaN compares false against
    // everything. Asserting presence would have passed the whole time.
    const level = await page.evaluate(async () => {
      const meter = document.getElementById('levelMeter');
      const text = document.getElementById('levelText');
      const bar = document.getElementById('levelBar');
      let bestRms = 0;
      let bestWidth = 0;
      const seen = new Set();
      for (let i = 0; i < 40; i += 1) {
        bestRms = Math.max(bestRms, Number(meter.dataset.rms || 0));
        bestWidth = Math.max(bestWidth, parseFloat(bar.style.width) || 0);
        seen.add(text.textContent);
        await new Promise((r) => setTimeout(r, 50));
      }
      return { bestRms, bestWidth, texts: [...seen], ctx: meter.dataset.ctx };
    });
    check('the meter hears the microphone', level.bestRms > 0.001,
      `peak rms ${level.bestRms.toFixed(4)}, context ${level.ctx}`);
    check('the meter puts a real number on screen',
      level.texts.some((t) => /-?\d+ dB/.test(t)) && level.bestWidth > 1,
      `${level.texts[0]}, bar ${level.bestWidth.toFixed(0)}%`);

    // The microphone must never be cloned or stopped. Cloning a live mic and
    // stopping the clone is legal and harmless against a synthetic device, and
    // on real Windows audio hardware it kept producing digitally silent takes.
    const audioPath = await page.evaluate(async () => {
      const cap = await import('/app/capture.js');
      const base = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const cloned = cap.cloneForRecording(base);
      const result = {
        clonesVideoOnly: cloned.getAudioTracks().length === 0 && cloned.getVideoTracks().length > 0,
      };

      const gate = new cap.SilenceGate();
      gate.attach(base);
      const tapped = gate.tap();
      result.tapGivesAudio = Boolean(tapped && tapped.getAudioTracks().length === 1);
      const micTrack = base.getAudioTracks()[0];
      // Stopping everything the recorder owns must leave the device alone.
      tapped?.getTracks().forEach((t) => t.stop());
      cloned.getTracks().forEach((t) => t.stop());
      result.micStillLive = micTrack.readyState === 'live';
      gate.detach();
      base.getTracks().forEach((t) => t.stop());
      return result;
    });
    check('recording clones video only, never the microphone', audioPath.clonesVideoOnly);
    check('the microphone is tapped through the audio graph', audioPath.tapGivesAudio);
    check('stopping what a take owns leaves the microphone running',
      audioPath.micStillLive, audioPath.micStillLive ? 'still live' : 'the device was stopped');

    const damaged = await page.locator('#takeList .take.damaged').count();
    check('no take came back damaged in a clean run', damaged === 0, `${damaged} damaged`);

    const failedPlays = playable.results.filter((r) => !r.ok);
    check('every take is playable, not just the first few',
      playable.count >= 4 && failedPlays.length === 0,
      `${playable.results.filter((r) => r.ok).length}/${playable.count} loaded` +
      (failedPlays.length ? `; failed: ${failedPlays.map((r) => `${r.src} err=${r.err}`).join(', ')}` : ''));
    check('takes stream from disk rather than from a blob held in the page',
      playable.results.every((r) => (r.src ?? '').startsWith('/api/takes/')),
      playable.results[0]?.src);

    const rangeStatus = await page.evaluate(async () => {
      const res = await fetch('/api/takes/take-02/media', { headers: { Range: 'bytes=0-1023' } });
      return { status: res.status, length: (await res.arrayBuffer()).byteLength };
    });
    check('media supports range requests, so scrubbing works',
      rangeStatus.status === 206 && rangeStatus.length === 1024,
      `HTTP ${rangeStatus.status}, ${rangeStatus.length} bytes`);

    // --- discard removes the file, not just the row
    const beforeDiscard = await readdir(sessionDir);
    // take-01 is already submitted, and a submitted take is deliberately not
    // discardable, so pick one that still offers the button.
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#takeList .take')];
      const card = cards.reverse().find((c) => !c.querySelector('button.danger').disabled);
      card.querySelector('button.danger').click();
    });
    await page.waitForFunction(
      (n) => document.querySelectorAll('#takeList .take').length === n,
      playable.count - 1,
      { timeout: 15000 },
    );
    const afterDiscard = await readdir(sessionDir);
    check('discard deletes the recording from disk',
      afterDiscard.length < beforeDiscard.length,
      `${beforeDiscard.length} files to ${afterDiscard.length}`);

    // --- the offline gaze pass
    // Correction no longer happens in the browser. The page asks the server to
    // run it, the server decodes every frame with ffmpeg, corrects each one and
    // re-encodes. The contract is driven directly here rather than through a
    // button click, so a layout change cannot quietly stop testing the pass.
    const button = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#takeList .take')];
      const found = cards
        .map((c) => [...c.querySelectorAll('button')].find((b) => b.textContent === 'Correct gaze'))
        .filter(Boolean);
      return { count: found.length, enabled: found.filter((b) => !b.disabled).length };
    });
    check('every take offers a gaze pass', button.count > 0 && button.enabled > 0,
      `${button.enabled}/${button.count} enabled`);

    const passed = await page.evaluate(async () => {
      const started = await fetch('/api/takes/take-01/gaze-pass', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strength: 0.6, lift: 0.26 }),
      }).then((r) => r.json());
      if (!started.jobId) return { ok: false, why: started.error ?? 'no job id' };

      const deadline = Date.now() + 240000;
      let last = null;
      const stages = [];
      let sawCount = false;
      while (Date.now() < deadline) {
        last = await fetch(`/api/jobs/${started.jobId}`).then((r) => r.json());
        if (last.stage && stages[stages.length - 1] !== last.stage) stages.push(last.stage);
        if (last.total > 1 && last.done > 0) sawCount = true;
        if (last.state !== 'running') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      return { ok: true, job: last, stages, sawCount };
    });

    check('the server accepts a gaze pass and reports a job', passed.ok, passed.why ?? '');
    if (passed.ok) {
      const job = passed.job ?? {};
      check('the pass finishes rather than hanging', job.state !== 'running', `state ${job.state}`);
      // The synthetic camera has no face in it, so refusing is the right answer.
      // What matters is that the refusal is legible and nothing is written.
      check('a take with no face is refused in plain words',
        job.state === 'done' || /detectable face/i.test(job.error ?? ''),
        (job.error ?? `state ${job.state}`).slice(0, 110));
      // The pass spends most of its time on one long phase. Without progress out
      // of it the page shows nothing for minutes, which reads as a hang, and the
      // owner killed a working pass because of exactly that.
      check('the pass reports progress while it works, not just at the end',
        passed.sawCount && passed.stages.length > 1,
        `stages seen: ${passed.stages.join(' > ') || 'none'}`);

      check('the pass reached the frames before deciding',
        /decoding|reading/.test(job.log ?? '') || job.state === 'done',
        (job.log ?? '').replace(/\s+/g, ' ').trim().slice(0, 90));
    }

    const fatal = consoleErrors.filter(
      (e) => !/favicon|Failed to load resource|^INFO:|XNNPACK|TensorFlow Lite/i.test(e),
    );
    check('no uncaught page errors', fatal.length === 0, fatal.slice(0, 2).join(' | '));

    console.log(`\n  Screenshots and session files: ${workdir}`);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length) {
    console.log('\n  Server log:\n' + serverLog.split('\n').map((l) => `    ${l}`).join('\n'));
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(`\n  verify crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
