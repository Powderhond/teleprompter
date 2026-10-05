#!/usr/bin/env node
/**
 * Post-capture enhancement for a recorded file: background replacement and
 * gaze work on footage that already exists.
 *
 * The live app already does background replacement and gaze metering in the
 * browser with no external binaries. This script is for the cases the live path
 * cannot serve:
 *   - footage recorded somewhere else
 *   - changing your mind about the background after a good take
 *   - redirecting the eyes toward the lens, which no browser model does
 *
 * Those need heavier tools, so this script's first job is to tell you exactly
 * what is installed and what each missing piece would unlock. It never pretends
 * a pass ran.
 *
 *   node scripts/enhance.mjs --check
 *   node scripts/enhance.mjs --install-plan
 *   node scripts/enhance.mjs --in take-01.mp4 --background blur:24
 *   node scripts/enhance.mjs --in take-01.mp4 --background colour:#132a2f
 *   node scripts/enhance.mjs --in take-01.mp4 --gaze measure
 *
 * Providers, all open source:
 *   ffmpeg                 muxing, blur, overlay            LGPL/GPL
 *   backgroundremover      u2net video matting (alpha mov)  MIT
 *   rembg                  u2net still matting              MIT
 *   l2cs-net              gaze estimation, measures a file  MIT
 *   sted-gaze             gaze redirection, experimental    MIT
 */

import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_BIN = path.join(HERE, 'vendor', 'bin');

function parseArgs(argv) {
  const out = { check: false, plan: false, in: '', background: '', gaze: '', out: '', keepTemp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case '--check': out.check = true; break;
      case '--install-plan': out.plan = true; break;
      case '--in': out.in = next() ?? ''; break;
      case '--out': out.out = next() ?? ''; break;
      case '--background': out.background = next() ?? ''; break;
      case '--gaze': out.gaze = next() ?? ''; break;
      case '--keep-temp': out.keepTemp = true; break;
      case '-h': case '--help': out.check = true; break;
      default: break;
    }
  }
  return out;
}

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err?.message ?? err) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function which(command, args = ['-version']) {
  const result = await run(command, args, { capture: true });
  if (result.code !== 0 && result.code !== 1) return null;
  const text = `${result.stdout}${result.stderr}`.trim().split('\n')[0] ?? '';
  return text.slice(0, 90) || command;
}

async function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) {
    const version = await which(process.env.FFMPEG_PATH);
    if (version) return { path: process.env.FFMPEG_PATH, version };
  }
  const vendored = path.join(VENDOR_BIN, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  try {
    await access(vendored, constants.X_OK);
    return { path: vendored, version: await which(vendored) };
  } catch { /* not vendored */ }
  const version = await which('ffmpeg');
  return version ? { path: 'ffmpeg', version } : null;
}

const CAPABILITIES = [
  {
    key: 'ffmpeg',
    unlocks: 'every post pass: blur, overlay, re-mux, frame export',
    install: 'winget install --id Gyan.FFmpeg -e (Windows), brew install ffmpeg (macOS), or your package manager (Linux)',
    detect: async () => {
      const found = await resolveFfmpeg();
      return found ? { ok: true, detail: found.version, path: found.path } : { ok: false };
    },
  },
  {
    key: 'uv',
    unlocks: 'a throwaway Python 3.11 for the model providers, without touching system Python',
    install: 'see https://docs.astral.sh/uv/getting-started/installation/',
    detect: async () => {
      const version = await which('uv', ['--version']);
      return version ? { ok: true, detail: version } : { ok: false };
    },
  },
  {
    key: 'backgroundremover',
    unlocks: 'background removal on video, producing an alpha mov this script composites',
    install: 'uv tool install --python 3.11 backgroundremover',
    detect: async () => {
      const version = await which('backgroundremover', ['--help']);
      return version ? { ok: true, detail: 'installed' } : { ok: false };
    },
  },
  {
    key: 'rembg',
    unlocks: 'background removal on stills, used for thumbnails pulled from a take',
    install: 'uv tool install --python 3.11 "rembg[cli]"',
    detect: async () => {
      const version = await which('rembg', ['--help']);
      return version ? { ok: true, detail: 'installed' } : { ok: false };
    },
  },
  {
    key: 'gaze-redirect',
    unlocks: 'redirecting the eyes toward the lens in an existing file',
    install: [
      'No turnkey package exists. The open-source options, newest first:',
      '  STED-gaze   https://github.com/zhengyuf/STED-gaze     (redirection, needs pretrained weights)',
      '  GazeAnimation https://github.com/zhangqianhui/GazeAnimation',
      '  DeepWarp    https://github.com/BlueWinters/DeepWarp   (older, TF1)',
      'Each wants a Python env with torch plus weights the authors host separately.',
      'Clone one into scripts/vendor/gaze/, expose a redirect.py that',
      'takes --in/--out, and this script will call it.',
    ].join('\n      '),
    detect: async () => {
      const entry = path.join(HERE, 'vendor', 'gaze', 'redirect.py');
      try {
        await access(entry, constants.R_OK);
        return { ok: true, detail: entry };
      } catch {
        return { ok: false };
      }
    },
  },
  {
    key: 'gaze-measure',
    unlocks: 'scoring eye contact across a finished file, frame by frame',
    install: [
      'uv tool install --python 3.11 torch torchvision',
      'then clone https://github.com/Ahmednull/L2CS-Net into',
      'scripts/vendor/gaze/l2cs and drop its pretrained .pkl beside it.',
      'The live meter in the app covers this during the take, so this is only for',
      'footage you did not record here.',
    ].join('\n      '),
    detect: async () => {
      const entry = path.join(HERE, 'vendor', 'gaze', 'l2cs');
      try {
        await access(entry, constants.R_OK);
        return { ok: true, detail: entry };
      } catch {
        return { ok: false };
      }
    },
  },
];

