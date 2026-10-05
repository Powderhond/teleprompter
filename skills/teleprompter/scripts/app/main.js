import { Prompter, cuesToVtt, formatClock } from '/app/prompter.js';
import {
  Compositor,
  Recorder,
  SilenceGate,
  buildRecordingStream,
  cloneForRecording,
  extensionFor,
  initSegmentLength,
  inspectContainer,
  listDevices,
  measureLoudness,
  openStream,
  pickMime,
  primePermission,
  probePlayable,
} from '/app/capture.js';
import { createFaceLandmarker, createSegmenter, GazeMeter } from '/app/vision.js';
import { GazeCorrector } from '/app/gaze-correct.js';

const $ = (id) => document.getElementById(id);
const PREFS_KEY = 'teleprompter.prefs.v1';

const el = {
  body: document.body,
  stage: $('stage'),
  inner: $('scrollInner'),
  script: $('scriptBody'),
  focusBand: $('focusBand'),
  lens: $('lensMarker'),
  countdown: $('countdown'),
  pip: $('pip'),
  preview: $('preview'),
  composite: $('composite'),
  gazeHud: $('gazeHud'),
  gazeDot: $('gazeDot'),
  gazeScore: $('gazeScore'),
  pipNote: $('pipNote'),
  taskLabel: $('taskLabel'),
  scriptSource: $('scriptSource'),
  clock: $('clock'),
  pace: $('paceReadout'),
  btnPerform: $('btnPerform'),
  btnFullscreen: $('btnFullscreen'),
  btnRecord: $('btnRecord'),
  selVideo: $('selVideo'),
  selAudio: $('selAudio'),
  selRes: $('selRes'),
  selFormat: $('selFormat'),
  btnRefresh: $('btnRefresh'),
  btnMirrorCam: $('btnMirrorCam'),
  deviceNote: $('deviceNote'),
  levelMeter: $('levelMeter'),
  levelBar: $('levelBar'),
  levelText: $('levelText'),
  wpm: $('wpm'),
  wpmOut: $('wpmOut'),
  fontSize: $('fontSize'),
  sizeOut: $('sizeOut'),
  colWidth: $('colWidth'),
  colOut: $('colOut'),
  btnMirrorText: $('btnMirrorText'),
  btnHoldSilence: $('btnHoldSilence'),
  placeGrid: $('placeGrid'),
  estimate: $('estimate'),
  bgModes: $('bgModes'),
  blurAmount: $('blurAmount'),
  blurOut: $('blurOut'),
  bgColour: $('bgColour'),
  bgImage: $('bgImage'),
  bgNote: $('bgNote'),
  btnGaze: $('btnGaze'),
  btnCalibrate: $('btnCalibrate'),
  gazeNote: $('gazeNote'),
  gazeStrength: $('gazeStrength'),
  gazeStrengthOut: $('gazeStrengthOut'),
  btnBackTop: $('btnBackTop'),
  btnRetake: $('btnRetake'),
  btnEditScript: $('btnEditScript'),
  btnRestart: $('btnRestart'),
  scriptEditor: $('scriptEditor'),
  editorActions: $('editorActions'),
  btnSaveScript: $('btnSaveScript'),
  btnCancelScript: $('btnCancelScript'),
  takeList: $('takeList'),
  toast: $('toast'),
  dialog: $('submitDialog'),
  submitSummary: $('submitSummary'),
  submitNote: $('submitNote'),
};

const state = {
  session: null,
  stream: null,
  mime: '',
  recording: false,
  takes: [],
  takeSeq: 0,
  cues: [],
  recordStart: 0,
  pendingTakeId: null,
  segmenter: null,
  segmenterLoading: false,
  landmarker: null,
  landmarkerLoading: false,
  gazeOn: false,
  // Cached ftyp+moov from the first healthy MP4 of this session, used to repair
  // a later one that comes back without its own.
  initSegment: null,
  forceWebm: false,
  correcting: false,
  corrector: null,
  holdSilence: false,
  endNoted: false,
  prefs: {
    wpm: 140,
    fontSize: 46,
    colWidth: 26,
    mirrorText: false,
    mirrorCam: true,
    lens: { x: 0.5, y: 0.08 },
    bg: 'none',
    pip: null,
    format: 'mp4',
    gazeStrength: 60,
    blur: 14,
    colour: '#132a2f',
    videoId: '',
    audioId: '',
    res: '1280x720',
  },
};

const recorder = new Recorder();
const compositor = new Compositor(el.preview, el.composite);
const gate = new SilenceGate();
let gazeMeter = null;
let prompter = null;

/* ---------------- plumbing ---------------- */

function toast(message, bad = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('bad', bad);
  el.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.toast.hidden = true; }, bad ? 7000 : 3200);
}

function report(message, level = 'info') {
  fetch('/api/log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level, message: String(message).slice(0, 2000) }),
  }).catch(() => {});
}

window.addEventListener('error', (event) => report(`window error: ${event.message}`, 'error'));
window.addEventListener('unhandledrejection', (event) =>
  report(`unhandled rejection: ${event.reason?.message ?? event.reason}`, 'error'));

function loadPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    state.prefs = { ...state.prefs, ...stored, lens: { ...state.prefs.lens, ...(stored.lens ?? {}) } };
  } catch { /* defaults are fine */ }
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch { /* private mode */ }
}

/* ---------------- devices ---------------- */

