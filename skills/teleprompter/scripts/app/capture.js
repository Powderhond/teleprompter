/**
 * Devices, recording, and the canvas pipeline that burns a replaced background
 * into the captured file.
 */

const VIDEO_MIMES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=h264,aac',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const AUDIO_MIMES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

/**
 * @param {boolean} audioOnly
 * @param {'mp4'|'webm'} [prefer] force a container family
 */
export function pickMime(audioOnly, prefer) {
  let candidates = audioOnly ? AUDIO_MIMES : VIDEO_MIMES;
  if (prefer === 'webm') candidates = candidates.filter((m) => m.includes('webm'));
  else if (prefer === 'mp4') {
    const mp4 = candidates.filter((m) => m.includes('mp4'));
    candidates = [...mp4, ...candidates.filter((m) => !m.includes('mp4'))];
  }
  for (const mime of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(mime)) return mime;
  }
  return '';
}

/**
 * Read the first bytes and say whether this is a file a player can open.
 *
 * Chrome's MP4 recorder sometimes stops emitting the ftyp/moov initialisation
 * segment once its hardware encoder has been reused, and what lands on disk is
 * a bare run of moof fragments: right length, right bitrate, completely
 * unplayable. Nothing downstream notices, so the check happens here.
 *
 * @returns {Promise<{kind: string, valid: boolean, tag: string}>}
 */
export async function inspectContainer(blob) {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (head.length < 8) return { kind: 'empty', valid: false, tag: '' };

  // WebM and Matroska both start with the EBML magic.
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { kind: 'webm', valid: true, tag: 'EBML' };
  }

  const tag = String.fromCharCode(head[4], head[5], head[6], head[7]);
  if (tag === 'ftyp') return { kind: 'mp4', valid: true, tag };
  // moof or mdat first means the init segment never arrived.
  return { kind: 'mp4', valid: false, tag };
}

/**
 * Length of an fMP4's initialisation segment (everything up to and including
 * moov), or 0 if this blob does not start with one.
 */
export async function initSegmentLength(blob) {
  const view = new DataView(await blob.slice(0, Math.min(blob.size, 1 << 20)).arrayBuffer());
  let offset = 0;
  let sawFtyp = false;
  while (offset + 8 <= view.byteLength) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5),
      view.getUint8(offset + 6), view.getUint8(offset + 7),
    );
    if (size < 8) return 0;
    if (offset === 0 && type !== 'ftyp') return 0;
    if (type === 'ftyp') sawFtyp = true;
    if (type === 'moov') return sawFtyp ? offset + size : 0;
    offset += size;
  }
  return 0;
}

/** Load a URL in a detached element and report whether it actually opens. */
export function probePlayable(url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted = true;
    const done = (ok, detail) => {
      probe.removeAttribute('src');
      try { probe.load(); } catch { /* detached already */ }
      resolve({ ok, detail });
    };
    probe.onloadedmetadata = () => done(true, `${probe.videoWidth}x${probe.videoHeight}`);
    probe.onerror = () => done(false, probe.error?.message ?? `media error ${probe.error?.code ?? '?'}`);
    setTimeout(() => done(probe.readyState >= 1, 'timed out'), timeoutMs);
    probe.src = url;
  });
}

/**
 * Loudness of a finished recording, so silence is caught while the person is
 * still sitting there rather than after the edit.
 *
 * A microphone can be the wrong device, muted, or held by another application,
 * and none of that shows until the take comes back flat. Twenty-eight seconds
 * of a real read were lost to exactly that.
 * @returns {Promise<number|null>} rms, or null if it would not decode
 */
export async function measureLoudness(blob) {
  const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioCtx) return null;
  const ctx = new AudioCtx();
  try {
    const buffer = await Promise.race([
      ctx.decodeAudioData(await blob.arrayBuffer()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('decode timed out')), 15000)),
    ]);
    if (!buffer.numberOfChannels) return null;
    const data = buffer.getChannelData(0);
    let sum = 0;
    const step = Math.max(1, Math.floor(data.length / 200000));
    let n = 0;
    for (let i = 0; i < data.length; i += step) { sum += data[i] * data[i]; n += 1; }
    return n ? Math.sqrt(sum / n) : null;
  } catch {
    return null;
  } finally {
    try { await ctx.close(); } catch { /* already closed */ }
  }
}

