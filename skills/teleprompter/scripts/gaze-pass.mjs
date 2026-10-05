#!/usr/bin/env node
/**
 * Offline gaze correction.
 *
 * Decodes every frame with ffmpeg, corrects each one in a headless browser, and
 * re-encodes with the original audio. Slower than the in-app pass by a long way,
 * and better in every respect that matters:
 *
 *   - every frame is processed, so nothing is dropped and the result runs at the
 *     source frame rate instead of whatever the main thread could keep up with
 *   - landmarks are known for the whole take before anything is drawn, so the
 *     displacement is smoothed with a window centred on each frame rather than a
 *     running average that lags and shakes
 *   - the band a moved iris vacates is filled from a clean plate built by
 *     medianing the eye across the take, which is real sclera, lid and lash
 *     rather than a colour guessed from one frame
 *   - the output is a normal progressive MP4, so it seeks and reports its
 *     duration honestly, which the browser recorder's fragmented output does not
 *
 *   node scripts/gaze-pass.mjs --in take-01.mp4
 *   node scripts/gaze-pass.mjs --in take-01.mp4 --strength 0.6 --smooth 9
 *   node scripts/gaze-pass.mjs --in take-01.mp4 --lift 0.26 --keep-frames
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE_DIR = path.join(HERE, 'vendor', '__pass');

function parseArgs(argv) {
  const out = {
    in: '', out: '', strength: 0.6, lift: 0.26, smooth: 9,
    port: 4550, keepFrames: false, crf: 16,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case '--in': out.in = next() ?? ''; break;
      case '--out': out.out = next() ?? ''; break;
      case '--strength': out.strength = Number(next()); break;
      case '--lift': out.lift = Number(next()); break;
      case '--smooth': out.smooth = Number(next()); break;
      case '--crf': out.crf = Number(next()); break;
      case '--port': out.port = Number(next()); break;
      case '--keep-frames': out.keepFrames = true; break;
      default: break;
    }
  }
  return out;
}

/** Every ffmpeg build winget has unpacked, whatever its version folder is called. */
async function wingetGuesses(name) {
  const root = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  try {
    const found = [];
    for (const pkg of (await readdir(root)).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
      for (const build of await readdir(path.join(root, pkg))) {
        found.push(path.join(root, pkg, build, 'bin', `${name}.exe`));
      }
    }
    return found;
  } catch {
    return [];
  }
}