function fillSelect(select, devices, selectedId, fallbackLabel) {
  select.textContent = '';
  if (!devices.length) {
    const option = document.createElement('option');
    option.textContent = `No ${fallbackLabel} found`;
    option.value = '';
    select.appendChild(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  devices.forEach((device, i) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `${fallbackLabel} ${i + 1}`;
    if (device.deviceId === selectedId) option.selected = true;
    select.appendChild(option);
  });
}

async function refreshDevices() {
  const { video, audio } = await listDevices();
  fillSelect(el.selVideo, video, state.prefs.videoId, 'camera');
  fillSelect(el.selAudio, audio, state.prefs.audioId, 'microphone');
  el.deviceNote.textContent =
    `${video.length} camera(s), ${audio.length} microphone(s). Plug gear in, then Rescan.`;
  if (state.session?.audioOnly) {
    el.selVideo.disabled = true;
    el.selRes.disabled = true;
  }
}

async function startStream() {
  const [width, height] = (el.selRes.value || '1280x720').split('x').map(Number);
  state.prefs.videoId = el.selVideo.value || '';
  state.prefs.audioId = el.selAudio.value || '';
  state.prefs.res = el.selRes.value;
  savePrefs();

  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = await openStream({
    videoId: state.prefs.videoId,
    audioId: state.prefs.audioId,
    width,
    height,
    audioOnly: Boolean(state.session?.audioOnly),
  });

  el.preview.srcObject = state.stream;
  await el.preview.play().catch(() => {});
  gate.attach(state.stream);

  const track = state.stream.getVideoTracks()[0];
  if (track) {
    // getSettings leaves width and height out on some drivers, so fall back to
    // what the element actually decoded.
    if (!el.preview.videoWidth) {
      await new Promise((resolve) => {
        el.preview.addEventListener('loadedmetadata', resolve, { once: true });
        setTimeout(resolve, 2500);
      });
    }
    const settings = track.getSettings?.() ?? {};
    const width = settings.width ?? el.preview.videoWidth;
    const height = settings.height ?? el.preview.videoHeight;
    el.deviceNote.textContent = width
      ? `Live: ${width}x${height} at ${Math.round(settings.frameRate ?? 30)} fps.`
      : 'Microphone is live. The camera gave no frame size.';
  }
  if (compositor.needsPipeline) compositor.start();
}

/* ---------------- prompter wiring ---------------- */

function applyTypography() {
  document.documentElement.style.setProperty('--read-size', `${state.prefs.fontSize}px`);
  document.documentElement.style.setProperty('--read-col', `${state.prefs.colWidth}ch`);
  el.sizeOut.value = state.prefs.fontSize;
  el.colOut.value = state.prefs.colWidth;
  el.script.classList.toggle('mirrored', state.prefs.mirrorText);
  el.btnMirrorText.setAttribute('aria-pressed', String(state.prefs.mirrorText));
  prompter?.layout();
  // ch resolves against the font size of whatever element uses it, so the
  // 13px panel cannot work out how wide a 46px reading column is. Measure it
  // once here and publish the answer in pixels.
  document.documentElement.style.setProperty('--read-col-px', `${el.script.offsetWidth}px`);
  updatePace();
}

function markPlace() {
  const { x, y } = state.prefs.lens;
  for (const button of el.placeGrid.children) {
    const near = Math.abs(Number(button.dataset.x) - x) < 0.06
      && Math.abs(Number(button.dataset.y) - y) < 0.06;
    button.setAttribute('aria-pressed', String(near));
  }
}

function applyLens() {
  const { x, y } = state.prefs.lens;
  document.documentElement.style.setProperty('--lens-x', `${(x * 100).toFixed(2)}%`);
  document.documentElement.style.setProperty('--lens-y', `${(y * 100).toFixed(2)}%`);
  // In perform mode the reading band goes to the lens; in setup it sits lower so
  // the whole script is visible while you edit.
  // Follow the chosen position in setup as well. Having it only take effect
  // after pressing F means choosing a position blind, then discovering it.
  prompter?.setFocusFraction(Math.max(0.1, y + 0.04));
  markPlace();
}

function updatePace() {
  if (!prompter) return;
  el.wpmOut.value = prompter.wpm;
  const total = prompter.estimateSeconds();
  const words = prompter.totalWords();
  el.estimate.textContent =
    `${words} spoken words, about ${formatClock(total)} at ${prompter.wpm} wpm.`;
  if (!state.recording) {
    el.clock.textContent = formatClock(total);
    el.pace.textContent = `${prompter.wpm} wpm`;
  } else {
    el.pace.textContent = `${formatClock(prompter.remainingSeconds())} of script left`;
  }
}

function onBlockChange(info) {
  if (!state.recording) return;
  const t = (performance.now() - state.recordStart) / 1000;
  state.cues.push({
    index: info.index,
    kind: info.block?.kind ?? 'line',
    text: info.block?.text ?? '',
    t,
  });
}

/* ---------------- main loop ---------------- */

let lastFrame = performance.now();
let gazeAccumulator = 0;

function loop(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (prompter) {
    const held = state.holdSilence && state.recording && !gate.speaking();
    if (!held) prompter.tick(dt);

    if (prompter.atEnd() && state.recording && !state.endNoted) {
      state.endNoted = true;
      toast('End of script. Press R when you are done talking.');
    }
  }

  if (state.recording) {
    el.clock.textContent = formatClock((performance.now() - state.recordStart) / 1000);
    el.pace.textContent = `${formatClock(prompter?.remainingSeconds() ?? 0)} of script left`;
  }

  // Input level, always, with a held peak.
  //
  // This is the microphone test. Recording two seconds and playing it back told
  // you less than a bar that moves while you talk, and took longer.
  el.levelMeter.dataset.attached = gate.analyser ? 'yes' : 'no';
  el.levelMeter.dataset.ctx = gate.ctx?.state ?? 'none';
  if (gate.analyser) {
    const level = gate.rms();
    el.levelMeter.dataset.rms = level.toFixed(5);

    // Every term guarded. An uninitialised peak made this NaN on the first
    // frame, and NaN compares false against everything, so the meter read dead
    // silence for a microphone that was working perfectly.
    const previous = Number.isFinite(state.peakLevel) ? state.peakLevel : 0;
    state.peakLevel = Math.max(level, previous * 0.85);

    const now = performance.now();
    if (!Number.isFinite(state.peakHold) || level >= state.peakHold || now - state.peakHeldAt > 1800) {
      state.peakHold = level;
      state.peakHeldAt = now;
    }

    const toDb = (v) => (v > 1e-6 ? 20 * Math.log10(v) : -100);
    const db = toDb(state.peakLevel);
    const holdDb = toDb(state.peakHold);
    el.levelBar.style.width = `${(Math.max(0, Math.min(1, (db + 60) / 60)) * 100).toFixed(1)}%`;

    const trustworthy = gate.live;
    const flat = trustworthy && db < -55;
    if (!flat) state.silentSince = now;
    const quietFor = flat ? (now - state.silentSince) / 1000 : 0;
    el.levelMeter.classList.toggle('silent', quietFor > 3);
    el.levelText.textContent = !trustworthy
      ? 'click anywhere to start the meter'
      : quietFor > 3
        ? 'no sound from this microphone'
        : `${db <= -99 ? '--' : db.toFixed(0)} dB   peak ${holdDb <= -99 ? '--' : holdDb.toFixed(0)}`;
  }

  gazeAccumulator += dt;
  if (state.gazeOn && gazeMeter && gazeAccumulator > 0.08) {
    gazeAccumulator = 0;
    const reading = gazeMeter.update(el.preview);
    if (reading) paintGaze(reading);
  }

  requestAnimationFrame(loop);
}

function paintGaze(reading) {
  const limit = 9;
  const x = Math.max(-limit, Math.min(limit, reading.dx * 90));
  const y = Math.max(-limit, Math.min(limit, reading.dy * 90));
  el.gazeDot.style.transform = `translate(${x}px, ${y}px)`;
  el.gazeHud.classList.toggle('off', !reading.hasFace || reading.score < 60);
  el.gazeScore.textContent = reading.hasFace
    ? `${reading.score} ${reading.hint}`
    : 'no face';
}

/* ---------------- background ---------------- */

async function ensureSegmenter() {
  if (state.segmenter || state.segmenterLoading) return state.segmenter;
  if (!state.session?.vendor?.ready || !state.session?.vendor?.segmenter) {
    el.bgNote.textContent =
      'Models are not vendored yet. Run scripts/fetch-models.mjs in the skill folder, then reload.';
    return null;
  }
  state.segmenterLoading = true;
  el.bgNote.textContent = 'Loading the segmentation model.';
  try {
    state.segmenter = await createSegmenter();
    compositor.setSegmenter(state.segmenter);
    el.bgNote.textContent = 'Segmentation running on the live stream and into the recording.';
  } catch (err) {
    el.bgNote.textContent = `Segmenter failed to load: ${err?.message ?? err}`;
    report(`segmenter load failed: ${err?.message ?? err}`, 'error');
  } finally {
    state.segmenterLoading = false;
  }
  return state.segmenter;
}

async function setBackground(mode) {
  if (state.session?.audioOnly) {
    toast('Audio-only session, so there is no picture to replace.');
    return;
  }
  if (mode !== 'none' && !(await ensureSegmenter())) {
    [...el.bgModes.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.bg === 'none')));
    return;
  }
  state.prefs.bg = mode;
  savePrefs();
  compositor.setMode(mode);
  [...el.bgModes.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.bg === mode)));
  el.pip.classList.toggle('composited', compositor.needsPipeline);
  if (compositor.needsPipeline) compositor.start();
  else compositor.stop();
  if (mode === 'none') el.bgNote.textContent = 'Camera recorded as it comes in.';
}