/**
 * A private copy of the tracks for one recording.
 *
 * Each clone is a fresh source for the encoder, so a take cannot inherit muxer
 * state from the take before it, and switching camera mid-session cannot pull
 * the rug from a recording already in flight.
 */
export function cloneForRecording(stream) {
  return new MediaStream(stream.getVideoTracks().map((track) => track.clone()));
}

/**
 * The stream a take is recorded from: a private video track, and audio tapped
 * off the live graph. Everything in here is ours to stop when the take ends.
 */
export function buildRecordingStream(videoTracks, audioTrack) {
  const out = new MediaStream();
  videoTracks.forEach((track) => out.addTrack(track));
  if (audioTrack) out.addTrack(audioTrack);
  return out;
}

export function extensionFor(mime = '') {
  if (mime.includes('mp4')) return mime.startsWith('audio/') ? 'm4a' : 'mp4';
  if (mime.includes('webm')) return mime.startsWith('audio/') ? 'weba' : 'webm';
  if (mime.includes('ogg')) return 'ogg';
  return 'bin';
}

/** Device labels stay blank until a permission has been granted once. */
export async function primePermission(audioOnly) {
  const probe = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: audioOnly ? false : true,
  });
  probe.getTracks().forEach((track) => track.stop());
}

export async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    video: devices.filter((d) => d.kind === 'videoinput'),
    audio: devices.filter((d) => d.kind === 'audioinput'),
  };
}

export async function openStream({ videoId, audioId, width, height, audioOnly }) {
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    ...(audioId ? { deviceId: { exact: audioId } } : {}),
  };
  const video = audioOnly
    ? false
    : {
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: 30, max: 30 },
        ...(videoId ? { deviceId: { exact: videoId } } : {}),
      };
  return navigator.mediaDevices.getUserMedia({ audio, video });
}

export class Recorder {
  constructor() {
    this.chunks = [];
    this.recorder = null;
    this.startedAt = 0;
    this.mime = '';
  }

  get active() {
    return this.recorder?.state === 'recording';
  }

  start(stream, mime) {
    // The chunk array belongs to this recording, not to the Recorder. A late
    // event from a previous take can no longer land in the next take's file.
    const chunks = [];
    this.chunks = chunks;
    this.mime = mime;
    this.ownedStream = stream;
    this.recorder = new MediaRecorder(stream, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: 6_000_000,
      audioBitsPerSecond: 160_000,
    });
    this.recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    this.startedAt = performance.now();
    this.recorder.start(1000);
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.recorder) {
        reject(new Error('Recorder was never started'));
        return;
      }
      const durationSec = (performance.now() - this.startedAt) / 1000;
      const chunks = this.chunks;
      this.recorder.onstop = () => {
        const type = this.recorder.mimeType || this.mime || 'application/octet-stream';
        resolve({ blob: new Blob(chunks, { type }), mime: type, durationSec });
        this.recorder = null;
        // The clones were made for this take alone.
        this.ownedStream?.getTracks().forEach((track) => track.stop());
        this.ownedStream = null;
      };
      this.recorder.onerror = (event) => reject(event.error ?? new Error('Recorder failed'));
      this.recorder.stop();
    });
  }
}

/**
 * Draws the camera onto a canvas with the background replaced, and hands back a
 * stream to record. When the mode is "none" nothing runs and the raw camera
 * stream is recorded instead, which keeps quality up and the CPU quiet.
 */
export class Compositor {
  constructor(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    this.person = document.createElement('canvas');
    this.personCtx = this.person.getContext('2d');
    this.mask = document.createElement('canvas');
    this.maskCtx = this.mask.getContext('2d');

    this.segmenter = null;
    this.mode = 'none';
    this.blurPx = 14;
    this.colour = '#132a2f';
    this.image = null;
    this.running = false;
    this.invertMask = false;
    this.polarityChecks = 0;
    this.frames = 0;
    this.lastMaskAt = 0;
    this.onFrame = null;
  }

  get needsPipeline() {
    return this.mode !== 'none' && Boolean(this.segmenter);
  }

  setSegmenter(segmenter) { this.segmenter = segmenter; }
  setMode(mode) { this.mode = mode; }
  setBlur(px) { this.blurPx = Number(px) || 14; }
  setColour(hex) { this.colour = hex; }
  setImage(image) { this.image = image; }

