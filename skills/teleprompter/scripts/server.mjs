#!/usr/bin/env node
/**
 * Teleprompter and recorder: a localhost capture station.
 *
 * Zero dependencies. Serves a local web app that:
 *   - lets you pick camera / microphone (external gear included)
 *   - scrolls a script at a pace you control
 *   - records to MP4 (or WebM) with optional background replacement and gaze metering
 *   - "submits" a take back to the Claude session that launched it
 *
 * Everything runs in the browser, so there is no ffmpeg, Python, or torch
 * dependency for the capture path.
 *
 * Usage:
 *   node scripts/server.mjs --task "intro voiceover" --script notes.md --wait
 *
 * Options:
 *   --task <label>     what the recording is for (shown in the app, stored in the manifest)
 *   --script <file>    script to read (markdown or text). "-" reads stdin.
 *   --text "<words>"   inline script instead of a file
 *   --out <dir>        session root (default: .teleprompter)
 *   --port <n>         preferred port (default: 4455, climbs if busy)
 *   --audio-only       microphone only, no camera
 *   --wait             exit after the first submitted take (prints its path)
 *   --no-open          do not launch a browser
 *   --help
 */

import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat, readdir, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, 'app');
const VENDOR_DIR = path.join(HERE, 'vendor');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.task': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.m4a': 'audio/mp4',
  '.weba': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.vtt': 'text/vtt; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function parseArgs(argv) {
  const out = {
    task: '',
    script: '',
    text: '',
    out: '.teleprompter',
    port: 4455,
    audioOnly: false,
    wait: false,
    open: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case '--task': out.task = next() ?? ''; break;
      case '--script': out.script = next() ?? ''; break;
      case '--text': out.text = next() ?? ''; break;
      case '--out': out.out = next() ?? out.out; break;
      case '--port': out.port = Number(next()) || out.port; break;
      case '--audio-only': out.audioOnly = true; break;
      case '--wait': out.wait = true; break;
      case '--no-open': out.open = false; break;
      case '--open': out.open = true; break;
      case '-h': case '--help': out.help = true; break;
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(2);
        }
    }
  }
  return out;
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'take';
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + '-' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function loadScript(opts) {
  if (opts.text) return { text: opts.text, source: 'inline' };
  if (opts.script === '-') return { text: await readStdin(), source: 'stdin' };
  if (opts.script) {
    const abs = path.resolve(opts.script);
    const text = await readFile(abs, 'utf8');
    return { text, source: abs };
  }
  return {
    text: [
      '# No script was passed in',
      '',
      'You can type or paste straight into this panel. Hit Edit script, write your',
      'words, then press Done. Blank lines separate blocks, a line starting with #',
      'is a heading you do not read aloud, and text inside (( double parens )) is a',
      'direction for you rather than a line for the camera.',
      '',
      '(( look at the lens marker, not at these words ))',
      '',
      'Pass a real script next time with --script <file> or --text "...".',
    ].join('\n'),
    source: 'placeholder',
  };
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/** `localhost:4455` → `localhost`, `[::1]:4455` → `::1`. */
function hostOf(hostHeader) {
  if (!hostHeader) return '';
  return hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

function isLoopbackName(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** True when a browser's Origin header names this server: a loopback name on our port. */
function isOwnOrigin(origin, port) {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:'
      && isLoopbackName(parsed.hostname.replace(/^\[|\]$/g, ''))
      && parsed.port === String(port);
  } catch {
    return false;
  }
}

/** Serve one file, guarding against path escapes. */
async function serveFile(res, root, relative) {
  const cleaned = decodeURIComponent(relative).replace(/^\/+/, '');
  const base = path.resolve(root);
  const abs = path.resolve(base, cleaned);
  // A bare startsWith would also admit a sibling such as `app-other/` next to `app/`.
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!(await exists(abs))) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(`Not found: ${cleaned}`);
    return;
  }
  const info = await stat(abs);
  if (info.isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  const type = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'cache-control': 'no-store',
    // tasks-vision wants a cross-origin isolated context for threaded wasm;
    // these two headers make the local page eligible.
    ...(type === 'text/html; charset=utf-8'
      ? { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless' }
      : {}),
  });
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(abs), res);
}