compositor.onError = (err) => {
  report(`compositor stopped: ${err?.message ?? err}`, 'error');
  el.bgNote.textContent = `Pipeline stopped: ${err?.message ?? err}`;
  setBackground('none');
};

/* ---------------- gaze ---------------- */

async function toggleGaze(force) {
  const next = force ?? !state.gazeOn;
  if (next && !gazeMeter) {
    if (!state.session?.vendor?.landmarker) {
      el.gazeNote.textContent =
        'face_landmarker.task is not vendored. Run scripts/fetch-models.mjs in the skill folder.';
      return;
    }
    if (state.landmarkerLoading) return;
    state.landmarkerLoading = true;
    el.gazeNote.textContent = 'Loading the face landmark model.';
    try {
      state.landmarker = await createFaceLandmarker();
      gazeMeter = new GazeMeter(state.landmarker);
      el.gazeNote.textContent = 'Look into the lens and press Calibrate to set the baseline.';
    } catch (err) {
      el.gazeNote.textContent = `Landmarker failed to load: ${err?.message ?? err}`;
      report(`landmarker load failed: ${err?.message ?? err}`, 'error');
      state.landmarkerLoading = false;
      return;
    }
    state.landmarkerLoading = false;
  }
  state.gazeOn = next && Boolean(gazeMeter);
  el.btnGaze.setAttribute('aria-pressed', String(state.gazeOn));
  el.gazeHud.hidden = !state.gazeOn;
}

/* ---------------- recording ---------------- */

async function countdown(from = 3) {
  el.countdown.hidden = false;
  for (let n = from; n > 0; n -= 1) {
    el.countdown.firstElementChild.textContent = String(n);
    await new Promise((r) => setTimeout(r, 700));
  }
  el.countdown.hidden = true;
}

async function startRecording() {
  if (state.recording) return;
  if (!state.stream) {
    toast('No camera or microphone stream yet.', true);
    return;
  }
  const prefer = state.forceWebm ? 'webm' : state.prefs.format;
  state.mime = pickMime(Boolean(state.session?.audioOnly), prefer);
  if (!state.mime) {
    toast('This browser has no usable MediaRecorder format. Try Chrome or Edge.', true);
    return;
  }

  // Warn, never block. A meter can be wrong about a working microphone, and
  // refusing to record on its say-so loses a take that would have been fine.
  // The authoritative check is the take itself, measured once it exists.
  if (gate.live && state.silentSince && (performance.now() - state.silentSince) / 1000 > 3) {
    toast('That microphone is reading silent. Recording anyway, and the take will be checked.', true);
  }

  if (state.holdSilence) await gate.calibrate(900);
  await countdown(3);

  // Video is cloned per take so the encoder starts cold and a device change
  // cannot pull the source from under a running recording. Audio is tapped off
  // the Web Audio graph instead, because cloning a live microphone and stopping
  // the clone is what kept producing silent takes on real hardware.
  const videoTracks = compositor.needsPipeline
    ? compositor.videoTracks(30)
    : cloneForRecording(state.stream).getVideoTracks();
  const audioTrack = gate.tap()?.getAudioTracks()[0] ?? null;
  if (!audioTrack && !state.session?.audioOnly) {
    report('no audio tap available for this take', 'error');
  }
  const target = buildRecordingStream(videoTracks, audioTrack);

  state.cues = [];
  state.endNoted = false;
  gazeMeter?.reset();
  state.recordStart = performance.now();

  try {
    recorder.start(target, state.mime);
  } catch (err) {
    toast(`Recorder refused to start: ${err?.message ?? err}`, true);
    report(`recorder start failed: ${err?.message ?? err}`, 'error');
    return;
  }

  state.recording = true;
  el.body.dataset.state = 'recording';
  el.btnRecord.textContent = 'Stop';
  const block = prompter.blocks[prompter.activeIndex];
  state.cues.push({ index: prompter.activeIndex, kind: block?.kind ?? 'line', text: block?.text ?? '', t: 0 });
  prompter.play();
  toast('Recording.');
}