  resize() {
    const w = this.video.videoWidth || 1280;
    const h = this.video.videoHeight || 720;
    for (const canvas of [this.canvas, this.person]) {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    const step = () => {
      if (!this.running) return;
      try {
        this.drawFrame();
      } catch (err) {
        this.running = false;
        this.onError?.(err);
        return;
      }
      if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(step);
      else requestAnimationFrame(step);
    };
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(step);
    else requestAnimationFrame(step);
  }

  stop() { this.running = false; }

  drawFrame() {
    if (!this.video.videoWidth) return;
    this.resize();
    const { width: w, height: h } = this.canvas;
    this.frames += 1;

    if (!this.needsPipeline) {
      this.ctx.drawImage(this.video, 0, 0, w, h);
      this.onFrame?.();
      return;
    }

    const alpha = this.readMask();
    if (alpha) this.paintMaskCanvas(alpha);

    // Background first.
    this.ctx.save();
    if (this.mode === 'blur') {
      this.ctx.filter = `blur(${this.blurPx}px)`;
      // Overdraw so the blur kernel never pulls in transparent edges.
      const pad = this.blurPx * 2;
      this.ctx.drawImage(this.video, -pad, -pad, w + pad * 2, h + pad * 2);
    } else if (this.mode === 'image' && this.image) {
      this.drawCover(this.ctx, this.image, w, h);
    } else {
      this.ctx.fillStyle = this.colour;
      this.ctx.fillRect(0, 0, w, h);
    }
    this.ctx.restore();

    // Then the cut-out person.
    this.personCtx.clearRect(0, 0, w, h);
    this.personCtx.drawImage(this.video, 0, 0, w, h);
    this.personCtx.save();
    this.personCtx.globalCompositeOperation = 'destination-in';
    this.personCtx.filter = 'blur(2px)';
    this.personCtx.drawImage(this.mask, 0, 0, w, h);
    this.personCtx.restore();

    this.ctx.drawImage(this.person, 0, 0);
    this.onFrame?.();
  }

  drawCover(ctx, image, w, h) {
    const iw = image.naturalWidth || image.width;
    const ih = image.naturalHeight || image.height;
    if (!iw || !ih) return;
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  /** @returns {{data: Float32Array|Uint8Array, width: number, height: number, float: boolean}|null} */
  readMask() {
    const ts = performance.now();
    let result;
    try {
      const returned = this.segmenter.segmentForVideo(this.video, ts, (value) => { result = value; });
      if (!result && returned) result = returned;
    } catch {
      return null;
    }
    if (!result) return null;

    let out = null;
    try {
      const confidence = result.confidenceMasks;
      if (confidence?.length) {
        // Two categories means {background, person}; one means a single person map.
        const mask = confidence.length > 1 ? confidence[1] : confidence[0];
        out = { data: mask.getAsFloat32Array(), width: mask.width, height: mask.height, float: true };
      } else if (result.categoryMask) {
        const mask = result.categoryMask;
        out = { data: mask.getAsUint8Array(), width: mask.width, height: mask.height, float: false };
      }
    } catch {
      out = null;
    }

    try { result.close?.(); } catch { /* older builds free on their own */ }
    if (out) this.checkPolarity(out);
    return out;
  }

  /**
   * Category order is not guaranteed across model revisions, so sample the
   * middle against the corners and flip if the subject came out as background.
   */
  checkPolarity(mask) {
    if (this.polarityChecks > 4 && this.frames % 180 !== 0) return;
    const { data, width, height, float } = mask;
    const at = (x, y) => {
      const value = data[Math.round(y) * width + Math.round(x)] ?? 0;
      return float ? value : (value > 0 ? 1 : 0);
    };
    const centre = (at(width / 2, height * 0.55) + at(width / 2, height * 0.7)) / 2;
    const corners =
      (at(2, 2) + at(width - 3, 2) + at(2, height - 3) + at(width - 3, height - 3)) / 4;
    if (Math.abs(centre - corners) > 0.35) {
      this.invertMask = corners > centre;
      this.polarityChecks += 1;
    }
  }

  paintMaskCanvas({ data, width, height, float }) {
    if (this.mask.width !== width || this.mask.height !== height) {
      this.mask.width = width;
      this.mask.height = height;
      this.maskImage = this.maskCtx.createImageData(width, height);
      this.maskImage.data.fill(255);
    }
    const px = this.maskImage.data;
    const invert = this.invertMask;
    for (let i = 0; i < data.length; i += 1) {
      const raw = float ? data[i] : (data[i] > 0 ? 1 : 0);
      const value = invert ? 1 - raw : raw;
      px[i * 4 + 3] = value > 0.999 ? 255 : (value < 0.001 ? 0 : (value * 255) | 0);
    }
    this.maskCtx.putImageData(this.maskImage, 0, 0);
    this.lastMaskAt = performance.now();
  }

  /**
   * Canvas video only. Audio is tapped off the live graph by the caller, so the
   * microphone device is never cloned or stopped on its behalf.
   */
  videoTracks(fps = 30) {
    return this.canvas.captureStream(fps).getVideoTracks();
  }
}

/**
 * Energy gate on the microphone. Used to hold the scroll while you are not
 * speaking, so a pause for breath does not leave you chasing the words.
 */
export class SilenceGate {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.buffer = null;
    this.threshold = 0.01;
    this.lastVoiceAt = 0;
    this.hangoverMs = 420;
    this.level = 0;
  }

  attach(stream) {
    this.detach();
    const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioCtx || !stream.getAudioTracks().length) return false;
    this.ctx = new AudioCtx();
    this.tapDest = null;
    // An AudioContext starts suspended until a gesture, and a suspended one
    // hands back silence rather than an error. Reading that as "the microphone
    // is dead" is how a meter ends up lying about a working mic.
    this.ctx.resume?.().catch(() => {});
    this.source = this.ctx.createMediaStreamSource(stream);
    const source = this.source;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    source.connect(this.analyser);

    // Carry on to the destination through a silent gain node.
    //
    // An analyser hanging off a source with nowhere to go is not guaranteed to
    // be pulled: the graph is driven from the destination backwards, and a
    // branch that reaches nothing can simply never be rendered. That is what the
    // level meter was: attached, context running, and reading 0.00002 while the
    // same microphone recorded perfectly well. The gain is zero, so this adds a
    // path without adding a sound.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.analyser.connect(this.sink);
    this.sink.connect(this.ctx.destination);

    this.buffer = new Float32Array(this.analyser.fftSize);
    return true;
  }

