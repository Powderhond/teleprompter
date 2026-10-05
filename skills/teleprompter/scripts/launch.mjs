#!/usr/bin/env node
/**
 * Start the teleprompter and get out of the way.
 *
 * The server has to outlive whatever started it. A recording session is minutes
 * of someone reading, re-reading and running a correction pass, and an agent's
 * background task gets reaped long before that. So this spawns the server
 * detached, waits only until it answers, prints where it is, and exits. The
 * server carries on with no parent.
 *
 *   node scripts/launch.mjs --task "intro voiceover"
 *   node scripts/launch.mjs --status
 *   node scripts/launch.mjs --stop
 *
 * Options beyond --status, --stop and --restart are passed straight through to
 * server.mjs, so --script, --text, --audio-only, --out and --port all work.
 *
 * The server runs in the caller's working directory, not next to this file, so
 * a relative --script resolves where the caller expects and recordings land in
 * the caller's project rather than wherever the skill happens to be installed.
 */

import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function argValue(argv, flag, fallback = null) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function stateFile(outRoot) {
  return path.join(path.resolve(outRoot), 'server.json');
}

async function readState(outRoot) {
  try {
    return JSON.parse(await readFile(stateFile(outRoot), 'utf8'));
  } catch {
    return null;
  }
}

async function health(port, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function killPid(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', shell: true });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      resolve();
    }
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const outRoot = argValue(argv, '--out', '.teleprompter');
  await mkdir(path.resolve(outRoot), { recursive: true });

  const existing = await readState(outRoot);
  const live = existing ? await health(existing.port) : null;

  if (argv.includes('--status')) {
    if (live) {
      console.log(`  running   ${existing.url}`);
      console.log(`  task      ${live.task || '(unlabelled)'}`);
      console.log(`  session   ${live.sessionDir}`);
      console.log(`  pid       ${existing.pid}`);
    } else {
      console.log('  not running');
    }
    return;
  }

  if (argv.includes('--stop')) {
    if (!existing) { console.log('  not running'); return; }
    await killPid(existing.pid);
    try { await unlink(stateFile(outRoot)); } catch { /* fine */ }
    console.log(`  stopped   pid ${existing.pid}`);
    return;
  }

  if (live && !argv.includes('--restart')) {
    console.log('');
    console.log(`  Already running   ${existing.url}`);
    console.log(`  Task              ${live.task || '(unlabelled)'}`);
    console.log(`  Session           ${live.sessionDir}`);
    console.log('');
    console.log('  Pass --restart to start a fresh session, or --stop to shut it down.');
    console.log('');
    return;
  }

  if (existing) {
    await killPid(existing.pid);
    try { await unlink(stateFile(outRoot)); } catch { /* fine */ }
  }

  const passThrough = argv.filter((a) => !['--status', '--stop', '--restart'].includes(a));
  const outAt = passThrough.indexOf('--out');
  if (outAt >= 0) passThrough[outAt + 1] = path.resolve(outRoot);
  else passThrough.push('--out', path.resolve(outRoot));

  const logPath = path.join(path.resolve(outRoot), 'server.log');
  const log = openSync(logPath, 'a');

  // Detached, with its own stdio, so nothing upstream can take it down and the
  // output survives for anyone who wants to read what happened.
  const child = spawn(process.execPath, [path.join(HERE, 'server.mjs'), ...passThrough], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();

  // Find the port it settled on. It climbs if the preferred one is busy.
  const preferred = Number(argValue(argv, '--port', '4455'));
  const deadline = Date.now() + 20000;
  let found = null;
  while (Date.now() < deadline && !found) {
    for (let port = preferred; port < preferred + 20; port += 1) {
      const session = await health(port, 400);
      if (session) { found = { port, session }; break; }
    }
    if (!found) await new Promise((r) => setTimeout(r, 400));
  }

  if (!found) {
    console.error(`\n  The teleprompter did not come up. Its log is at ${logPath}\n`);
    process.exit(1);
  }

  const url = `http://localhost:${found.port}/`;
  await writeFile(stateFile(outRoot), `${JSON.stringify({
    pid: child.pid,
    port: found.port,
    url,
    task: found.session.task,
    sessionDir: found.session.sessionDir,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(`  Teleprompter ready   ${url}`);
  console.log(`  Task                 ${found.session.task || '(unlabelled)'}`);
  console.log(`  Session folder       ${found.session.sessionDir}`);
  console.log(`  Log                  ${logPath}`);
  console.log('');
  console.log('  It keeps running after this command exits.');
  console.log(`  Stop it with: node "${path.join(HERE, 'launch.mjs')}" --stop${outRoot === '.teleprompter' ? '' : ` --out "${path.resolve(outRoot)}"`}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n  launch failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