async function stopRecording() {
  if (!state.recording) return;
  prompter.pause();
  state.recording = false;
  el.body.dataset.state = 'idle';
  el.btnRecord.textContent = 'Record';

  let result;
  try {
    result = await recorder.stop();
  } catch (err) {
    toast(`Recording failed: ${err?.message ?? err}`, true);
    report(`recorder stop failed: ${err?.message ?? err}`, 'error');
    return;
  } finally {
    // Release the tap whatever happened, so the next take gets a fresh one and
    // the graph is not left with a dangling destination node.
    gate.untap();
  }

  state.takeSeq += 1;
  const id = `take-${String(state.takeSeq).padStart(2, '0')}`;
  const take = {
    id,
    mime: result.mime,
    durationSec: result.durationSec,
    bytes: result.blob.size,
    url: URL.createObjectURL(result.blob),
    cues: state.cues.slice(),
    gaze: gazeMeter?.summary() ?? null,
    background: compositor.needsPipeline ? { mode: compositor.mode, blurPx: compositor.blurPx } : null,
    wpm: prompter.wpm,
    recordedAt: new Date().toISOString(),
    saved: false,
  };
  state.takes.unshift(take);
  renderTakes();
  toast(`${id} recorded, ${formatClock(result.durationSec)}. Checking it.`);

  // Measured off the critical path. Decoding a video container's audio can take
  // a while, and the take should be on screen before it finishes, not after.
  measureLoudness(result.blob).then((rms) => {
    take.audioRms = rms;
    take.silent = rms !== null && rms < 0.0005;
    renderTakes();
    if (take.silent) {
      toast(`${id} came back with no sound on it. Check the microphone before the next take.`, true);
      report(`take ${id} recorded silence (rms ${rms})`, 'error');
    }
  });

  const checked = await ensurePlayable(take, result.blob);
  await uploadTake(take, checked.blob);

  if (checked.blob.size && take.saved) {
    const played = await probePlayable(`/api/takes/${take.id}/media`);
    take.playable = played.ok;
    take.playableDetail = played.detail;
    renderTakes();
    if (!played.ok) {
      toast(`${id} saved but will not open: ${played.detail}. Switching to WebM for the next take.`, true);
      report(`saved take not playable: ${played.detail}`, 'error');
      state.forceWebm = true;
    }
  }
}

/**
 * Make sure what we are about to save is a file a player can open.
 *
 * Chrome's MP4 recorder can stop emitting the ftyp/moov initialisation segment
 * once its hardware encoder has been reused, leaving a run of bare fragments
 * that is the right size and completely unplayable. When that happens the
 * session's cached init segment is spliced back on, and the repair is only
 * accepted if the result actually opens.
 */
async function ensurePlayable(take, blob) {
  const container = await inspectContainer(blob);
  take.container = container;

  if (container.valid) {
    if (container.kind === 'mp4' && !state.initSegment) {
      const length = await initSegmentLength(blob);
      if (length) state.initSegment = blob.slice(0, length);
    }
    return { blob, repaired: false };
  }

  report(`take ${take.id} came back without an init segment (first atom "${container.tag}")`, 'error');

  if (container.kind === 'mp4' && state.initSegment) {
    const repaired = new Blob([state.initSegment, blob], { type: take.mime });
    const url = URL.createObjectURL(repaired);
    const played = await probePlayable(url);
    URL.revokeObjectURL(url);
    if (played.ok) {
      take.repaired = true;
      take.bytes = repaired.size;
      toast(`${take.id} came back without its header. Repaired it from this session's first take.`);
      return { blob: repaired, repaired: true };
    }
  }

  take.damaged = true;
  state.forceWebm = true;
  toast(
    `${take.id} came back unplayable from the browser's recorder. The bytes are kept, and the next take will use WebM.`,
    true,
  );
  return { blob, repaired: false };
}

/**
 * Push a take to the session folder, then drop the in-memory blob. Playback
 * switches to the server copy, so the page stops carrying the recording around.
 */
async function uploadTake(take, blob, extra = {}) {
  try {
    const stored = await fetch(`/api/takes/${take.id}/media?mime=${encodeURIComponent(take.mime)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: blob,
    }).then((r) => r.json());

    const vtt = cuesToVtt(take.cues ?? [], take.durationSec);
    await fetch(`/api/takes/${take.id}/meta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        durationSec: take.durationSec,
        bytes: take.bytes,
        mime: take.mime,
        wpm: take.wpm,
        recordedAt: take.recordedAt,
        cues: take.cues ?? [],
        gaze: take.gaze,
        background: take.background,
        audioRms: take.audioRms ?? null,
        silent: Boolean(take.silent),
        extension: extensionFor(take.mime),
        vtt,
        ...extra,
      }),
    });

    take.saved = true;
    take.path = stored.path;

    const card = takeCards.get(take.id);
    releasePlayer(card?.player);
    if (take.url) {
      URL.revokeObjectURL(take.url);
      take.url = null;
    }
    renderTakes();
    toast(`${take.id} saved to the session folder.`);
  } catch (err) {
    toast(`${take.id} is in the browser but did not save: ${err?.message ?? err}`, true);
    report(`take upload failed: ${err?.message ?? err}`, 'error');
  }
}

/**
 * Take cards are built once and updated in place.
 *
 * Rebuilding the list on every change is what broke playback past the third
 * take: each rebuild made fresh <video> elements, the old ones kept their
 * decoders, and the browser eventually refused to open another. Media also
 * streams from disk rather than from a blob the page is holding, so a long
 * session does not sit on hundreds of megabytes.
 */
const takeCards = new Map();

function releasePlayer(player) {
  if (!player) return;
  try {
    player.pause();
    player.removeAttribute('src');
    player.load();
  } catch { /* already torn down */ }
}

function takeSummary(take) {
  const bits = [formatClock(take.durationSec), `${(take.bytes / 1e6).toFixed(1)} MB`];
  if (take.correction) {
    // An offline pass reports different numbers from the in-browser one, and a
    // card must never throw over a field one of them does not carry.
    const c = take.correction;
    if (Number.isFinite(c.meanShiftPx)) bits.push(`iris moved ${c.meanShiftPx.toFixed(1)} px`);
    if (Number.isFinite(c.framesCorrected)) bits.push(`${c.framesCorrected}/${c.framesTotal} frames`);
    if (!Number.isFinite(c.meanShiftPx) && !Number.isFinite(c.framesCorrected)) bits.push('gaze corrected');
  } else if (take.gaze?.calibrated) {
    bits.push(`${take.gaze.onLensPct}% on lens`);
  }
  return bits.join(' · ');
}

