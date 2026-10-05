#!/usr/bin/env node
/**
 * Visual QC for the gaze correction.
 *
 * Pulls real frames out of a take with ffmpeg, runs the warp on each one in a
 * browser, and builds a contact sheet of original, corrected, and an amplified
 * difference so artifacts are obvious rather than a matter of opinion.
 *
 * Frames come from ffmpeg rather than from a <video> in the page on purpose.
 * MediaRecorder's fragmented MP4 is not seekable and reports its duration
 * progressively, so driving playback to reach a known moment is unreliable and
 * was quietly giving back the wrong frames.
 *
 *   node scripts/qc-gaze.mjs --in <take.mp4>
 *   node scripts/qc-gaze.mjs --in <take.mp4> --strength 0.6 --lift 0.26
 *   node scripts/qc-gaze.mjs --in <take.mp4> --frames 8 --eye left
 *
 * Options:
 *   --in <file>        take to inspect (required)
 *   --against <file>   compare against an already-corrected file instead of
 *                      warping in the browser. Crops are located by landmarks on
 *                      the original, so both sides are the same pixels.
 *   --strength <0..1>  correction strength (default 0.6)
 *   --lift <n>         how far to ask the eyes to come up, in eye heights (default 0.26)
 *   --frames <n>       how many frames to sample (default 5)
 *   --eye left|right|both   which eye to zoom (default both)
 *   --out <dir>        where to write the sheet (default beside the take)
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, mkdir, copyFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE_DIR = path.join(HERE, 'vendor', '__qc');

function parseArgs(argv) {
  const out = { in: '', against: '', strength: 0.6, lift: 0.26, frames: 5, eye: 'both', out: '', port: 4540, zoom: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case '--in': out.in = next() ?? ''; break;
      case '--against': out.against = next() ?? ''; break;
      case '--zoom': out.zoom = Number(next()); break;
      case '--strength': out.strength = Number(next()); break;
      case '--lift': out.lift = Number(next()); break;
      case '--frames': out.frames = Number(next()); break;
      case '--eye': out.eye = next() ?? 'both'; break;
      case '--out': out.out = next() ?? ''; break;
      case '--port': out.port = Number(next()); break;
      default: break;
    }
  }
  return out;
}

/** Every ffmpeg build winget has unpacked, whatever its version folder is called. */
async function wingetFfmpeg() {
  const root = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  try {
    const found = [];
    for (const pkg of (await readdir(root)).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
      for (const build of await readdir(path.join(root, pkg))) {
        found.push(path.join(root, pkg, build, 'bin', 'ffmpeg.exe'));
      }
    }
    return found;
  } catch {
    return [];
  }
}