async function detectAll() {
  const results = {};
  for (const capability of CAPABILITIES) {
    results[capability.key] = { ...capability, ...(await capability.detect()) };
  }
  return results;
}

function printTable(results) {
  console.log('');
  console.log('  Post-capture providers');
  console.log('  ' + '-'.repeat(72));
  for (const capability of CAPABILITIES) {
    const found = results[capability.key];
    const mark = found.ok ? 'yes' : ' no';
    console.log(`  [${mark}]  ${capability.key.padEnd(20)} ${found.ok ? (found.detail ?? '') : capability.unlocks}`);
  }
  console.log('  ' + '-'.repeat(72));
  console.log('');
  console.log('  The live app needs none of these. It replaces the background and meters');
  console.log('  gaze in the browser, from the models in scripts/vendor.');
  console.log('');
}

function printPlan(results) {
  const missing = CAPABILITIES.filter((c) => !results[c.key].ok);
  if (!missing.length) {
    console.log('\n  Everything is already installed.\n');
    return;
  }
  console.log('\n  To unlock the missing passes:\n');
  for (const capability of missing) {
    console.log(`  ${capability.key}`);
    console.log(`      gives you: ${capability.unlocks}`);
    console.log(`      install:   ${capability.install}`);
    console.log('');
  }
}

/** --background blur:24 | colour:#132a2f | image:path/to.jpg | remove */
function parseBackgroundSpec(spec) {
  const [mode, ...rest] = spec.split(':');
  const value = rest.join(':');
  if (mode === 'blur') return { mode: 'blur', amount: Number(value) || 20 };
  if (mode === 'colour' || mode === 'color') return { mode: 'colour', colour: value || '#132a2f' };
  if (mode === 'image') return { mode: 'image', image: value };
  if (mode === 'remove') return { mode: 'remove' };
  throw new Error(`Unknown background spec "${spec}". Use blur:N, colour:#hex, image:path, or remove.`);
}