function buildTakeCard(take) {
  const li = document.createElement('li');
  li.className = 'take';

  const player = document.createElement(state.session?.audioOnly ? 'audio' : 'video');
  player.controls = true;
  // Nothing loads until the card is actually played.
  player.preload = 'none';
  li.appendChild(player);

  const meta = document.createElement('div');
  meta.className = 'take-meta';
  const left = document.createElement('span');
  const right = document.createElement('span');
  meta.append(left, right);
  li.appendChild(meta);

  const progress = document.createElement('div');
  progress.className = 'take-progress';
  progress.hidden = true;
  const bar = document.createElement('i');
  const label = document.createElement('span');
  progress.append(bar, label);
  li.appendChild(progress);

  const row = document.createElement('div');
  row.className = 'row wrap';
  const submit = document.createElement('button');
  submit.className = 'primary small';
  const compare = document.createElement('div');
  compare.className = 'take-compare';
  compare.hidden = true;
  const beforeImg = document.createElement('img');
  const afterImg = document.createElement('img');
  const compareNote = document.createElement('p');
  compareNote.className = 'note';
  compare.append(beforeImg, afterImg, compareNote);
  li.appendChild(compare);

  const preview = document.createElement('button');
  preview.className = 'ghost small';
  preview.textContent = 'Preview gaze';
  const correct = document.createElement('button');
  correct.className = 'ghost small';
  correct.textContent = 'Correct gaze';
  const discard = document.createElement('button');
  discard.className = 'ghost small danger';
  discard.textContent = 'Discard';
  const download = document.createElement('a');
  download.className = 'muted take-download';
  download.textContent = 'Save a copy';
  row.append(submit, preview, correct, discard, download);
  li.appendChild(row);

  submit.addEventListener('click', () => openSubmit(take));
  preview.addEventListener('click', () => previewGaze(take));
  correct.addEventListener('click', () => correctGaze(take));
  discard.addEventListener('click', () => discardTake(take));

  const card = {
    li, player, left, right, submit, preview, correct, discard, download,
    progress, bar, label, compare, beforeImg, afterImg, compareNote,
  };
  takeCards.set(take.id, card);
  return card;
}

function renderTakes() {
  const empty = el.takeList.querySelector('.empty');
  if (!state.takes.length) {
    if (!empty) {
      el.takeList.textContent = '';
      const li = document.createElement('li');
      li.className = 'muted empty';
      li.textContent = 'Nothing recorded yet.';
      el.takeList.appendChild(li);
    }
    return;
  }
  empty?.remove();

  for (const take of state.takes) {
    const card = takeCards.get(take.id) ?? buildTakeCard(take);
    const src = take.saved ? `/api/takes/${take.id}/media` : take.url;
    if (card.player.getAttribute('src') !== src) card.player.setAttribute('src', src);

    card.li.classList.toggle('submitted', Boolean(take.submitted));
    card.li.classList.toggle('derived', Boolean(take.correction));
    card.left.textContent = `${take.id}${take.correction ? ' (gaze)' : ''} · ${takeSummary(take)}`;
    const status = take.silent
    ? 'no sound'
    : take.damaged
    ? 'will not open'
    : take.repaired
      ? 'header repaired'
      : take.submitted ? 'submitted' : (take.saved ? 'saved' : 'saving');
  card.right.textContent = status;
  card.li.classList.toggle('damaged', Boolean(take.damaged));
  card.li.classList.toggle('silent', Boolean(take.silent));
  card.submit.disabled = !take.saved || Boolean(take.submitted) || Boolean(take.damaged);

    card.submit.textContent = take.submitted ? 'Submitted' : 'Submit for task';
    card.submit.disabled = !take.saved || Boolean(take.submitted);
    card.correct.disabled = !take.saved || Boolean(take.correction) || state.correcting;
    card.correct.hidden = Boolean(state.session?.audioOnly);
    card.preview.disabled = !take.saved || Boolean(take.correction) || state.correcting;
    card.preview.hidden = Boolean(state.session?.audioOnly);
    card.discard.disabled = Boolean(take.submitted) || state.correcting;
    card.download.href = src;
    card.download.download = `${take.id}.${extensionFor(take.mime)}`;

    // Newest first, without tearing anything down.
    el.takeList.appendChild(card.li);
  }
}

