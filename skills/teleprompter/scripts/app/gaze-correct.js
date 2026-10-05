/**
 * Gaze correction as a post-capture pass.
 *
 * What this is: a geometric warp. For every frame it finds the iris with the
 * face landmarker, works out how far the eye is from where it was when you
 * calibrated on the lens, and pulls the iris back toward that baseline. The
 * sclera around it stretches to follow, the eyelids stay put, and the
 * displacement falls to zero before it reaches the eye opening's edge so
 * nothing bleeds into the skin.
 *
 * What this is not: a generative model. It does not repaint eyes, open a lid
 * wider, or fix a specular highlight. It moves what is already there. Small
 * corrections, which is the teleprompter case, hold up well. Push the strength
 * past what the geometry supports and it will look like what it is, which is
 * why the shift is capped against the iris radius rather than trusted.
 *
 * It runs at playback speed because the audio is re-encoded from the element's
 * own output. A two minute take takes two minutes.
 */

import { EYE_SPECS, eyeGeometry } from './vision.js';
import { pickMime } from './capture.js';

/**
 * Never ask for more movement than the eye geometry can absorb.
 *
 * Two ceilings, because they bind in different situations. The iris radius
 * limits how far the disc can slide before the limbus smears. The opening
 * height limits how far it can go before it jams into a lid: on a real 720p
 * take the lids were 19 px apart while the iris was 29 px across, so a shift
 * sized off the iris alone was nearly 40% of the visible eye and looked it.
 */
const MAX_SHIFT_PER_IRIS_RADIUS = 0.55;
const MAX_SHIFT_PER_OPENING = 0.18;
/**
 * How much of the eye opening the pass is allowed to invent outright.
 *
 * Anything beyond the overhang has no source pixels behind it and has to be
 * painted in. A tenth of the opening is a sliver nobody reads as wrong; a third
 * is a smear.
 */
