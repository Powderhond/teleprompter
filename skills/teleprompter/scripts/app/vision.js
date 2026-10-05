/**
 * The open-source vision pieces, loaded from scripts/vendor.
 *
 *   selfie_segmenter.tflite  person / background split for background replacement
 *   face_landmarker.task     478 landmarks with iris, which the gaze meter reads
 *
 * Both are MediaPipe Tasks (Apache-2.0) running in WASM, so capture needs no
 * ffmpeg, no Python, and no network once the files are vendored.
 */

const WASM_PATH = '/vendor/tasks-vision/wasm';
const BUNDLE = '/vendor/tasks-vision/vision_bundle.mjs';
const SEGMENTER_MODEL = '/vendor/models/selfie_segmenter.tflite';
const LANDMARKER_MODEL = '/vendor/models/face_landmarker.task';

let cached = null;

export async function loadVision() {
  if (cached) return cached;
  const mod = await import(BUNDLE);
  const fileset = await mod.FilesetResolver.forVisionTasks(WASM_PATH);
  cached = { mod, fileset };
  return cached;
}

/** Try the GPU delegate, fall back to CPU, so an old driver degrades instead of failing. */
async function createWithFallback(create, options) {
  try {
    return await create({ ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' } });
  } catch (gpuError) {
    try {
      return await create({ ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
    } catch (cpuError) {
      throw new Error(`GPU: ${gpuError?.message ?? gpuError} / CPU: ${cpuError?.message ?? cpuError}`);
    }
  }
}

export async function createSegmenter() {
  const { mod, fileset } = await loadVision();
  return createWithFallback((options) => mod.ImageSegmenter.createFromOptions(fileset, options), {
    baseOptions: { modelAssetPath: SEGMENTER_MODEL },
    runningMode: 'VIDEO',
    outputCategoryMask: true,
    outputConfidenceMasks: true,
  });
}

export async function createFaceLandmarker() {
  const { mod, fileset } = await loadVision();
  return createWithFallback((options) => mod.FaceLandmarker.createFromOptions(fileset, options), {
    baseOptions: { modelAssetPath: LANDMARKER_MODEL },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });
}

// 478-point face mesh, iris included. `ring` is the eye-opening contour, which
// the gaze warp uses as the boundary its displacement has to die out before.
const RIGHT_EYE = {
  inner: 133,
  outer: 33,
  top: 159,
  bottom: 145,
  iris: [468, 469, 470, 471, 472],
  ring: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
};
const LEFT_EYE = {
  inner: 362,
  outer: 263,
  top: 386,
  bottom: 374,
  iris: [473, 474, 475, 476, 477],
  ring: [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398],
};

/** Both eyes, for anything that has to treat them the same way. */
export const EYE_SPECS = [RIGHT_EYE, LEFT_EYE];

/** Iris centre in normalised coordinates. */
export function irisCentre(points, spec) {
  return centroid(points, spec.iris);
}

/**
 * One derivation of an eye's geometry, shared by the live meter and the
 * correction pass.
 *
 * The sign convention matters more than it looks. MediaPipe's corner landmarks
 * have opposite handedness between the eyes: for the right eye `outer - inner`
 * runs negative, for the left it runs positive. Dividing by that signed width
 * made the two eyes report opposite offsets for the same physical gaze, which
 * cancelled half the meter's horizontal reading and, worse, made a calibrated
 * baseline pull one eye toward the lens and push the other away. Widths here are
 * absolute, so positive hx always means "iris sits toward the right of frame"
 * for both eyes.
 *
 * @param {number} [width] scale for x, 1 for normalised coordinates
 * @param {number} [height] scale for y
 */
export function eyeGeometry(points, spec, width = 1, height = 1) {
  const at = (i) => ({ x: points[i].x * width, y: points[i].y * height });
  const inner = at(spec.inner);
  const outer = at(spec.outer);
  const top = at(spec.top);
  const bottom = at(spec.bottom);

  const irisN = centroid(points, spec.iris);
  const iris = { x: irisN.x * width, y: irisN.y * height };

  const openW = Math.abs(outer.x - inner.x);
  const openH = Math.abs(bottom.y - top.y);
  const centre = { x: (inner.x + outer.x) / 2, y: (top.y + bottom.y) / 2 };

  let irisR = 0;
  for (const i of spec.iris.slice(1)) {
    const p = at(i);
    irisR = Math.max(irisR, Math.hypot(p.x - iris.x, p.y - iris.y));
  }

  return {
    inner,
    outer,
    top,
    bottom,
    iris,
    centre,
    openW,
    openH,
    irisR,
    hx: openW > 1e-6 ? (iris.x - centre.x) / openW : 0,
    vy: openH > 1e-6 ? (iris.y - centre.y) / openH : 0,
  };
}
const NOSE = 1;
const BROW = 10;
const CHIN = 152;
const CHEEK_L = 234;
const CHEEK_R = 454;

function centroid(points, indices) {
  let x = 0;
  let y = 0;
  for (const i of indices) {
    x += points[i].x;
    y += points[i].y;
  }
  return { x: x / indices.length, y: y / indices.length };
}

/**
 * Relative gaze meter.
 *
 * It does not claim an absolute eye-contact angle. You look into the lens once
 * and press Calibrate; from then on every frame is scored against that
 * baseline, which is the thing that actually matters on camera. Both the iris
 * position inside the eye and the head's own aim feed the score, so dropping
 * your eyes to the words and dipping your chin both register.
 */
export class GazeMeter {
  constructor(landmarker) {
    this.landmarker = landmarker;
    this.baseline = null;
    this.last = null;
    this.sigma = 0.085;
    this.onLensFrames = 0;
    this.faceFrames = 0;
    this.totalFrames = 0;
    this.scoreSum = 0;
    this.smoothed = null;
    this.lastTs = 0;
  }

  reset() {
    this.onLensFrames = 0;
    this.faceFrames = 0;
    this.totalFrames = 0;
    this.scoreSum = 0;
  }

  /** @returns {{hasFace: boolean, dx: number, dy: number, score: number, hint: string}|null} */
  update(video, now = performance.now()) {
    if (!video?.videoWidth) return null;
    const ts = now <= this.lastTs ? this.lastTs + 1 : now;
    this.lastTs = ts;

    let result;
    try {
      result = this.landmarker.detectForVideo(video, ts);
    } catch {
      return this.last;
    }

    this.totalFrames += 1;
    const points = result?.faceLandmarks?.[0];
    if (!points || points.length < 478) {
      this.last = { hasFace: false, dx: 0, dy: 0, score: 0, hint: 'no face' };
      return this.last;
    }
    this.faceFrames += 1;

    const raw = this.measure(points);
    // Light exponential smoothing so the HUD does not jitter.
    this.smoothed = this.smoothed
      ? {
          hx: this.smoothed.hx * 0.6 + raw.hx * 0.4,
          vy: this.smoothed.vy * 0.6 + raw.vy * 0.4,
          yaw: this.smoothed.yaw * 0.6 + raw.yaw * 0.4,
          pitch: this.smoothed.pitch * 0.6 + raw.pitch * 0.4,
        }
      : raw;

    const base = this.baseline ?? { hx: 0, vy: 0, yaw: 0, pitch: 0 };
    const dx = (this.smoothed.hx - base.hx) * 0.75 + (this.smoothed.yaw - base.yaw) * 0.25;
    const dy = (this.smoothed.vy - base.vy) * 0.75 + (this.smoothed.pitch - base.pitch) * 0.25;

    const distSq = dx * dx + dy * dy;
    const score = Math.round(100 * Math.exp(-distSq / (2 * this.sigma * this.sigma)));
    if (score >= 60) this.onLensFrames += 1;
    this.scoreSum += score;

    this.last = {
      hasFace: true,
      dx,
      dy,
      score,
      hint: this.hintFor(dx, dy, score),
      calibrated: Boolean(this.baseline),
    };
    return this.last;
  }

  measure(points) {
    const right = eyeGeometry(points, RIGHT_EYE);
    const left = eyeGeometry(points, LEFT_EYE);

    // Head aim, from the nose against the face's own frame.
    const nose = points[NOSE];
    const faceWidth = points[CHEEK_R].x - points[CHEEK_L].x;
    const faceHeight = points[CHIN].y - points[BROW].y;
    const yaw = Math.abs(faceWidth) > 1e-6
      ? (nose.x - (points[CHEEK_L].x + points[CHEEK_R].x) / 2) / faceWidth
      : 0;
    const pitch = Math.abs(faceHeight) > 1e-6
      ? (nose.y - (points[BROW].y + points[CHIN].y) / 2) / faceHeight
      : 0;

    return {
      hx: (right.hx + left.hx) / 2,
      vy: (right.vy + left.vy) / 2,
      yaw,
      pitch,
    };
  }

  hintFor(dx, dy, score) {
    if (score >= 72) return 'on lens';
    if (Math.abs(dy) > Math.abs(dx)) return dy > 0 ? 'eyes are low' : 'eyes are high';
    return dx > 0 ? 'eyes are right' : 'eyes are left';
  }

  /** Call while the reader is looking straight into the lens. */
  calibrate() {
    if (!this.smoothed) return false;
    this.baseline = { ...this.smoothed };
    this.reset();
    return true;
  }

  summary() {
    if (!this.totalFrames) return null;
    return {
      calibrated: Boolean(this.baseline),
      framesScored: this.totalFrames,
      faceDetectedPct: Math.round((this.faceFrames / this.totalFrames) * 100),
      onLensPct: this.faceFrames ? Math.round((this.onLensFrames / this.faceFrames) * 100) : 0,
      meanScore: this.totalFrames ? Math.round(this.scoreSum / this.totalFrames) : 0,
      method: 'mediapipe face_landmarker iris + head aim, scored against a lens calibration',
    };
  }
}