async function resolveTool(name) {
  const guesses = [
    process.env[`${name.toUpperCase()}_PATH`],
    path.join(HERE, 'vendor', 'bin', `${name}.exe`),
    ...(process.platform === 'win32' ? await wingetGuesses(name) : []),
    name,
  ].filter(Boolean);
  for (const guess of guesses) {
    const ok = await new Promise((resolve) => {
      const child = spawn(guess, ['-version'], { stdio: 'ignore', shell: process.platform === 'win32' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
    if (ok) return guess;
  }
  throw new Error(`${name} not found. Install ffmpeg: winget install --id Gyan.FFmpeg -e (Windows), brew install ffmpeg (macOS), or your package manager (Linux). Or point ${name.toUpperCase()}_PATH at the binary.`);
}

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${path.basename(command)} failed:\n${stderr.slice(-900)}`))));
  });
}

/** Machine-readable, so the server never has to regex a drawn progress bar. */
function emit(stage, done, total) {
  process.stdout.write(`\nPROGRESS ${stage} ${done} ${total}\n`);
}

function bar(done, total, width = 28) {
  const filled = Math.round((done / Math.max(1, total)) * width);
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${done}/${total}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.in) throw new Error('--in <take.mp4> is required');
  const source = path.resolve(opts.in);
  await stat(source);

  const ffmpeg = await resolveTool('ffmpeg');
  const ffprobe = await resolveTool('ffprobe');

  const probe = await run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate,avg_frame_rate,width,height,nb_read_packets,duration',
    '-count_packets', '-of', 'json', source,
  ], { capture: true });
  const stream = JSON.parse(probe.stdout).streams?.[0] ?? {};

  // Use the average rate, never r_frame_rate.
  //
  // MediaRecorder declares a nominal 60 fps and then delivers whatever the
  // camera managed, often half that. Re-encoding at the nominal rate makes the
  // video play at double speed and finish while the audio is still going, which
  // is both the speed-up and the apparent silence that reported it.
  const ratio = (value) => {
    const [a, b] = String(value ?? '').split('/').map(Number);
    return b ? a / b : null;
  };
  const counted = Number(stream.nb_read_packets) && Number(stream.duration)
    ? Number(stream.nb_read_packets) / Number(stream.duration)
    : null;
  const fps = counted ?? ratio(stream.avg_frame_rate) ?? ratio(stream.r_frame_rate) ?? 30;
  const sourceDuration = Number(stream.duration) || null;
  console.log(`\n  source    ${path.basename(source)}  ${stream.width}x${stream.height}  ${fps.toFixed(2)} fps  ${stream.nb_read_packets} frames`);

  const work = await mkdtemp(path.join(tmpdir(), 'gaze-pass-'));
  const inDir = path.join(work, 'in');
  const outDir = path.join(work, 'out');
  await mkdir(inDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  process.stdout.write('  decoding  ');
  emit('decoding', 0, 1);
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', source,
    '-fps_mode', 'passthrough', path.join(inDir, 'f_%06d.png')]);
  const frames = (await readdir(inDir)).filter((f) => f.endsWith('.png')).sort();
  console.log(`${frames.length} frames`);
  if (!frames.length) throw new Error('ffmpeg decoded no frames');

  // Served same-origin so the page can read pixels back off the canvas.
  await rm(SERVE_DIR, { recursive: true, force: true });
  await mkdir(SERVE_DIR, { recursive: true });
  const { symlink, copyFile } = await import('node:fs/promises');
  for (const f of frames) {
    try { await symlink(path.join(inDir, f), path.join(SERVE_DIR, f)); }
    catch { await copyFile(path.join(inDir, f), path.join(SERVE_DIR, f)); }
  }

  const server = spawn(process.execPath, [
    path.join(HERE, 'server.mjs'), '--task', 'gaze-pass', '--text', 'x',
    '--out', path.join(work, 'session'), '--port', String(opts.port), '--no-open',
  ], { cwd: HERE, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));

  const { chromium } = await import('playwright').catch(() => {
    throw new Error('Playwright is not installed. Run npm install in the teleprompter repo; the gaze pass needs it, recording does not.');
  });
  const browser = await chromium.launch({
    headless: true,
    // MediaPipe's GPU delegate fails in headless by returning no faces at all
    // rather than erroring, so the GL stack is pinned to software.
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await (await browser.newContext({ viewport: { width: 400, height: 300 } })).newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/XNNPACK|INFO:|favicon/.test(m.text())) console.log(`  page: ${m.text()}`);
  });
  await page.goto(`http://localhost:${opts.port}/`);

  await page.evaluate(async ({ frameCount }) => {
    const { loadVision } = await import('/app/vision.js');
    const { mod, fileset } = await loadVision();
    window.__gp = {
      landmarker: await mod.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/vendor/models/face_landmarker.task' },
        runningMode: 'IMAGE',
        numFaces: 1,
      }),
      plate: await import('/app/gaze-plate.js'),
      vision: await import('/app/vision.js'),
      total: frameCount,
    };
    await new Promise((r) => setTimeout(r, 400));
  }, { frameCount: frames.length });

  // ---- pass one: landmarks and the clean plate
  // Driven a frame at a time from here rather than in one evaluate, because a
  // single call means no output for the length of the take. On a two minute
  // recording that is minutes of silence, which reads as a hang.
  console.log('  reading   every frame for landmarks and the clean plate');
  await page.evaluate(() => {
    window.__gp.geoms = [];
    window.__gp.builders = null;
    window.__gp.patch = null;
    window.__gp.size = null;
  });

  for (let i = 0; i < frames.length; i += 1) {
    await page.evaluate(async ({ name }) => {
      const { landmarker, plate: P, vision } = window.__gp;
      const specs = vision.EYE_SPECS;
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error(`load ${name}`));
        im.src = `/vendor/__pass/${name}`;
      });

      if (!window.__gp.canvas) {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        window.__gp.canvas = canvas;
        window.__gp.ctx = canvas.getContext('2d', { willReadFrequently: true });
        window.__gp.size = { width: canvas.width, height: canvas.height };
      }
      const { canvas, ctx } = window.__gp;
      ctx.drawImage(img, 0, 0);

      let points = null;
      for (let attempt = 0; attempt < 5 && !points; attempt += 1) {
        points = landmarker.detect(img)?.faceLandmarks?.[0] ?? null;
        if (!points) await new Promise((r) => setTimeout(r, 120));
      }
      if (!points || points.length < 478) { window.__gp.geoms.push(null); return; }

      const g = P.frameGeometry(points, specs, canvas.width, canvas.height);
      window.__gp.geoms.push(g);

      if (!window.__gp.builders) {
        window.__gp.patch = P.patchSize(g[0].openW, g[0].openH);
        window.__gp.builders = specs.map(() => new P.PlateBuilder(window.__gp.patch, window.__gp.total));
      }
      const frameData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      g.forEach((eye) => { eye.limbus = P.measureLimbus(frameData, canvas.width, canvas.height, eye); });
      g.forEach((eye, k) => window.__gp.builders[k].add(frameData, canvas.width, canvas.height, eye));
    }, { name: frames[i] });

    if ((i + 1) % 4 === 0 || i + 1 === frames.length) {
      emit('reading', i + 1, frames.length);
      process.stdout.write(`\r  reading   ${bar(i + 1, frames.length)}`);
    }
  }
  process.stdout.write('\n');

  const survey = await page.evaluate(() => {
    const { builders, geoms, patch, size } = window.__gp;
    if (!builders) return { ok: false };
    const plates = builders.map((b) => b.finish());
    window.__gp.plates = plates;
    return {
      ok: true,
      width: size.width,
      height: size.height,
      geoms,
      coverage: plates.map((p) => Number(p.coverage.toFixed(3))),
      patch,
    };
  });

  if (!survey.ok) throw new Error('No frame in this take carried a detectable face.');
  const seen = survey.geoms.filter(Boolean).length;
  console.log(`${seen}/${frames.length} frames with a face, plate coverage ${survey.coverage.map((c) => `${Math.round(c * 100)}%`).join(' / ')}`);

  // ---- smooth the displacement across the whole take, centred on each frame
  const nEyes = 2;
  const series = [];
  for (let k = 0; k < nEyes; k += 1) {
    series.push({ hx: [], vy: [] });
  }
  for (const g of survey.geoms) {
    for (let k = 0; k < nEyes; k += 1) {
      series[k].hx.push(g ? g[k].hx : NaN);
      series[k].vy.push(g ? g[k].vy : NaN);
    }
  }
  const smoothed = await page.evaluate(({ series: s, radius }) => {
    const { plate: P } = window.__gp;
    return s.map((eye) => ({
      hx: Array.from(P.smoothSeries(eye.hx, radius)),
      vy: Array.from(P.smoothSeries(eye.vy, radius)),
    }));
  }, { series, radius: Math.max(1, Math.round(opts.smooth / 2)) });

  // Target: where the eyes were, lifted toward the lens.
  const valid = survey.geoms.filter(Boolean);
  const baseline = {
    hx: valid.reduce((a, g) => a + (g[0].hx + g[1].hx) / 2, 0) / valid.length,
    vy: valid.reduce((a, g) => a + (g[0].vy + g[1].vy) / 2, 0) / valid.length - opts.lift,
  };

  // ---- pass two: render
  let done = 0;
  const stats = { written: 0, moved: 0, shiftSum: 0, maxShift: 0 };
  for (let f = 0; f < frames.length; f += 1) {
    const rendered = await page.evaluate(async ({ name, index, geom, smooth, baseline: b, strength }) => {
      const { plate: P, plates } = window.__gp;
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('load'));
        im.src = `/vendor/__pass/${name}`;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);

      if (!geom) return { png: canvas.toDataURL('image/png'), shift: 0, moved: false };

      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const src = new Uint8ClampedArray(image.data);
      let maxShift = 0;

      // Where this eye's iris actually ends, in this frame, from its pixels.
      geom.forEach((eye) => { eye.limbus = P.measureLimbus(src, canvas.width, canvas.height, eye); });

      geom.forEach((eye, k) => {
        const plate = plates[k];
        const hx = smooth[k].hx[index];
        const vy = smooth[k].vy[index];
        let dx = (b.hx - hx) * eye.openW * strength;
        let dy = (b.vy - vy) * eye.openH * strength;

        // Same ceilings as the live pass: the iris can only slide as far as the
        // lid already hides, plus a sliver, before pixels must be invented.
        const ea = Math.max(2, eye.openW / 2);
        const eb = Math.max(1.5, eye.openH / 2);
        const ex = (eye.irisX - eye.cx) / ea;
        const span = eb * Math.sqrt(Math.max(0, 1 - Math.min(1, ex * ex)));
        const overhang = dy < 0
          ? Math.max(0, (eye.irisY + eye.irisR) - (eye.cy + span))
          : Math.max(0, (eye.cy - span) - (eye.irisY - eye.irisR));
        const cap = Math.min(eye.irisR * 0.55, eye.openH * 0.3, overhang + eye.openH * 0.18);
        const asked = Math.hypot(dx, dy);
        if (asked > cap && asked > 1e-6) { dx *= cap / asked; dy *= cap / asked; }

        if (Math.hypot(dx, dy) < 0.15) return;
        P.composeEye(image.data, src, canvas.width, canvas.height, eye, plate, dx, dy);
        maxShift = Math.max(maxShift, Math.hypot(dx, dy));
      });

      ctx.putImageData(image, 0, 0);
      return { png: canvas.toDataURL('image/png'), shift: maxShift, moved: maxShift > 0 };
    }, {
      name: frames[f], index: f, geom: survey.geoms[f],
      smooth: smoothed, baseline, strength: opts.strength,
    });

    await writeFile(path.join(outDir, frames[f]), Buffer.from(rendered.png.split(',')[1], 'base64'));
    if (rendered.moved) {
      stats.moved += 1;
      stats.shiftSum += rendered.shift;
      stats.maxShift = Math.max(stats.maxShift, rendered.shift);
    }
    done += 1;
    if (done % 4 === 0 || done === frames.length) {
      emit('correcting', done, frames.length);
      process.stdout.write(`\r  correcting ${bar(done, frames.length)}`);
    }
  }
  process.stdout.write('\n');

  await browser.close();
  server.kill();

  // ---- encode, with the original audio and a seekable container
  const target = opts.out
    ? path.resolve(opts.out)
    : source.replace(/\.[^.]+$/, '.gaze.mp4');
  process.stdout.write('  encoding  ');
  emit('encoding', 0, 1);
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(fps), '-i', path.join(outDir, 'f_%06d.png'),
    '-i', source,
    '-map', '0:v:0', '-map', '1:a:0?',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(opts.crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    target,
  ]);
  const size = (await stat(target)).size;
  console.log(`${(size / 1e6).toFixed(1)} MB`);

  // Check the result against the source rather than trusting the maths. A
  // timeline that drifts is the one defect a viewer notices immediately.
  const after = await run(ffprobe, [
    '-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', target,
  ], { capture: true });
  const outStreams = JSON.parse(after.stdout).streams ?? [];
  const outVideo = outStreams.find((x) => x.codec_type === 'video');
  const outAudio = outStreams.find((x) => x.codec_type === 'audio');
  const vDur = Number(outVideo?.duration) || 0;
  const aDur = Number(outAudio?.duration) || 0;

  console.log('');
  console.log(`  timing    video ${vDur.toFixed(2)}s, audio ${aDur ? `${aDur.toFixed(2)}s` : 'none'}` +
    (sourceDuration ? `, source ${sourceDuration.toFixed(2)}s` : ''));
  if (!outAudio) {
    console.log('  WARNING   the result has no audio track.');
  }
  if (sourceDuration && Math.abs(vDur - sourceDuration) / sourceDuration > 0.02) {
    console.log(`  WARNING   the video runs ${(vDur / sourceDuration).toFixed(2)}x the source. Something is wrong with the frame rate.`);
  }
  if (aDur && Math.abs(vDur - aDur) / Math.max(aDur, 1) > 0.02) {
    console.log(`  WARNING   video and audio differ by ${Math.abs(vDur - aDur).toFixed(2)}s, so they will drift.`);
  }

  console.log('');
  console.log(`  corrected ${stats.moved}/${frames.length} frames, mean shift ${(stats.shiftSum / Math.max(1, stats.moved)).toFixed(2)} px, max ${stats.maxShift.toFixed(2)} px`);
  console.log(`  out       ${target}`);
  console.log('');

  await rm(SERVE_DIR, { recursive: true, force: true });
  if (!opts.keepFrames) await rm(work, { recursive: true, force: true });
  else console.log(`  frames kept in ${work}\n`);
}

main().catch((err) => {
  console.error(`\n  gaze-pass failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