const MAX_INVENTED_PER_OPENING = 0.1;
/** Fewer pixels than this between the lids and there is nothing to work with. */
const MIN_OPENING_PX = 7;
/** Clamped 0..1 ease, 0 at t<=0 and 1 at t>=1. */
function ease(t) {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * Per-eye exponential smoothing of the displacement.
 *
 * Landmarks jitter by a fraction of a pixel between frames. Warping each frame
 * from its own raw measurement turns that jitter into a shimmer around the iris
 * that reads as scratchiness even when any single frame looks fine.
 */
export class ShiftSmoother {
  constructor(alpha = 0.3) {
    this.alpha = alpha;
    this.state = new Map();
  }

  reset() { this.state.clear(); }

  smooth(key, dx, dy) {
    const previous = this.state.get(key);
    if (!previous) {
      this.state.set(key, { dx, dy });
      return { dx, dy };
    }
    const next = {
      dx: previous.dx + (dx - previous.dx) * this.alpha,
      dy: previous.dy + (dy - previous.dy) * this.alpha,
    };
    this.state.set(key, next);
    return next;
  }
}

/**
 * Move one eye's iris in place on the 2d context.
 *
 * The first version of this pushed pixels around with a smooth displacement
 * field. It was symmetric and seam-free, and on a real face it still looked
 * wrong: a field drags the bottom edge of the iris upward with everything else
 * rather than revealing the sclera behind it, so a rising iris left a dark
 * crescent smeared under it. That smear was the "scratchy" artifact.
 *
 * So the iris is treated as what it is, a disc in front of a background:
 *
 *   1. the hole it currently occupies is filled with the sclera beside it,
 *      sampled along the row and pulled toward the eye's own sclera colour so a
 *      bad sample cannot drag the iris back in;
 *   2. the iris is composited at its new position with a soft edge;
 *   3. everything is masked by the eye opening, in elliptical coordinates
 *      fitted to the corners and lids, so the lids and skin are never touched.
 *
 * The eyelid mask is smooth in every direction. An earlier version cast a ray
 * at the sixteen-sided landmark polygon, which made the falloff distance jump
 * at each vertex and showed up as radial facets.
 *
 * Exported so the maths can be tested on a synthetic eye, with no face and no
 * camera involved.
 *
 * @returns {number} the shift applied, in pixels
 */
export function warpEye(ctx, landmarks, spec, width, height, baseline, strength, smoother = null) {
  const g = eyeGeometry(landmarks, spec, width, height);
  if (g.openW < 6 || g.openH < MIN_OPENING_PX || g.irisR < 2) return 0;

  // No calibration means aim for the middle of the opening, which reads as
  // looking into the lens for a camera sitting just above the screen.
  const targetHx = baseline ? baseline.hx : 0;
  const targetVy = baseline ? baseline.vy : 0;

  let dx = (targetHx - g.hx) * g.openW * strength;
  let dy = (targetVy - g.vy) * g.openH * strength;

  const ea0 = Math.max(2, g.openW / 2);
  const eb0 = Math.max(1.5, g.openH / 2);

  // How far the iris already runs past the lid it is moving away from.
  //
  // On a close eye the iris is taller than the gap between the lids, so its
  // bottom sits well below the lower lid already. Sliding it up by that much
  // exposes nothing: the lid still covers whatever is behind. Past that point
  // every pixel of movement has to be invented, and invented eye looks like
  // invented eye. So the free distance is the overhang, plus a small allowance.
  const ex0 = (g.iris.x - g.centre.x) / ea0;
  const lidSpan = eb0 * Math.sqrt(Math.max(0, 1 - Math.min(1, ex0 * ex0)));
  const overhang = dy < 0
    ? Math.max(0, (g.iris.y + g.irisR) - (g.centre.y + lidSpan))   // moving up
    : Math.max(0, (g.centre.y - lidSpan) - (g.iris.y - g.irisR));  // moving down
  const invented = g.openH * MAX_INVENTED_PER_OPENING;

  const cap = Math.min(
    g.irisR * MAX_SHIFT_PER_IRIS_RADIUS,
    g.openH * MAX_SHIFT_PER_OPENING,
    overhang + invented,
  );
  const asked = Math.hypot(dx, dy);
  if (asked > cap && asked > 1e-6) {
    dx *= cap / asked;
    dy *= cap / asked;
  }

  if (smoother) ({ dx, dy } = smoother.smooth(spec.inner, dx, dy));

  const shift = Math.hypot(dx, dy);
  if (shift < 0.2) return 0;

  const ea = ea0;
  const eb = eb0;

  const pad = Math.ceil(shift + g.irisR * 0.3 + 3);
  const bx = Math.max(0, Math.floor(g.centre.x - ea - pad));
  const by = Math.max(0, Math.floor(g.centre.y - eb - pad));
  const bw = Math.min(width - bx, Math.ceil(g.centre.x + ea + pad) - bx);
  const bh = Math.min(height - by, Math.ceil(g.centre.y + eb + pad) - by);
  if (bw < 4 || bh < 4) return 0;

  const img = ctx.getImageData(bx, by, bw, bh);
  const src = img.data;
  const out = new Uint8ClampedArray(src);

  // Move the iris by a whole number of pixels. A fractional offset means every
  // iris pixel is a bilinear blend of its neighbours, which softens the limbus
  // and dulls the catchlight: the eye goes dead. At four or five pixels of
  // movement the lost precision is worth nothing and the sharpness is worth a
  // lot. Sub-pixel detail stays in the smoothed value, so the integer only
  // changes when the smoothed one genuinely crosses.
  const sdx = Math.round(dx);
  const sdy = Math.round(dy);
  if (sdx === 0 && sdy === 0) return 0;

  const R = g.irisR;
  const edge = R * 0.98;          // the iris keeps its own radius, not 84% of it
  const feather = 1.6;            // just enough to avoid a stair-stepped rim

  const lidAt = (px, py) => {
    const ex = (px - g.centre.x) / ea;
    const ey = (py - g.centre.y) / eb;
    return 1 - ease((Math.hypot(ex, ey) - 0.72) / 0.28);
  };

  // What the eye looks like at each height, taken from the sclera to the left
  // and right of the iris on that row.
  //
  // The fill used to read horizontally outward from each vacated pixel, which
  // near the bottom of the iris lands on the lash line and the inner corner:
  // dark, red, and different for every pixel. That showed up as a speckled
  // crescent under a raised iris. A median across each row's real sclera gives
  // a fill that carries the eye's own vertical shading and no noise.
  const rowR = new Float32Array(bh);
  const rowG = new Float32Array(bh);
  const rowB = new Float32Array(bh);
  const rowOk = new Uint8Array(bh);
  const bucketR = [];
  const bucketG = [];
  const bucketB = [];

  for (let y = 0; y < bh; y += 1) {
    const py = by + y + 0.5;
    bucketR.length = 0;
    bucketG.length = 0;
    bucketB.length = 0;
    for (let x = 0; x < bw; x += 1) {
      const px = bx + x + 0.5;
      if (lidAt(px, py) < 0.55) continue;
      if (Math.hypot(px - g.iris.x, py - g.iris.y) < R * 1.06) continue;
      const i = (y * bw + x) * 4;
      bucketR.push(src[i]);
      bucketG.push(src[i + 1]);
      bucketB.push(src[i + 2]);
    }
    if (bucketR.length < 3) continue;
    // The darker end of the row, not the middle of it.
    //
    // What sits under a raised iris is shadowed: lid margin, lash line, sclera
    // in the iris's own shade. A median takes in the bright sclera at the
    // corners and paints a light arc under the eye that reads immediately as
    // wrong. The 30th percentile lands on the shaded part.
    const mid = (arr) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.3)];
    };
    rowR[y] = mid(bucketR);
    rowG[y] = mid(bucketG);
    rowB[y] = mid(bucketB);
    rowOk[y] = 1;
  }

  // Rows with no sclera of their own are left alone.
  //
  // Borrowing from the nearest row that has some sounds reasonable and looks
  // terrible: on a close eye the only rows carrying sclera are the ones through
  // the middle, where it shows at the corners, and that is the brightest part
  // of the eye. Painting it into the shaded band under a raised iris draws a
  // pale arc across the lower lid. Leaving those rows untouched means the iris
  // simply slides over whatever was already behind it, which is both honest and
  // less visible.

  let touched = 0;
  let filled = 0;

  for (let y = 0; y < bh; y += 1) {
    const py = by + y + 0.5;
    for (let x = 0; x < bw; x += 1) {
      const px = bx + x + 0.5;
      const i = (y * bw + x) * 4;

      const dOld = Math.hypot(px - g.iris.x, py - g.iris.y);
      const dNew = Math.hypot(px - (g.iris.x + sdx), py - (g.iris.y + sdy));

      // Full strength across the whole iris, feathered only at the very rim.
      const onIris = 1 - ease((dNew - edge) / feather);
      const wasIris = 1 - ease((dOld - edge) / feather);
      // Fill only what the iris actually vacated. Everywhere else the original
      // stands, so nothing that did not need touching gets blended.
      const vacated = wasIris * (1 - onIris);
      if (onIris <= 0.002 && vacated <= 0.002) continue;

      const lid = lidAt(px, py);
      if (lid <= 0.002) continue;

      let r = src[i];
      let gg = src[i + 1];
      let b = src[i + 2];

      if (vacated > 0.002 && lid > 0.25) filled += 1;
      if (vacated > 0.002 && rowOk[y]) {
        r = r * (1 - vacated) + rowR[y] * vacated;
        gg = gg * (1 - vacated) + rowG[y] * vacated;
        b = b * (1 - vacated) + rowB[y] * vacated;
      }

      // Foreground: the iris itself, copied whole-pixel so it stays sharp.
      if (onIris > 0.002) {
        const sx = Math.min(bw - 1, Math.max(0, x - sdx));
        const sy = Math.min(bh - 1, Math.max(0, y - sdy));
        const j = (sy * bw + sx) * 4;
        r = r * (1 - onIris) + src[j] * onIris;
        gg = gg * (1 - onIris) + src[j + 1] * onIris;
        b = b * (1 - onIris) + src[j + 2] * onIris;
      }

      out[i] = src[i] * (1 - lid) + r * lid;
      out[i + 1] = src[i + 1] * (1 - lid) + gg * lid;
      out[i + 2] = src[i + 2] * (1 - lid) + b * lid;
      touched += 1;
    }
  }

  if (!touched) return 0;
  ctx.putImageData(new ImageData(out, bw, bh), bx, by);
  lastWarpStats = { shift, filled, overhang, cap, openH: g.openH, irisR: g.irisR };
  return shift;
}