  detach() {
    this.untap();
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.sink = null;
  }

  /**
   * A microphone track to record from, taken through Web Audio rather than by
   * cloning the device track.
   *
   * Cloning a live microphone and then stopping the clone is legal by the spec
   * and fine against a synthetic device, but on real Windows audio hardware the
   * clone and the original share one capture session, and tearing one down can
   * take the other with it. Takes kept coming back as digital silence and the
   * fault was never reproducible in a test. A Web Audio tap never touches the
   * device: it branches the signal that is already flowing.
   */
  tap() {
    if (!this.ctx || !this.source) return null;
    this.untap();
    this.ctx.resume?.().catch(() => {});
    this.tapDest = this.ctx.createMediaStreamDestination();
    this.source.connect(this.tapDest);
    return this.tapDest.stream;
  }

  untap() {
    if (!this.tapDest) return;
    try { this.source?.disconnect(this.tapDest); } catch { /* already gone */ }
    this.tapDest = null;
  }

  /** Whether the readings can be trusted at all. */
  get live() {
    return Boolean(this.analyser) && this.ctx?.state === 'running';
  }

  rms() {
    if (!this.analyser) return 0;
    if (this.ctx?.state === 'suspended') this.ctx.resume?.().catch(() => {});
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i += 1) sum += this.buffer[i] * this.buffer[i];
    this.level = Math.sqrt(sum / this.buffer.length);
    return this.level;
  }

  /** Listen to the room for a moment and set the floor above it. */
  async calibrate(ms = 1200) {
    if (!this.analyser) return this.threshold;
    const samples = [];
    const started = performance.now();
    while (performance.now() - started < ms) {
      samples.push(this.rms());
      await new Promise((r) => setTimeout(r, 40));
    }
    samples.sort((a, b) => a - b);
    const floor = samples[Math.floor(samples.length * 0.8)] ?? 0.004;
    this.threshold = Math.max(0.008, floor * 3.2);
    return this.threshold;
  }

  speaking() {
    if (!this.analyser) return true;
    if (this.rms() > this.threshold) {
      this.lastVoiceAt = performance.now();
      return true;
    }
    return performance.now() - this.lastVoiceAt < this.hangoverMs;
  }
}