async function runBackground(results, options) {
  const spec = parseBackgroundSpec(options.background);
  const ffmpeg = results.ffmpeg;
  const matting = results.backgroundremover;

  if (!ffmpeg.ok) throw new Error(`ffmpeg is required for a background pass.\n  Install: ${results.ffmpeg.install}`);
  if (!matting.ok) {
    throw new Error(
      `backgroundremover is required to cut the subject out of a finished file.\n  Install: ${results.backgroundremover.install}`,
    );
  }

  const input = path.resolve(options.in);
  const output = options.out
    ? path.resolve(options.out)
    : input.replace(/(\.[^.]+)$/, '.bg$1').replace(/\.bg$/, '.bg.mp4');
  const temp = await mkdtemp(path.join(tmpdir(), 'teleprompter-enhance-'));
  const matte = path.join(temp, 'matte.mov');

  try {
    console.log(`\n  Matting ${path.basename(input)} with u2net. This is the slow part.`);
    const matted = await run('backgroundremover', ['-i', input, '-tv', '-o', matte]);
    if (matted.code !== 0) throw new Error('backgroundremover failed, see its output above.');

    if (spec.mode === 'remove') {
      // Alpha survives in VP9/WebM. MP4 would flatten it, so the extension changes.
      const alphaOut = output.replace(/\.[^.]+$/, '.webm');
      const result = await run(ffmpeg.path, [
        '-y', '-i', matte, '-i', input,
        '-map', '0:v', '-map', '1:a?',
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '4M',
        '-c:a', 'libopus', '-b:a', '160k', alphaOut,
      ]);
      if (result.code !== 0) throw new Error('ffmpeg failed writing the transparent file.');
      console.log(`\n  Wrote ${alphaOut} with a transparent background.`);
      return alphaOut;
    }

    const args = ['-y', '-i', input, '-i', matte];
    let filter;
    if (spec.mode === 'blur') {
      filter = `[0:v]boxblur=${Math.round(spec.amount)}:2[bg];[bg][1:v]overlay=format=auto[v]`;
    } else if (spec.mode === 'colour') {
      const hex = spec.colour.replace('#', '0x');
      filter = `[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=${hex}@1:t=fill[bg];[bg][1:v]overlay=format=auto[v]`;
    } else {
      if (!spec.image) throw new Error('image: needs a path, for example image:plate.jpg');
      args.push('-i', path.resolve(spec.image));
      filter = '[2:v][0:v]scale2ref[plate][refv];[refv]nullsink;[plate][1:v]overlay=format=auto[v]';
    }

    args.push('-filter_complex', filter, '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', output);

    const composed = await run(ffmpeg.path, args);
    if (composed.code !== 0) throw new Error('ffmpeg failed compositing the new background.');
    console.log(`\n  Wrote ${output}`);
    return output;
  } finally {
    if (!options.keepTemp) await rm(temp, { recursive: true, force: true });
  }
}

async function runGaze(results, options) {
  const mode = options.gaze;
  if (mode === 'redirect') {
    const provider = results['gaze-redirect'];
    if (!provider.ok) {
      throw new Error(
        'No gaze redirection provider is installed, so nothing was changed.\n\n' +
        `      ${provider.install}\n\n` +
        '      The app meters gaze live and parks the reading band at the lens, which\n' +
        '      is what actually keeps the eyeline right. Redirection after the fact is\n' +
        '      a research-grade pass, not a one-command tool.',
      );
    }
    const output = options.out || options.in.replace(/(\.[^.]+)$/, '.gaze$1');
    const result = await run('uv', ['run', '--python', '3.11', provider.detail,
      '--in', path.resolve(options.in), '--out', path.resolve(output)]);
    if (result.code !== 0) throw new Error('The gaze redirection provider failed.');
    console.log(`\n  Wrote ${output}`);
    return output;
  }

  if (mode === 'measure') {
    const provider = results['gaze-measure'];
    if (!provider.ok) {
      throw new Error(
        'No gaze estimator is installed, so no score was produced.\n\n' +
        `      ${provider.install}`,
      );
    }
    const result = await run('uv', ['run', '--python', '3.11',
      path.join(provider.detail, 'measure.py'), '--in', path.resolve(options.in)]);
    if (result.code !== 0) throw new Error('The gaze estimator failed.');
    return null;
  }

  throw new Error(`Unknown --gaze mode "${mode}". Use measure or redirect.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const results = await detectAll();

  if (options.plan) {
    printPlan(results);
    return;
  }
  if (options.check || (!options.in && !options.background && !options.gaze)) {
    printTable(results);
    if (CAPABILITIES.some((c) => !results[c.key].ok)) {
      console.log('  Run with --install-plan for the commands that fill the gaps.\n');
    }
    return;
  }

  if (!options.in) throw new Error('--in <file> is required.');
  await access(path.resolve(options.in), constants.R_OK);

  const report = { input: path.resolve(options.in), ran: [], at: new Date().toISOString() };
  let current = options.in;

  if (options.background) {
    const produced = await runBackground(results, { ...options, in: current });
    report.ran.push({ pass: 'background', spec: options.background, output: produced });
    if (produced) current = produced;
  }
  if (options.gaze) {
    const produced = await runGaze(results, { ...options, in: current });
    report.ran.push({ pass: 'gaze', spec: options.gaze, output: produced });
    if (produced) current = produced;
  }

  const reportPath = `${path.resolve(options.in).replace(/\.[^.]+$/, '')}.enhance.json`;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`  Report  ${reportPath}\n`);
}

main().catch((err) => {
  console.error(`\n  enhance failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