/** Whatever the last warpEye call did, for the QC tool to report. */
export let lastWarpStats = null;

/** Warp both eyes of one already-drawn frame. */
export function warpFrame(ctx, points, width, height, baseline, strength, smoother = null) {
  const perEye = [];
  const shifts = EYE_SPECS.map((spec) => {
    lastWarpStats = null;
    const shift = warpEye(ctx, points, spec, width, height, baseline, strength, smoother);
    perEye.push(lastWarpStats);
    return shift;
  });
  return {
    shifts,
    perEye,
    maxShift: Math.max(...shifts),
    bothEyes: shifts.every((s) => s > 0),
  };
}

/** Open a detached video element on a URL and wait for its metadata. */
function openVideo(src) {
  const video = document.createElement('video');
  video.src = src;
  video.playsInline = true;
  video.preload = 'auto';
  return new Promise((resolve, reject) => {
    video.onloadedmetadata = () => resolve(video);
    video.onerror = () => reject(new Error('That take would not decode.'));
    setTimeout(() => reject(new Error('Timed out opening the take.')), 20000);
  });
}

function seek(video, time) {
  return new Promise((resolve) => {
    video.onseeked = resolve;
    video.currentTime = time;
    setTimeout(resolve, 4000);
  });
}

export class GazeCorrector {
  /** @param {object} landmarker a MediaPipe FaceLandmarker in VIDEO mode */
  constructor(landmarker) {
    this.landmarker = landmarker;
    this.cancelled = false;
    this.ts = performance.now();
  }