/**
 * Serve a recording with range support, so scrubbing works and the browser only
 * pulls the part it is playing.
 */
async function serveMedia(req, res, abs, mime) {
  const { createReadStream } = await import('node:fs');
  const info = await stat(abs);
  const type = mime || MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');

  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (Number.isNaN(start) || start > end || start >= info.size) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` }).end();
      return;
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${info.size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    await pipeline(createReadStream(abs, { start, end }), res);
    return;
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  });
  await pipeline(createReadStream(abs), res);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!total) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function extensionFor(mime = '') {
  if (mime.includes('mp4')) return mime.startsWith('audio/') ? '.m4a' : '.mp4';
  if (mime.includes('webm')) return mime.startsWith('audio/') ? '.weba' : '.webm';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('matroska')) return '.mkv';
  return '.bin';
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* the printed URL is the fallback */
  }
}

async function listen(server, startPort, attempts = 20) {
  for (let port = startPort; port < startPort + attempts; port += 1) {
    const ok = await new Promise((resolve) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        resolve(err.code === 'EADDRINUSE' ? false : Promise.reject(err));
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    if (ok) return port;
  }
  throw new Error(`No free port in ${startPort}..${startPort + attempts}`);
}

async function vendorStatus() {
  const needed = {
    bundle: 'tasks-vision/vision_bundle.mjs',
    wasm: 'tasks-vision/wasm',
    segmenter: 'models/selfie_segmenter.tflite',
    landmarker: 'models/face_landmarker.task',
  };
  const status = {};
  for (const [key, rel] of Object.entries(needed)) {
    status[key] = await exists(path.join(VENDOR_DIR, rel));
  }
  status.ready = status.bundle && status.wasm;
  return status;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(await readFile(fileURLToPath(import.meta.url), 'utf8').then((s) => s.split('*/')[0]));
    return;
  }

  const script = await loadScript(opts);
  const sessionRoot = path.resolve(opts.out);
  const sessionId = `${stamp()}-${slugify(opts.task || 'take')}`;
  const sessionDir = path.join(sessionRoot, sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, 'script.txt'), script.text, 'utf8');

  const takes = new Map();
  const jobs = new Map();
  let jobSeq = 0;
  let submitted = null;

  /**
   * Run the offline gaze pass on a take.
   *
   * It decodes every frame with ffmpeg, corrects each in a headless browser and
   * re-encodes, so it takes minutes rather than seconds. The browser cannot do
   * that itself, so the page asks for it here and polls.
   */
  function startGazePass(take, options) {
    const id = `job-${(jobSeq += 1)}`;
    const outPath = path.join(sessionDir, `${take.id}-gaze${path.extname(take.path) || '.mp4'}`);
    const args = [
      path.join(HERE, 'gaze-pass.mjs'),
      '--in', take.path,
      '--out', outPath,
      '--strength', String(options.strength ?? 0.6),
      '--lift', String(options.lift ?? 0.26),
      '--port', String(port + 40 + jobSeq),
    ];
    // windowsHide matters: without it Windows opens a console window for the
    // child, which steals focus mid-session and looks like something broke.
    // Nobody should have to see a shell, let alone decide whether to close one.
    const child = spawn(process.execPath, args, {
      cwd: HERE,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const job = { id, takeId: take.id, state: 'running', done: 0, total: 0, stage: 'starting', output: outPath, log: '' };
    jobs.set(id, job);

    const absorb = (chunk) => {
      const text = String(chunk);
      job.log = (job.log + text).slice(-4000);
      const marker = /PROGRESS ([a-z-]+) (\d+) (\d+)/g;
      let hit = null;
      let progress = null;
      while ((hit = marker.exec(text)) !== null) progress = hit;
      if (progress) {
        job.stage = progress[1];
        job.done = Number(progress[2]);
        job.total = Number(progress[3]);
      }
      const summary = /corrected (\d+)\/(\d+) frames, mean shift ([\d.]+) px, max ([\d.]+) px/.exec(text);
      if (summary) {
        job.stats = {
          framesCorrected: Number(summary[1]),
          framesTotal: Number(summary[2]),
          meanShiftPx: Number(summary[3]),
          maxShiftPx: Number(summary[4]),
        };
      }
      const plate = /plate coverage ([\d]+)%/.exec(text);
      if (plate) job.plateCoverage = Number(plate[1]);

      // Only fall back to reading the prose when the chunk carried no marker,
      // or the stage flips back and forth between the two namings.
      if (!progress) {
        if (/decoding/.test(text)) job.stage = 'decoding';
        else if (/reading/.test(text)) job.stage = 'reading';
        else if (/encoding/.test(text)) job.stage = 'encoding';
      }
    };
    child.stdout.on('data', absorb);
    child.stderr.on('data', absorb);

    child.on('close', async (code, signal) => {
      if (code !== 0) {
        job.state = 'failed';
        // A killed pass leaves no output file, and reporting the missing file
        // reads as a bug in the correction rather than as "something stopped
        // it", which is what the person actually did.
        job.error = signal
          ? `the pass was stopped (${signal})`
          : (job.log.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ')
            || `it exited with code ${code}`);
        console.log(`[teleprompter] gaze pass for ${take.id} failed: ${job.error}`);
        return;
      }
      try {
        const info = await stat(outPath);
        const derivedId = `${take.id}-gaze`;
        takes.set(derivedId, {
          id: derivedId,
          file: path.basename(outPath),
          path: outPath,
          mime: 'video/mp4',
          bytes: info.size,
          durationSec: take.durationSec,
          derivedFrom: take.id,
          correction: {
            method: 'offline pass: every frame, clean plate, centred smoothing',
            offline: true,
            plateCoveragePct: job.plateCoverage ?? null,
            ...(job.stats ?? {}),
          },
        });
        await writeFile(path.join(sessionDir, `${derivedId}.json`),
          JSON.stringify(takes.get(derivedId), null, 2), 'utf8');
        job.state = 'done';
        job.derivedId = derivedId;
        job.bytes = info.size;
        console.log(`[teleprompter] gaze pass wrote ${path.basename(outPath)} (${(info.size / 1e6).toFixed(1)} MB)`);
      } catch (err) {
        job.state = 'failed';
        job.error = String(err?.message ?? err);
      }
    });

    return job;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;

    // Only answer requests addressed to this machine by name. Another site can point
    // its own hostname at 127.0.0.1 (DNS rebinding) and would then read the session
    // as if it were same-origin; checking Host closes that. Writes must also come
    // from this server's own page, so another site cannot post to it blind.
    if (!isLoopbackName(hostOf(req.headers.host))) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: open the teleprompter at localhost.');
      return undefined;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && !isOwnOrigin(req.headers.origin, port)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: requests must come from the teleprompter page.');
      return undefined;
    }

    try {
      if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
        return await serveFile(res, APP_DIR, 'index.html');
      }
      if (req.method === 'GET' && route.startsWith('/app/')) {
        return await serveFile(res, APP_DIR, route.slice('/app/'.length));
      }
      if (req.method === 'GET' && route.startsWith('/vendor/')) {
        return await serveFile(res, VENDOR_DIR, route.slice('/vendor/'.length));
      }

      if (req.method === 'GET' && route === '/api/session') {
        return sendJson(res, 200, {
          task: opts.task,
          script: script.text,
          scriptSource: script.source,
          audioOnly: opts.audioOnly,
          sessionId,
          sessionDir,
          waitMode: opts.wait,
          vendor: await vendorStatus(),
          takes: [...takes.values()],
          submitted,
        });
      }

      // Save the script the user edited in the browser.
      if (req.method === 'POST' && route === '/api/script') {
        const body = await readJsonBody(req);
        if (typeof body.text === 'string') {
          script.text = body.text;
          await writeFile(path.join(sessionDir, 'script.txt'), script.text, 'utf8');
        }
        return sendJson(res, 200, { ok: true });
      }

      // Raw media upload: POST /api/takes/<id>/media?mime=video%2Fmp4
      const mediaMatch = route.match(/^\/api\/takes\/([a-zA-Z0-9_-]{1,40})\/media$/);
      if (req.method === 'POST' && mediaMatch) {
        const id = mediaMatch[1];
        const mime = url.searchParams.get('mime') || req.headers['content-type'] || '';
        const file = `${id}${extensionFor(mime)}`;
        const abs = path.join(sessionDir, file);
        await pipeline(req, createWriteStream(abs));
        const info = await stat(abs);
        const take = { ...(takes.get(id) ?? {}), id, file, path: abs, mime, bytes: info.size };
        takes.set(id, take);
        console.log(`[teleprompter] saved ${file} (${(info.size / 1e6).toFixed(1)} MB)`);
        return sendJson(res, 200, take);
      }

      // Play a take back from disk rather than from a blob the page is holding.
      // Holding every take in browser memory is what broke playback past the
      // third one: each blob-backed <video> pins a decoder, and they pile up.
      if (req.method === 'GET' && mediaMatch) {
        const take = takes.get(mediaMatch[1]);
        if (!take?.path) return sendJson(res, 404, { error: `No media for ${mediaMatch[1]}` });
        return await serveMedia(req, res, take.path, take.mime);
      }

      // Discard a take: the file goes, not just the row.
      const takeMatch = route.match(/^\/api\/takes\/([a-zA-Z0-9_-]{1,40})$/);
      if (req.method === 'DELETE' && takeMatch) {
        const id = takeMatch[1];
        const take = takes.get(id);
        if (!take) return sendJson(res, 404, { error: `No take ${id}` });
        if (submitted?.takeId === id) {
          return sendJson(res, 409, { error: `${id} was already submitted, so it stays put.` });
        }
        const removed = [];
        for (const file of [take.path, path.join(sessionDir, `${id}.json`), path.join(sessionDir, `${id}.vtt`)]) {
          if (file && (await exists(file))) {
            await unlink(file);
            removed.push(path.basename(file));
          }
        }
        takes.delete(id);
        console.log(`[teleprompter] discarded ${id} (${removed.join(', ') || 'nothing on disk'})`);
        return sendJson(res, 200, { ok: true, removed });
      }

      const passMatch = route.match(/^\/api\/takes\/([a-zA-Z0-9_-]{1,40})\/gaze-pass$/);
      if (req.method === 'POST' && passMatch) {
        const take = takes.get(passMatch[1]);
        if (!take?.path) return sendJson(res, 404, { error: `No media for ${passMatch[1]}` });
        const body = await readJsonBody(req);
        const job = startGazePass(take, body);
        return sendJson(res, 202, { jobId: job.id });
      }

      const jobMatch = route.match(/^\/api\/jobs\/([a-zA-Z0-9_-]{1,40})$/);
      if (req.method === 'GET' && jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) return sendJson(res, 404, { error: 'no such job' });
        return sendJson(res, 200, job);
      }

      // Metadata + cue list for a take.
      const metaMatch = route.match(/^\/api\/takes\/([a-zA-Z0-9_-]{1,40})\/meta$/);
      if (req.method === 'POST' && metaMatch) {
        const id = metaMatch[1];
        const body = await readJsonBody(req);
        const take = { ...(takes.get(id) ?? { id }), ...body, id };
        takes.set(id, take);
        await writeFile(path.join(sessionDir, `${id}.json`), JSON.stringify(take, null, 2), 'utf8');
        if (typeof body.vtt === 'string' && body.vtt.trim()) {
          await writeFile(path.join(sessionDir, `${id}.vtt`), body.vtt, 'utf8');
        }
        return sendJson(res, 200, take);
      }

      if (req.method === 'POST' && route === '/api/submit') {
        const body = await readJsonBody(req);
        const take = takes.get(body.id);
        if (!take?.path) return sendJson(res, 404, { error: `No stored media for take ${body.id}` });

        submitted = {
          task: opts.task,
          note: body.note ?? '',
          submittedAt: new Date().toISOString(),
          sessionId,
          sessionDir,
          media: take.path,
          mime: take.mime,
          bytes: take.bytes,
          durationSec: take.durationSec ?? null,
          scriptFile: path.join(sessionDir, 'script.txt'),
          cueFile: (await exists(path.join(sessionDir, `${take.id}.vtt`)))
            ? path.join(sessionDir, `${take.id}.vtt`)
            : null,
          metaFile: path.join(sessionDir, `${take.id}.json`),
          gaze: take.gaze ?? null,
          background: take.background ?? null,
          takeId: take.id,
        };

        await writeFile(path.join(sessionDir, 'submission.json'), JSON.stringify(submitted, null, 2), 'utf8');
        await writeFile(path.join(sessionRoot, 'latest.json'), JSON.stringify(submitted, null, 2), 'utf8');

        sendJson(res, 200, { ok: true, submitted });

        console.log('');
        console.log('=== TELEPROMPTER SUBMISSION ===');
        console.log(`TASK:     ${opts.task || '(unlabelled)'}`);
        console.log(`MEDIA:    ${submitted.media}`);
        console.log(`DURATION: ${submitted.durationSec ? `${submitted.durationSec.toFixed(1)}s` : 'unknown'}`);
        if (submitted.cueFile) console.log(`CUES:     ${submitted.cueFile}`);
        console.log(`SCRIPT:   ${submitted.scriptFile}`);
        console.log(`MANIFEST: ${path.join(sessionDir, 'submission.json')}`);
        if (submitted.note) console.log(`NOTE:     ${submitted.note}`);
        console.log('=== END SUBMISSION ===');

        if (opts.wait) {
          console.log('[teleprompter] --wait was set, shutting down.');
          setTimeout(() => process.exit(0), 250);
        }
        return undefined;
      }

      // Client-side diagnostics land in this terminal, so a failing enhancer is
      // visible without opening devtools.
      if (req.method === 'POST' && route === '/api/log') {
        const body = await readJsonBody(req, 256 * 1024);
        console.log(`[app:${body.level ?? 'info'}] ${body.message ?? ''}`);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && route === '/api/files') {
        return sendJson(res, 200, { files: await readdir(sessionDir) });
      }

      if (req.method === 'GET' && route === '/api/health') {
        return sendJson(res, 200, { ok: true, sessionId });
      }

      return sendJson(res, 404, { error: `No route for ${req.method} ${route}` });
    } catch (err) {
      console.error(`[teleprompter] ${req.method} ${route} failed:`, err?.message ?? err);
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) });
      else res.end();
      return undefined;
    }
  });

  const port = await listen(server, opts.port);
  const url = `http://localhost:${port}/`;
  const vendor = await vendorStatus();

  console.log('');
  console.log(`  Teleprompter ready   ${url}`);
  console.log(`  Session folder       ${sessionDir}`);
  console.log(`  Task                 ${opts.task || '(unlabelled)'}`);
  console.log(`  Script               ${script.source}`);
  console.log(`  Camera               ${opts.audioOnly ? 'off (audio only)' : 'on'}`);
  console.log(
    `  Background / gaze    ${vendor.ready ? 'models vendored' : `not vendored. Run: node "${path.join(HERE, 'fetch-models.mjs')}"`}`,
  );
  console.log('');
  console.log('  Open the localhost URL, not the LAN address: the browser only grants');
  console.log('  camera and microphone access on localhost without TLS.');
  console.log(opts.wait ? '  Waiting for a submitted take, then exiting.' : '  Ctrl+C when you are done.');
  console.log('');

  if (opts.open) openBrowser(url);
}

main().catch((err) => {
  console.error('[teleprompter] fatal:', err);
  process.exit(1);
});