async function resolveFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(HERE, 'vendor', 'bin', 'ffmpeg.exe'),
    ...(process.platform === 'win32' ? await wingetFfmpeg() : []),
    'ffmpeg',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const ok = await new Promise((resolve) => {
      const child = spawn(candidate, ['-version'], { stdio: 'ignore', shell: process.platform === 'win32' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
    if (ok) return candidate;
  }
  throw new Error('ffmpeg not found. Set FFMPEG_PATH, or install it: winget install --id Gyan.FFmpeg -e (Windows), brew install ffmpeg (macOS), or your package manager (Linux).');
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32' });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stderr) : reject(new Error(stderr.slice(-800)))));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.in) throw new Error('--in <take.mp4> is required');
  const source = path.resolve(opts.in);
  await stat(source);

  const ffmpeg = await resolveFfmpeg();
  console.log(`  ffmpeg    ${ffmpeg}`);
  console.log(`  take      ${source}`);

  // Even samples across the take, skipping the first moment where people settle.
  const work = await mkdtemp(path.join(tmpdir(), 'qc-gaze-'));
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', source,
    '-vf', `select='not(mod(n\\,${Math.max(1, Math.round(60 / opts.frames))}))',scale=1280:-2`,
    '-fps_mode', 'passthrough', '-frames:v', String(opts.frames),
    '-q:v', '2', path.join(work, 'f_%02d.png'),
  ]);
  const frames = (await readdir(work)).filter((f) => f.endsWith('.png')).sort();
  if (!frames.length) throw new Error('ffmpeg produced no frames');
  console.log(`  frames    ${frames.length}`);

  // When comparing two files, pull the same frame numbers out of both so the
  // crop lands on identical pixels rather than on whatever ffmpeg felt like.
  let againstFrames = [];
  if (opts.against) {
    const againstDir = path.join(work, 'against');
    await mkdir(againstDir, { recursive: true });
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', path.resolve(opts.against),
      '-vf', `select='not(mod(n\,${Math.max(1, Math.round(60 / opts.frames))}))'`,
      '-fps_mode', 'passthrough', '-frames:v', String(opts.frames),
      '-q:v', '2', path.join(againstDir, 'g_%02d.png'),
    ]);
    againstFrames = (await readdir(againstDir)).filter((f) => f.endsWith('.png')).sort();
    if (againstFrames.length !== frames.length) {
      console.log(`  WARNING   ${frames.length} frames from the take, ${againstFrames.length} from the comparison`);
    }
  }

  await rm(SERVE_DIR, { recursive: true, force: true });
  await mkdir(SERVE_DIR, { recursive: true });
  for (const f of frames) await copyFile(path.join(work, f), path.join(SERVE_DIR, f));
  for (const f of againstFrames) await copyFile(path.join(work, 'against', f), path.join(SERVE_DIR, f));

  const server = spawn(process.execPath, [
    path.join(HERE, 'server.mjs'), '--task', 'qc-gaze', '--text', 'x',
    '--out', path.join(work, 'session'), '--port', String(opts.port), '--no-open',
  ], { cwd: HERE, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));

  const { chromium } = await import('playwright').catch(() => {
    throw new Error('Playwright is not installed. Run npm install in the teleprompter repo; QC needs it, recording does not.');
  });
  // Pin software GL. MediaPipe's default delegate is the GPU, and when the
  // headless GL context comes up unhealthy it does not error, it just returns
  // no faces on every frame, which reads as a broken take.
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/XNNPACK|INFO:|favicon/.test(m.text())) console.log(`  page: ${m.text()}`);
  });
  await page.goto(`http://localhost:${opts.port}/`);

  const result = await page.evaluate(async ({ names, against, strength, lift, eye, zoom }) => {
    const { warpFrame } = await import('/app/gaze-correct.js');
    const P2 = await import('/app/gaze-plate.js');
    const { EYE_SPECS, eyeGeometry, loadVision } = await import('/app/vision.js');
    const { mod, fileset } = await loadVision();
    const landmarker = await mod.FaceLandmarker.createFromOptions(fileset, {
      // No delegate pinned on purpose. Forcing CPU here returns zero faces on
      // every frame in headless, which reads as a broken take rather than a
      // broken harness; the default picks SwiftShader and works.
      baseOptions: { modelAssetPath: '/vendor/models/face_landmarker.task' },
      runningMode: 'IMAGE',
      numFaces: 1,
    });

    const load = (src) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error(`could not load ${src}`));
      img.src = src;
    });

    // Warm the model up on a throwaway frame before anything is measured.
    try {
      await new Promise((r) => setTimeout(r, 500));
    } catch { /* the warm-up is allowed to fail */ }

    const specs = eye === 'left' ? [EYE_SPECS[1]] : eye === 'right' ? [EYE_SPECS[0]] : EYE_SPECS;
    const rows = [];
    const notes = [];

    for (const name of names) {
      const img = await load(`/vendor/__qc/${name}`);
      const W = img.naturalWidth;
      const H = img.naturalHeight;

      // Detect on the image element itself. Handing MediaPipe a canvas worked
      // only sometimes in headless, and failed by returning no faces at all.
      await img.decode?.().catch(() => {});
      // The first detect after the model loads sometimes comes back empty, so
      // give it a couple of goes before calling a frame faceless.
      let points = null;
      let detectError = null;
      let attempts = 0;
      for (; attempts < 8 && !points; attempts += 1) {
        try {
          points = landmarker.detect(img)?.faceLandmarks?.[0] ?? null;
        } catch (err) {
          detectError = String(err?.message ?? err);
        }
        if (!points) await new Promise((r) => setTimeout(r, 250));
      }
      if (!points || points.length < 478) {
        notes.push({ name, face: false, w: W, h: H, detectError, attempts });
        continue;
      }

      const work0 = document.createElement('canvas');
      work0.width = W; work0.height = H;
      work0.getContext('2d').drawImage(img, 0, 0);

      const work = document.createElement('canvas');
      work.width = W; work.height = H;
      const wctx = work.getContext('2d', { willReadFrequently: true });

      const g = specs.map((s) => eyeGeometry(points, s, W, H));
      let res = { shifts: [], perEye: [] };
      const partner = against[names.indexOf(name)];
      if (partner) {
        // Show the finished file, not a fresh warp. What ships is what gets
        // judged; re-running the maths here would hide anything the encode did.
        const other = await load(`/vendor/__qc/${partner}`);
        wctx.drawImage(other, 0, 0, W, H);
      } else {
        wctx.drawImage(img, 0, 0);
        const baseHx = g.reduce((a, x) => a + x.hx, 0) / g.length;
        const baseVy = g.reduce((a, x) => a + x.vy, 0) / g.length;
        res = warpFrame(wctx, points, W, H, { hx: baseHx, vy: baseVy - lift }, strength);
      }

      let cx; let cy; let cw; let ch;
      if (zoom > 0) {
        // Centred on one iris, a few radii across: the scale a rim artifact
        // lives at. Guessing a crop box by hand kept missing it.
        const e = g[g.length - 1];
        const r = Math.max(6, e.irisR) * zoom;
        cx = Math.max(0, Math.round(e.iris.x - r));
        cy = Math.max(0, Math.round(e.iris.y - r * 0.72));
        cw = Math.min(W - cx, Math.round(r * 2));
        ch = Math.min(H - cy, Math.round(r * 1.44));
      } else {
        const xs = specs.flatMap((s) => s.ring.map((i) => points[i].x * W));
        const ys = specs.flatMap((s) => s.ring.map((i) => points[i].y * H));
        const padX = (Math.max(...xs) - Math.min(...xs)) * 0.06;
        const padY = (Math.max(...ys) - Math.min(...ys)) * (specs.length === 1 ? 0.55 : 1.0);
        cx = Math.max(0, Math.round(Math.min(...xs) - padX));
        cy = Math.max(0, Math.round(Math.min(...ys) - padY));
        cw = Math.min(W - cx, Math.round(Math.max(...xs) + padX) - cx);
        ch = Math.min(H - cy, Math.round(Math.max(...ys) + padY) - cy);
      }

      // Measure the rim rather than squint at it. A ring artifact is a band of
      // brightening in the annulus just outside the iris; if it is gone, this
      // number goes to roughly zero.
      let rim = null;
      if (partner) {
        const a = work0.getContext('2d').getImageData(0, 0, W, H).data;
        const b = wctx.getImageData(0, 0, W, H).data;
        let sumA = 0; let sumB = 0; let n = 0; let worst = 0;
        for (const e of g) {
          const limbus = P2.measureLimbus(a, W, H, {
            irisX: e.iris.x, irisY: e.iris.y, irisR: e.irisR,
            cx: e.centre.x, cy: e.centre.y, openW: e.openW, openH: e.openH,
          });
          const ea2 = Math.max(2, e.openW / 2);
          const eb2 = Math.max(1.5, e.openH / 2);
          for (let ring = limbus * 1.0; ring <= limbus * 1.35; ring += 0.5) {
            for (let k = 0; k < 48; k += 1) {
              const th = (k / 48) * Math.PI * 2;
              const px = Math.round(e.iris.x + Math.cos(th) * ring);
              const py = Math.round(e.iris.y + Math.sin(th) * ring);
              if (px < 0 || py < 0 || px >= W || py >= H) continue;
              if (Math.hypot((px - e.centre.x) / ea2, (py - e.centre.y) / eb2) > 0.85) continue;
              const i = (py * W + px) * 4;
              const la = (a[i] + a[i + 1] + a[i + 2]) / 3;
              const lb = (b[i] + b[i + 1] + b[i + 2]) / 3;
              sumA += la; sumB += lb; n += 1;
              if (lb - la > worst) worst = lb - la;
            }
          }
        }
        if (n) rim = { mean: (sumB - sumA) / n, worst, samples: n };
      }

      rows.push({ name, plain: work0, work, cx, cy, cw, ch });
      notes.push({
        name,
        face: true,
        compared: Boolean(partner),
        rim,
        shifts: (res.shifts || []).map((s) => Number(s.toFixed(2))),
        bothEyes: res.bothEyes,
        irisR: g.map((x) => Number(x.irisR.toFixed(1))),
        openH: g.map((x) => Number(x.openH.toFixed(1))),
        detail: (res.perEye || []).filter(Boolean).map((d) => ({
          filled: d.filled,
          overhang: Number(d.overhang.toFixed(1)),
          cap: Number(d.cap.toFixed(1)),
        })),
      });
    }

    if (!rows.length) return { ok: false, notes };

    const { cw, ch } = rows[0];
    const scale = Math.min(4, Math.max(1, Math.floor(430 / cw)));
    const tileW = cw * scale;
    const tileH = ch * scale;
    const sheet = document.createElement('canvas');
    sheet.width = tileW * 3 + 24;
    sheet.height = (tileH + 22) * rows.length + 6;
    const sc = sheet.getContext('2d');
    sc.fillStyle = '#0b1113';
    sc.fillRect(0, 0, sheet.width, sheet.height);
    sc.font = '12px system-ui, sans-serif';
    sc.imageSmoothingEnabled = true;

    rows.forEach((row, i) => {
      const y0 = i * (tileH + 22);
      const crop = (canvas) => {
        const t = document.createElement('canvas');
        t.width = row.cw; t.height = row.ch;
        t.getContext('2d').drawImage(canvas, row.cx, row.cy, row.cw, row.ch, 0, 0, row.cw, row.ch);
        return t;
      };
      const a = crop(row.plain);
      const b = crop(row.work);
      const rawA = a.getContext('2d').getImageData(0, 0, row.cw, row.ch);
      const rawB = b.getContext('2d').getImageData(0, 0, row.cw, row.ch);

      // Stretch both tiles by the SAME amount, measured on the original. An eye
      // in shadow hides a rim artifact completely at native exposure, and
      // stretching each tile separately would invent a difference that is not
      // there.
      const stretch = (() => {
        const px = a.getContext('2d').getImageData(0, 0, row.cw, row.ch).data;
        let lo = 255;
        let hi = 0;
        for (let k = 0; k < px.length; k += 4) {
          const v = (px[k] + px[k + 1] + px[k + 2]) / 3;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        const span = Math.max(12, hi - lo);
        return { lo, gain: 255 / span };
      })();
      const apply = (canvas) => {
        const c = canvas.getContext('2d');
        const img = c.getImageData(0, 0, row.cw, row.ch);
        for (let k = 0; k < img.data.length; k += 4) {
          for (let ch = 0; ch < 3; ch += 1) {
            img.data[k + ch] = Math.max(0, Math.min(255, (img.data[k + ch] - stretch.lo) * stretch.gain));
          }
        }
        c.putImageData(img, 0, 0);
      };
      apply(a);
      apply(b);

      // Amplified absolute difference: where the pass actually touched pixels.
      const diff = document.createElement('canvas');
      diff.width = row.cw; diff.height = row.ch;
      const dc = diff.getContext('2d');
      const da = rawA;
      const db = rawB;
      const dd = dc.createImageData(row.cw, row.ch);
      for (let k = 0; k < da.data.length; k += 4) {
        const v = Math.min(255, Math.abs(da.data[k] - db.data[k]) * 4);
        dd.data[k] = v; dd.data[k + 1] = v; dd.data[k + 2] = v; dd.data[k + 3] = 255;
      }
      dc.putImageData(dd, 0, 0);

      sc.drawImage(a, 0, y0 + 18, tileW, tileH);
      sc.drawImage(b, tileW + 12, y0 + 18, tileW, tileH);
      sc.drawImage(diff, tileW * 2 + 24, y0 + 18, tileW, tileH);
      sc.fillStyle = '#cbd8d6';
      const n = notes.find((x) => x.name === row.name);
      sc.fillText(`${row.name}  original`, 2, y0 + 12);
      sc.fillText(`corrected  ${n?.shifts?.join(' / ')} px`, tileW + 14, y0 + 12);
      sc.fillText('difference x4', tileW * 2 + 26, y0 + 12);
    });

    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    document.body.style.background = '#0b1113';
    document.body.appendChild(sheet);
    sheet.style.cssText = 'position:absolute;top:4px;left:4px';
    return { ok: true, notes, w: sheet.width, h: sheet.height };
  }, {
    names: frames, against: againstFrames, strength: opts.strength,
    lift: opts.lift, eye: opts.eye, zoom: opts.zoom,
  });

  for (const n of result.notes) {
    console.log(`  ${n.name}  ${n.face
      ? `${n.compared ? 'compared' : `shift ${n.shifts.join(' / ')} px`}   iris r ${n.irisR.join('/')}   opening ${n.openH.join('/')}`
        + (n.rim ? `   rim ${n.rim.mean >= 0 ? '+' : ''}${n.rim.mean.toFixed(1)} mean, ${n.rim.worst.toFixed(0)} worst` : '')
        + `   ${(n.detail || []).map((d) => `[free ${d.overhang} cap ${d.cap} invented ${d.filled}px]`).join(' ')}`
      : `no face found after ${n.attempts} tries (frame ${n.w}x${n.h})${n.detectError ? ` err=${n.detectError}` : ''}`}`);
  }

  const outDir = opts.out ? path.resolve(opts.out) : path.dirname(source);
  const sheetPath = path.join(outDir, `${path.basename(source, path.extname(source))}.qc.png`);
  if (result.ok) {
    await page.screenshot({
      path: sheetPath,
      clip: { x: 4, y: 4, width: Math.min(1492, result.w), height: Math.min(992, result.h) },
    });
    console.log(`\n  sheet     ${sheetPath}`);
  } else {
    console.log('\n  No frames carried a detectable face.');
  }

  await browser.close();
  server.kill();
  await rm(SERVE_DIR, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(`\n  qc-gaze failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
