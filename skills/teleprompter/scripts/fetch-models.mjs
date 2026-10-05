#!/usr/bin/env node
/**
 * Vendor the open-source models the teleprompter uses for background removal
 * and gaze metering, so the capture app runs offline and from pinned bytes.
 *
 *   node scripts/fetch-models.mjs            # fetch + verify against the lock
 *   node scripts/fetch-models.mjs --relock   # accept new bytes, rewrite the lock
 *   node scripts/fetch-models.mjs --check    # report status, download nothing
 *
 * What lands in scripts/vendor/:
 *   tasks-vision/        MediaPipe Tasks Vision wasm runtime (Apache-2.0)
 *   models/selfie_segmenter.tflite   person/background segmentation (Apache-2.0)
 *   models/face_landmarker.task      478 face landmarks incl. iris (Apache-2.0)
 *
 * Every download is hashed. models.lock.json holds the SHA-256 we accepted, and
 * a later fetch that disagrees fails loudly rather than swapping the bytes that
 * run inside the capture page.
 */

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, 'vendor');
const LOCK = path.join(HERE, 'models.lock.json');

/** Pinned first; the fallbacks exist only so a yanked patch release is survivable. */
const TASKS_VISION_VERSIONS = ['0.10.22', '0.10.21', '0.10.20', '0.10.18', '0.10.14'];

const RUNTIME_FILES = [
  'vision_bundle.mjs',
  'wasm/vision_wasm_internal.js',
  'wasm/vision_wasm_internal.wasm',
  'wasm/vision_wasm_nosimd_internal.js',
  'wasm/vision_wasm_nosimd_internal.wasm',
];

const MODELS = [
  {
    dest: 'models/selfie_segmenter.tflite',
    urls: [
      'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
      'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
    ],
    why: 'background replacement / blur',
  },
  {
    dest: 'models/face_landmarker.task',
    urls: [
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
    ],
    why: 'iris + head pose for gaze metering and correction guidance',
  },
];

const args = new Set(process.argv.slice(2));
const RELOCK = args.has('--relock');
const CHECK_ONLY = args.has('--check');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function loadLock() {
  try {
    return JSON.parse(await readFile(LOCK, 'utf8'));
  } catch {
    return { tasksVisionVersion: null, files: {} };
  }
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function download(urls) {
  const errors = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        errors.push(`${res.status} ${res.statusText}: ${url}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) {
        errors.push(`empty body: ${url}`);
        continue;
      }
      return { buf, url };
    } catch (err) {
      errors.push(`${err?.message ?? err}: ${url}`);
    }
  }
  const hint = errors.some((e) => /certificate|SSL|TLS/i.test(e))
    ? '\n  TLS interception by antivirus or a corporate proxy breaks some fetches. Disable HTTPS scanning briefly and retry.'
    : '';
  throw new Error(`All sources failed:\n  ${errors.join('\n  ')}${hint}`);
}

async function writeVendor(relative, buf) {
  const abs = path.join(VENDOR, relative);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buf);
  return abs;
}

async function resolveRuntimeVersion(preferred) {
  const candidates = preferred
    ? [preferred, ...TASKS_VISION_VERSIONS.filter((v) => v !== preferred)]
    : TASKS_VISION_VERSIONS;
  for (const version of candidates) {
    const probe = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${version}/vision_bundle.mjs`;
    try {
      const res = await fetch(probe, { method: 'HEAD', redirect: 'follow' });
      if (res.ok) return version;
    } catch {
      /* try the next one */
    }
  }
  throw new Error('Could not reach any pinned @mediapipe/tasks-vision version on jsdelivr.');
}

async function main() {
  const lock = await loadLock();

  if (CHECK_ONLY) {
    const rows = [];
    for (const rel of [...RUNTIME_FILES.map((f) => `tasks-vision/${f}`), ...MODELS.map((m) => m.dest)]) {
      rows.push(`${(await exists(path.join(VENDOR, rel))) ? 'present' : 'MISSING'}  ${rel}`);
    }
    console.log(`tasks-vision version: ${lock.tasksVisionVersion ?? '(not vendored)'}`);
    console.log(rows.join('\n'));
    const missing = rows.filter((r) => r.startsWith('MISSING')).length;
    if (missing) {
      console.log(`\n${missing} file(s) missing. Run: node "${path.join(HERE, 'fetch-models.mjs')}"`);
      process.exit(1);
    }
    return;
  }

  const version = await resolveRuntimeVersion(lock.tasksVisionVersion);
  console.log(`MediaPipe Tasks Vision ${version}`);

  const nextFiles = {};
  const mismatches = [];
  // Held in memory until every file has been checked. Writing as we go would put
  // bytes that failed the lock on disk, where the capture page would load them.
  const pending = [];

  for (const file of RUNTIME_FILES) {
    const rel = `tasks-vision/${file}`;
    const { buf, url } = await download([
      `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${version}/${file}`,
    ]);
    const digest = sha256(buf);
    const known = lock.files?.[rel]?.sha256;
    if (known && known !== digest && !RELOCK) mismatches.push({ rel, known, digest });
    pending.push({ rel, buf });
    nextFiles[rel] = { sha256: digest, bytes: buf.length, url };
    console.log(`  ${rel}  ${(buf.length / 1024).toFixed(0)} KB  ${digest.slice(0, 12)}`);
  }

  for (const model of MODELS) {
    const { buf, url } = await download(model.urls);
    const digest = sha256(buf);
    const known = lock.files?.[model.dest]?.sha256;
    if (known && known !== digest && !RELOCK) mismatches.push({ rel: model.dest, known, digest });
    pending.push({ rel: model.dest, buf });
    nextFiles[model.dest] = { sha256: digest, bytes: buf.length, url, why: model.why };
    console.log(`  ${model.dest}  ${(buf.length / 1024).toFixed(0)} KB  ${digest.slice(0, 12)}`);
  }

  if (mismatches.length) {
    console.error('\nHash mismatch against models.lock.json:');
    for (const m of mismatches) {
      console.error(`  ${m.rel}\n    locked ${m.known}\n    got    ${m.digest}`);
    }
    console.error('\nNothing was written. If the new bytes are a release you trust, re-run with');
    console.error('--relock to accept them.');
    process.exit(1);
  }

  for (const { rel, buf } of pending) await writeVendor(rel, buf);

  // Rewrite the lock only when what it pins has changed, so a routine fetch leaves a
  // clean working tree.
  const pinsOf = (files) => JSON.stringify(Object.entries(files ?? {}).map(([k, v]) => [k, v.sha256]).sort());
  const lockChanged = RELOCK || lock.tasksVisionVersion !== version || pinsOf(lock.files) !== pinsOf(nextFiles);
  if (!lockChanged) {
    console.log(`\nVendored to ${VENDOR}`);
    console.log('Every file matched models.lock.json.');
    return;
  }

  await writeFile(
    LOCK,
    `${JSON.stringify(
      {
        note: 'SHA-256 of every third-party byte the teleprompter capture page loads. These run with browser camera access, so a fetch that disagrees with this lock fails.',
        tasksVisionVersion: version,
        licence: 'Apache-2.0 (MediaPipe Tasks Vision runtime and models)',
        updatedAt: new Date().toISOString().slice(0, 10),
        files: nextFiles,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(`\nVendored to ${VENDOR}`);
  console.log(`Lock written to ${LOCK}`);
}

main().catch((err) => {
  console.error(`\nfetch-models failed: ${err?.message ?? err}`);
  console.error('\nThe teleprompter still records without these files. Background');
  console.error('replacement and gaze metering stay switched off until they land.');
  process.exit(1);
});