async function discardTake(take) {
  if (take.submitted) {
    toast('That one is already submitted, so it stays.', true);
    return;
  }
  const card = takeCards.get(take.id);
  releasePlayer(card?.player);

  if (take.saved) {
    try {
      const response = await fetch(`/api/takes/${take.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error ?? 'delete failed');
    } catch (err) {
      toast(`Could not delete ${take.id}: ${err?.message ?? err}`, true);
      report(`discard failed: ${err?.message ?? err}`, 'error');
      renderTakes();
      return;
    }
  }
  if (take.url) URL.revokeObjectURL(take.url);

  card?.li.remove();
  takeCards.delete(take.id);
  state.takes = state.takes.filter((t) => t.id !== take.id);
  renderTakes();
  toast(`${take.id} discarded.`);
}

/** Drop the newest take and go back to the top, ready to go again. */
async function retake() {
  if (state.recording) await stopRecording();
  const newest = state.takes.find((t) => !t.submitted);
  if (newest) await discardTake(newest);
  prompter.reset();
  toast(newest ? `${newest.id} dropped. Back to the top.` : 'Back to the top.');
}

/**
 * One frame, warped, side by side with the original. A full pass runs at
 * playback speed, so judging the strength on a still first saves sitting
 * through a two minute re-encode to find out it was set too high.
 */
async function previewGaze(take) {
  if (state.correcting) return;
  await toggleGaze(true);
  if (!gazeMeter) {
    toast('The face landmark model is needed for this. Check the Gaze panel.', true);
    return;
  }

  const card = takeCards.get(take.id);
  card.compareNote.textContent = 'Looking for a frame with your face in it.';
  card.compare.hidden = false;

  try {
    const corrector = new GazeCorrector(state.landmarker);
    const { before, after, shift, bothEyes } = await corrector.preview({
      src: `/api/takes/${take.id}/media`,
      baseline: gazeMeter.baseline,
      strength: Number(el.gazeStrength.value) / 100,
      durationSec: take.durationSec,
    });
    card.beforeImg.src = before;
    card.afterImg.src = after;
    card.compareNote.textContent =
      `Iris moved ${shift.toFixed(1)} px${bothEyes ? ' on both eyes' : ' on one eye only'}` +
      `${gazeMeter.baseline ? '' : ', with no lens calibration, so it is aiming for the middle of the eye'}.` +
      ' Adjust the strength and preview again before running the full pass.';
  } catch (err) {
    card.compareNote.textContent = String(err?.message ?? err);
    report(`gaze preview failed: ${err?.message ?? err}`, 'error');
  }
}

async function correctGaze(take) {
  if (state.correcting) return;
  if (!take.saved) {
    toast('Wait for the take to finish saving.', true);
    return;
  }
  // A take that was already on the lens has nothing to gain and plenty to lose.
  // The warp has to invent pixels at the edge of the iris, and on a normally
  // framed shot the eye is only around twenty pixels tall, so the invention is
  // more visible than the correction.
  if (take.gaze?.calibrated && take.gaze.onLensPct >= 85 && !take.forceCorrect) {
    take.forceCorrect = true;
    renderTakes();
    toast(
      `${take.id} already reads ${take.gaze.onLensPct}% on lens, so correcting it will cost more than it gains. ` +
      'Press Correct gaze again to do it anyway.',
      true,
    );
    return;
  }

  const card = takeCards.get(take.id);
  state.correcting = true;
  renderTakes();
  card.progress.hidden = false;
  card.bar.style.width = '0%';
  card.label.textContent = 'starting';

  try {
    // The real pass runs outside the browser: it decodes every frame with
    // ffmpeg, corrects each one, and re-encodes. That cannot happen at playback
    // speed in here, and trying to was costing a quarter of the frames.
    const started = await fetch(`/api/takes/${take.id}/gaze-pass`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        strength: Number(el.gazeStrength.value) / 100,
        lift: 0.26,
      }),
    }).then((r) => r.json());
    if (!started.jobId) throw new Error(started.error ?? 'the pass would not start');

    const finished = await new Promise((resolve, reject) => {
      const poll = setInterval(async () => {
        try {
          const job = await fetch(`/api/jobs/${started.jobId}`).then((r) => r.json());
          if (job.total) {
            card.bar.style.width = `${((job.done / job.total) * 100).toFixed(1)}%`;
            card.label.textContent = `${job.stage} ${job.done}/${job.total}`;
          } else {
            card.label.textContent = job.stage ?? 'working';
          }
          if (job.state === 'done') { clearInterval(poll); resolve(job); }
          if (job.state === 'failed') { clearInterval(poll); reject(new Error(job.error ?? 'the pass failed')); }
        } catch (err) {
          clearInterval(poll);
          reject(err);
        }
      }, 1000);
    });

    const derived = {
      id: finished.derivedId,
      mime: 'video/mp4',
      durationSec: take.durationSec,
      bytes: finished.bytes ?? 0,
      url: null,
      cues: take.cues,
      gaze: take.gaze,
      background: take.background,
      wpm: take.wpm,
      recordedAt: new Date().toISOString(),
      correction: { method: 'offline pass', offline: true, ...(finished.stats ?? {}) },
      derivedFrom: take.id,
      saved: true,
      playable: true,
    };
    state.takes.unshift(derived);
    renderTakes();
    const st = finished.stats;
    toast(
      `${finished.derivedId} ready. ` +
      (st ? `${st.framesCorrected}/${st.framesTotal} frames, iris moved ${st.meanShiftPx.toFixed(1)} px on average. ` : '') +
      'It is a normal MP4, so it seeks.',
    );
  } catch (err) {
    toast(`Gaze correction failed: ${err?.message ?? err}`, true);
    report(`gaze pass failed: ${err?.message ?? err}`, 'error');
  } finally {
    state.correcting = false;
    card.progress.hidden = true;
    card.bar.style.width = '0%';
    renderTakes();
  }
}

function openSubmit(take) {
  state.pendingTakeId = take.id;
  el.submitSummary.textContent =
    `${take.id}, ${formatClock(take.durationSec)}, ${(take.bytes / 1e6).toFixed(1)} MB` +
    `${take.gaze?.calibrated ? `, ${take.gaze.onLensPct}% on lens` : ''}.`;
  el.submitNote.value = '';
  el.dialog.showModal();
}

el.dialog.addEventListener('close', async () => {
  if (el.dialog.returnValue !== 'submit' || !state.pendingTakeId) return;
  const id = state.pendingTakeId;
  state.pendingTakeId = null;
  try {
    const response = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, note: el.submitNote.value.trim() }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? 'submit failed');
    const take = state.takes.find((t) => t.id === id);
    if (take) take.submitted = true;
    renderTakes();
    toast(`${id} handed back to the session. You can close this tab.`);
  } catch (err) {
    toast(`Submit failed: ${err?.message ?? err}`, true);
    report(`submit failed: ${err?.message ?? err}`, 'error');
  }
});

/* ---------------- perform mode + lens drag ---------------- */

/**
 * Real fullscreen, not just hiding the panel.
 *
 * Browser chrome sits across the top of the screen, which is exactly where the
 * camera is and exactly where the reading band wants to be. Going live without
 * taking it away wastes the pixels that matter most.
 */
async function setFullscreen(on) {
  const root = document.documentElement;
  try {
    if (on && !document.fullscreenElement) {
      const request = root.requestFullscreen ?? root.webkitRequestFullscreen;
      if (!request) throw new Error('this browser has no fullscreen');
      await request.call(root, { navigationUI: 'hide' });
    } else if (!on && document.fullscreenElement) {
      await (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
    }
  } catch (err) {
    // Refusal is normal: it needs a real gesture, and some setups block it.
    toast(`Fullscreen was refused: ${err?.message ?? err}. The F key still clears the panel.`, true);
  }
}

function syncFullscreen() {
  const on = Boolean(document.fullscreenElement);
  el.btnFullscreen.setAttribute('aria-pressed', String(on));
  el.btnFullscreen.textContent = on ? 'Exit fullscreen' : 'Fullscreen';
  // The stage changed size, so the band and the column have to be re-measured.
  requestAnimationFrame(() => { applyLens(); prompter?.layout(); });
}

function setPerform(on) {
  el.body.classList.toggle('mode-perform', on);
  el.body.classList.toggle('mode-studio', !on);
  el.btnPerform.textContent = on ? 'Back to setup' : 'Go live';
  requestAnimationFrame(() => { applyLens(); prompter?.layout(); });
}

function wireLensDrag() {
  let dragging = false;
  const move = (event) => {
    if (!dragging) return;
    const rect = el.stage.getBoundingClientRect();
    state.prefs.lens = {
      x: Math.min(0.96, Math.max(0.04, (event.clientX - rect.left) / rect.width)),
      y: Math.min(0.6, Math.max(0.02, (event.clientY - rect.top) / rect.height)),
    };
    applyLens();
  };
  el.lens.addEventListener('pointerdown', (event) => {
    dragging = true;
    el.lens.setPointerCapture(event.pointerId);
  });
  el.lens.addEventListener('pointermove', move);
  el.lens.addEventListener('pointerup', (event) => {
    dragging = false;
    el.lens.releasePointerCapture(event.pointerId);
    savePrefs();
  });
  el.lens.addEventListener('keydown', (event) => {
    const step = 0.01;
    const { x, y } = state.prefs.lens;
    if (event.key === 'ArrowLeft') state.prefs.lens = { x: Math.max(0.04, x - step), y };
    else if (event.key === 'ArrowRight') state.prefs.lens = { x: Math.min(0.96, x + step), y };
    else if (event.key === 'ArrowUp') state.prefs.lens = { x, y: Math.max(0.02, y - step) };
    else if (event.key === 'ArrowDown') state.prefs.lens = { x, y: Math.min(0.6, y + step) };
    else return;
    event.preventDefault();
    event.stopPropagation();
    applyLens();
    savePrefs();
  });
}

/* ---------------- controls ---------------- */

/**
 * An AudioContext starts suspended until the page has seen a gesture, and a
 * suspended one reports silence. The meter therefore reads dead until the first
 * click, which looks exactly like a dead microphone. Wake it on anything.
 */
function wakeAudioOnFirstGesture() {
  const wake = () => {
    gate.ctx?.resume?.().catch(() => {});
    if (gate.live) {
      ['pointerdown', 'keydown'].forEach((e) => document.removeEventListener(e, wake, true));
    }
  };
  ['pointerdown', 'keydown'].forEach((e) => document.addEventListener(e, wake, true));
}

/** The preview sits wherever it is least in the way, which only you can judge. */
function wirePipDrag() {
  let from = null;
  el.pip.addEventListener('pointerdown', (event) => {
    const rect = el.pip.getBoundingClientRect();
    const stage = el.stage.getBoundingClientRect();
    from = { x: event.clientX, y: event.clientY, left: rect.left - stage.left, top: rect.top - stage.top };
    el.pip.setPointerCapture(event.pointerId);
    el.pip.classList.add('dragging');
  });
  el.pip.addEventListener('pointermove', (event) => {
    if (!from) return;
    const stage = el.stage.getBoundingClientRect();
    const left = Math.max(0, Math.min(stage.width - el.pip.offsetWidth, from.left + event.clientX - from.x));
    const top = Math.max(0, Math.min(stage.height - el.pip.offsetHeight, from.top + event.clientY - from.y));
    state.prefs.pip = { left: left / stage.width, top: top / stage.height };
    applyPipPosition();
  });
  const release = (event) => {
    if (!from) return;
    from = null;
    el.pip.releasePointerCapture?.(event.pointerId);
    el.pip.classList.remove('dragging');
    savePrefs();
  };
  el.pip.addEventListener('pointerup', release);
  el.pip.addEventListener('pointercancel', release);
}

function applyPipPosition() {
  const p = state.prefs.pip;
  if (!p) return;
  el.pip.style.left = `${(p.left * 100).toFixed(2)}%`;
  el.pip.style.top = `${(p.top * 100).toFixed(2)}%`;
  el.pip.style.right = 'auto';
  el.pip.style.bottom = 'auto';
}

function wireControls() {
  el.btnRefresh.addEventListener('click', async () => {
    await refreshDevices();
    await startStream().catch((err) => toast(`Could not open the device: ${err?.message ?? err}`, true));
  });
  el.selVideo.addEventListener('change', () => startStream().catch((err) => toast(String(err?.message ?? err), true)));
  el.selAudio.addEventListener('change', () => startStream().catch((err) => toast(String(err?.message ?? err), true)));
  el.selRes.addEventListener('change', () => startStream().catch((err) => toast(String(err?.message ?? err), true)));
  el.selFormat.addEventListener('change', () => {
    state.prefs.format = el.selFormat.value;
    state.forceWebm = false;
    savePrefs();
    toast(`Recording as ${state.prefs.format === 'mp4' ? 'MP4' : 'WebM'} from the next take.`);
  });

  el.btnMirrorCam.addEventListener('click', () => {
    state.prefs.mirrorCam = !state.prefs.mirrorCam;
    el.pip.classList.toggle('mirrored', state.prefs.mirrorCam);
    el.btnMirrorCam.setAttribute('aria-pressed', String(state.prefs.mirrorCam));
    savePrefs();
  });

  el.wpm.addEventListener('input', () => {
    prompter.setWpm(Number(el.wpm.value));
    state.prefs.wpm = prompter.wpm;
    savePrefs();
    updatePace();
  });
  el.fontSize.addEventListener('input', () => {
    state.prefs.fontSize = Number(el.fontSize.value);
    savePrefs();
    applyTypography();
  });
  el.colWidth.addEventListener('input', () => {
    state.prefs.colWidth = Number(el.colWidth.value);
    savePrefs();
    applyTypography();
  });
  el.btnMirrorText.addEventListener('click', () => {
    state.prefs.mirrorText = !state.prefs.mirrorText;
    savePrefs();
    applyTypography();
  });
  el.placeGrid.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-x]');
    if (!button) return;
    state.prefs.lens = { x: Number(button.dataset.x), y: Number(button.dataset.y) };
    savePrefs();
    applyLens();
    toast(`Words moved ${button.title}. Press F to see it full screen.`);
  });

  el.btnHoldSilence.addEventListener('click', async () => {
    state.holdSilence = !state.holdSilence;
    el.btnHoldSilence.setAttribute('aria-pressed', String(state.holdSilence));
    if (state.holdSilence) {
      const threshold = await gate.calibrate(1100);
      toast(`Holding on silence. Room floor set at ${threshold.toFixed(3)}.`);
    }
  });

  el.bgModes.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-bg]');
    if (button) setBackground(button.dataset.bg);
  });
  el.blurAmount.addEventListener('input', () => {
    state.prefs.blur = Number(el.blurAmount.value);
    el.blurOut.value = state.prefs.blur;
    compositor.setBlur(state.prefs.blur);
    savePrefs();
  });
  el.bgColour.addEventListener('input', () => {
    state.prefs.colour = el.bgColour.value;
    compositor.setColour(state.prefs.colour);
    savePrefs();
  });
  el.bgImage.addEventListener('change', () => {
    const file = el.bgImage.files?.[0];
    if (!file) return;
    const image = new Image();
    image.onload = () => {
      compositor.setImage(image);
      setBackground('image');
    };
    image.onerror = () => toast('That image would not decode.', true);
    image.src = URL.createObjectURL(file);
  });

  el.btnGaze.addEventListener('click', () => toggleGaze());
  el.btnCalibrate.addEventListener('click', async () => {
    await toggleGaze(true);
    if (!gazeMeter) return;
    // Give the meter a few frames with the current pose before freezing it.
    for (let i = 0; i < 12; i += 1) {
      gazeMeter.update(el.preview);
      await new Promise((r) => setTimeout(r, 40));
    }
    if (gazeMeter.calibrate()) {
      el.gazeNote.textContent = 'Baseline set. 100 means you are aimed where you were when you calibrated.';
      toast('Gaze baseline set on the lens.');
    } else {
      el.gazeNote.textContent = 'No face found. Sit in frame and try again.';
    }
  });

  el.btnEditScript.addEventListener('click', () => {
    el.scriptEditor.value = state.session.script;
    el.scriptEditor.hidden = false;
    el.editorActions.hidden = false;
    el.scriptEditor.focus();
  });
  el.btnCancelScript.addEventListener('click', () => {
    el.scriptEditor.hidden = true;
    el.editorActions.hidden = true;
  });
  el.btnSaveScript.addEventListener('click', async () => {
    state.session.script = el.scriptEditor.value;
    prompter.setScript(state.session.script);
    el.scriptEditor.hidden = true;
    el.editorActions.hidden = true;
    applyTypography();
    await fetch('/api/script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: state.session.script }),
    }).catch(() => {});
    toast('Script updated.');
  });

  el.btnRestart.addEventListener('click', () => prompter.reset());
  el.btnBackTop.addEventListener('click', () => prompter.reset());
  el.btnRetake.addEventListener('click', () => retake());
  el.gazeStrength.addEventListener('input', () => {
    state.prefs.gazeStrength = Number(el.gazeStrength.value);
    el.gazeStrengthOut.value = state.prefs.gazeStrength;
    savePrefs();
  });
  el.btnPerform.addEventListener('click', () => {
    const next = !el.body.classList.contains('mode-perform');
    setPerform(next);
    // Going live almost always means wanting the whole screen, and this click is
    // the gesture the browser needs to allow it.
    setFullscreen(next);
  });
  el.btnFullscreen.addEventListener('click', () => setFullscreen(!document.fullscreenElement));
  document.addEventListener('fullscreenchange', syncFullscreen);
  document.addEventListener('webkitfullscreenchange', syncFullscreen);
  el.btnRecord.addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));

  window.addEventListener('resize', () => {
    applyLens();
    prompter?.layout();
  });

  document.addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.dialog.open) return;
    if (event.target === el.lens) return;

    switch (event.key) {
      case ' ':
        event.preventDefault();
        prompter.toggle();
        toast(prompter.playing ? 'Scrolling.' : 'Paused.');
        break;
      case 'r': case 'R':
        event.preventDefault();
        if (state.recording) stopRecording(); else startRecording();
        break;
      case 'ArrowUp':
        event.preventDefault();
        el.wpm.value = String(prompter.wpm + 5);
        el.wpm.dispatchEvent(new Event('input'));
        break;
      case 'ArrowDown':
        event.preventDefault();
        el.wpm.value = String(prompter.wpm - 5);
        el.wpm.dispatchEvent(new Event('input'));
        break;
      case 'ArrowRight': prompter.stepBlock(1); break;
      case 'ArrowLeft': prompter.stepBlock(-1); break;
      case 'Home': prompter.reset(); break;
      case 't': case 'T': retake(); break;
      case 'm': case 'M': el.btnMirrorText.click(); break;
      case 'f': case 'F': {
        if (event.shiftKey) { setFullscreen(!document.fullscreenElement); break; }
        const next = !el.body.classList.contains('mode-perform');
        setPerform(next);
        setFullscreen(next);
        break;
      }
      case 'g': case 'G': toggleGaze(); break;
      case 'b': case 'B': {
        const order = ['none', 'blur', 'colour', 'image'];
        setBackground(order[(order.indexOf(state.prefs.bg) + 1) % order.length]);
        break;
      }
      case 'Escape':
        // In fullscreen the browser already handles Escape, so let it mean only
        // that rather than also dumping the reader back into the setup panel.
        if (document.fullscreenElement) break;
        setPerform(false);
        break;
      default: break;
    }
  });
}

/* ---------------- boot ---------------- */

async function boot() {
  loadPrefs();

  state.session = await fetch('/api/session').then((r) => r.json());
  el.taskLabel.textContent = state.session.task || 'Teleprompter';
  el.scriptSource.textContent = state.session.scriptSource === 'placeholder'
    ? 'no script passed in, edit it in the panel'
    : state.session.scriptSource;
  document.title = state.session.task ? `Prompter: ${state.session.task}` : 'Teleprompter';

  prompter = new Prompter({
    body: el.script,
    inner: el.inner,
    stage: el.stage,
    onBlock: onBlockChange,
  });
  prompter.setWpm(state.prefs.wpm);
  prompter.setScript(state.session.script);

  el.wpm.value = String(state.prefs.wpm);
  el.fontSize.value = String(state.prefs.fontSize);
  el.colWidth.value = String(state.prefs.colWidth);
  el.gazeStrength.value = String(state.prefs.gazeStrength);
  el.gazeStrengthOut.value = state.prefs.gazeStrength;
  el.blurAmount.value = String(state.prefs.blur);
  el.blurOut.value = state.prefs.blur;
  el.bgColour.value = state.prefs.colour;
  el.selRes.value = state.prefs.res;
  el.selFormat.value = state.prefs.format;
  compositor.setBlur(state.prefs.blur);
  compositor.setColour(state.prefs.colour);
  el.pip.classList.toggle('mirrored', state.prefs.mirrorCam);
  el.btnMirrorCam.setAttribute('aria-pressed', String(state.prefs.mirrorCam));

  applyTypography();
  applyLens();
  wireLensDrag();
  wirePipDrag();
  applyPipPosition();
  wakeAudioOnFirstGesture();
  wireControls();
  renderTakes();
  requestAnimationFrame(loop);

  if (state.session.audioOnly) {
    el.pipNote.hidden = false;
    el.bgNote.textContent = 'Audio-only session.';
    el.gazeNote.textContent = 'Audio-only session.';
  }
  if (!state.session.vendor?.ready) {
    el.bgNote.textContent =
      'Background and gaze models are not vendored. Run scripts/fetch-models.mjs in the skill folder, then reload.';
    el.gazeNote.textContent = el.bgNote.textContent;
  }

  try {
    await primePermission(Boolean(state.session.audioOnly));
    await refreshDevices();
    await startStream();
    if (state.prefs.bg !== 'none') await setBackground(state.prefs.bg);
    el.body.dataset.booted = 'ready';
    toast('Drag the lens marker to where your camera sits, then press F to go live.');
  } catch (err) {
    el.deviceNote.textContent = `Device access failed: ${err?.message ?? err}`;
    el.body.dataset.booted = 'denied';
    toast(
      'The browser refused camera or microphone access. Allow it for localhost, then reload.',
      true,
    );
    report(`device access failed: ${err?.message ?? err}`, 'error');
  }
}

boot().catch((err) => {
  toast(`Startup failed: ${err?.message ?? err}`, true);
  report(`boot failed: ${err?.message ?? err}`, 'error');
});