  cancel() { this.cancelled = true; }

  nextTimestamp() {
    this.ts = Math.max(this.ts + 1, performance.now());
    return this.ts;
  }

  detect(source) {
    try {
      const result = this.landmarker.detectForVideo(source, this.nextTimestamp());
      const points = result?.faceLandmarks?.[0];
      return points && points.length >= 478 ? points : null;
    } catch {
      return null;
    }
  }

  /**
   * One frame, warped, as a before and after pair. Instant, so the strength can
   * be judged without sitting through a whole re-encode.
   *
   * @returns {Promise<{before: string, after: string, shift: number, bothEyes: boolean}>}
   */
  async preview({ src, baseline = null, strength = 1, at = null, durationSec = 0 }) {
    const video = await openVideo(src);
    const length = Number.isFinite(video.duration) && video.duration > 0
      ? Math.min(video.duration, durationSec || video.duration)
      : durationSec;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });

    const stops = at !== null ? [at] : [length * 0.35, length * 0.6, length * 0.15, 0.2];
    let points = null;
    for (const t of stops) {
      if (!Number.isFinite(t) || t < 0) continue;
      await seek(video, t);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      points = this.detect(video);
      if (points) break;
    }
    if (!points) {
      video.removeAttribute('src');
      video.load();
      throw new Error('No face found in this take, so there is nothing to correct.');
    }

    // Crop both eyes with a little room around them.
    const xs = EYE_SPECS.flatMap((s) => s.ring.map((i) => points[i].x * canvas.width));
    const ys = EYE_SPECS.flatMap((s) => s.ring.map((i) => points[i].y * canvas.height));
    const padX = (Math.max(...xs) - Math.min(...xs)) * 0.08;
    const padY = (Math.max(...ys) - Math.min(...ys)) * 1.2;
    const cx = Math.max(0, Math.floor(Math.min(...xs) - padX));
    const cy = Math.max(0, Math.floor(Math.min(...ys) - padY));
    const cw = Math.min(canvas.width - cx, Math.ceil(Math.max(...xs) + padX) - cx);
    const ch = Math.min(canvas.height - cy, Math.ceil(Math.max(...ys) + padY) - cy);

    const crop = (label) => {
      const tile = document.createElement('canvas');
      const scale = Math.min(3, Math.max(1, 520 / Math.max(1, cw)));
      tile.width = Math.round(cw * scale);
      tile.height = Math.round(ch * scale);
      const tctx = tile.getContext('2d');
      tctx.drawImage(canvas, cx, cy, cw, ch, 0, 0, tile.width, tile.height);
      tctx.fillStyle = 'rgba(0,0,0,0.55)';
      tctx.fillRect(0, 0, 58, 17);
      tctx.fillStyle = '#cbd8d6';
      tctx.font = '11px system-ui, sans-serif';
      tctx.fillText(label, 6, 12);
      return tile.toDataURL('image/jpeg', 0.92);
    };

    const before = crop('before');
    const result = warpFrame(ctx, points, canvas.width, canvas.height, baseline, strength);
    const after = crop('after');

    video.removeAttribute('src');
    video.load();
    return { before, after, shift: result.maxShift, bothEyes: result.bothEyes };
  }

  /**
   * @param {object} options
   * @param {string} options.src          playable URL for the take
   * @param {object|null} options.baseline calibrated {hx, vy}, or null to centre the iris
   * @param {number} options.strength     0 to 1
   * @param {number} options.durationSec  the recorder's own measurement, which is
   *                                      trusted over the file's metadata
   * @param {(p: object) => void} [options.onProgress]
   * @returns {Promise<{blob: Blob, mime: string, stats: object}>}
   */
  async correct({ src, baseline = null, strength = 1, durationSec = 0, onProgress = () => {} }) {
    this.cancelled = false;
    const video = await openVideo(src);

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('The take reports no frame size.');

    // MediaRecorder writes unreliable duration metadata: often overstated,
    // sometimes Infinity. The recorder clock measured the real thing, so the
    // progress bar follows that and stops stalling at an arbitrary fraction.
    const declared = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const length = durationSec > 0 ? durationSec : declared;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });

    const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
    const audio = new AudioCtx();
    const source = audio.createMediaElementSource(video);
    const dest = audio.createMediaStreamDestination();
    source.connect(dest);

    const canvasStream = canvas.captureStream(0);
    const videoTrack = canvasStream.getVideoTracks()[0];
    const out = new MediaStream([videoTrack, ...dest.stream.getAudioTracks()]);

    const mime = pickMime(false);
    const chunks = [];
    const recorder = new MediaRecorder(out, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: 10_000_000,
      audioBitsPerSecond: 160_000,
    });
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };

    const smoother = new ShiftSmoother(0.3);
    const stats = {
      frames: 0,
      framesWithFace: 0,
      framesBothEyes: 0,
      shiftSum: 0,
      maxShift: 0,
      strength,
      calibrated: Boolean(baseline),
      endedBecause: 'completed',
    };

    let lastFrameAt = performance.now();
    let settled = false;
    const finished = new Promise((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = (event) => reject(event.error ?? new Error('Re-encode failed'));
    });

    const finish = (why) => {
      if (settled) return;
      settled = true;
      stats.endedBecause = why;
      clearInterval(watchdog);
      try { video.pause(); } catch { /* already stopped */ }
      // Let the last frame reach the muxer before closing it.
      setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 250);
    };

    // A pass must always end. Frame callbacks stop arriving if the element
    // stalls or errors, and without this the job would sit at whatever fraction
    // it had reached for ever.
    const watchdog = setInterval(() => {
      if (settled) return;
      if (performance.now() - lastFrameAt > 5000) finish('stalled');
    }, 1000);

    video.addEventListener('ended', () => finish('completed'));
    video.addEventListener('error', () => finish('decode error'));

    recorder.start(1000);
    await video.play();

    const step = () => {
      if (this.cancelled) { finish('cancelled'); return; }
      lastFrameAt = performance.now();

      ctx.drawImage(video, 0, 0, width, height);
      stats.frames += 1;

      const points = this.detect(video);
      if (points) {
        stats.framesWithFace += 1;
        const result = warpFrame(ctx, points, width, height, baseline, strength, smoother);
        if (result.bothEyes) stats.framesBothEyes += 1;
        stats.shiftSum += result.maxShift;
        stats.maxShift = Math.max(stats.maxShift, result.maxShift);
      }

      videoTrack.requestFrame();
      onProgress({
        ratio: length > 0 ? Math.min(1, video.currentTime / length) : 0,
        seconds: video.currentTime,
        duration: length,
        frames: stats.frames,
      });

      if (!video.ended && !settled) video.requestVideoFrameCallback(step);
    };

    video.requestVideoFrameCallback(step);
    await finished;
    clearInterval(watchdog);

    try { await audio.close(); } catch { /* already closed */ }
    video.removeAttribute('src');
    video.load();

    stats.meanShiftPx = stats.framesWithFace ? stats.shiftSum / stats.framesWithFace : 0;
    stats.faceFoundPct = stats.frames ? Math.round((stats.framesWithFace / stats.frames) * 100) : 0;
    stats.bothEyesPct = stats.framesWithFace
      ? Math.round((stats.framesBothEyes / stats.framesWithFace) * 100)
      : 0;
    stats.method = 'geometric iris warp against the lens calibration (not a generative model)';

    const type = recorder.mimeType || mime || 'video/webm';
    return { blob: new Blob(chunks, { type }), mime: type, stats };
  }
}
