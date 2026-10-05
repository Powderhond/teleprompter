/**
 * Offline gaze correction: clean plate and compositing.
 *
 * The in-app pass has to keep up with playback, so it works a frame at a time
 * and fills the band a raised iris vacates with a colour guessed from the same
 * frame. On a normally framed shot there is barely any sclera to guess from and
 * the guess shows.
 *
 * This one is allowed to take as long as it likes, which buys two things the
 * live pass cannot have:
 *
 *   A clean plate. Across a whole take the iris wanders, so almost every part
 *   of the eye is visible in some frame. Taking a per-pixel median of the eye
 *   region over every frame where the iris was not covering that pixel builds a
 *   photograph of the eye with the iris removed. The band under a moved iris is
 *   then filled with real sclera, lid and lash, not a flat colour.
 *
 *   A centred smoothing window. A running average can only look backwards, so
 *   it lags and still passes jitter through. Offline, every frame's landmarks
 *   are known before anything is drawn, so the displacement can be smoothed
 *   with a window centred on each frame: no lag, far less shake.
 */

import { eyeGeometry } from './vision.js';

/**
 * How much of the iris the moved disc carries, as a multiple of the landmark
 * radius.
 *
 * MediaPipe traces the iris circle, but the dark part of a real eye runs a
 * little past it: the limbus is a gradient, not a line. Compositing at 0.98 of
 * the radius left that outer rim behind, where it was then painted over with
 * plate, and plate at that radius is sclera. The result was a bright ring
 * around a dark disc, which reads exactly like a contact lens. The disc has to
 * cover the whole visible iris, and the plate has to start outside it.
 */
const IRIS_COVER = 1.08;
const RIM_FEATHER = 1.0;
const PLATE_CLEAR = 1.3;

/**
 * Where the iris actually ends, measured off the pixels.
 *
 * Both hand-picked multipliers were wrong in opposite directions. At 0.98 the
 * disc sat inside the real iris, leaving its outer rim behind to be painted over
 * with plate: a bright ring around a dark disc. At 1.08 the disc swallowed a
 * band of sclera and carried it along, pasting a bright ring around the iris at
 * its new position. Same artifact, opposite cause, because the right number is
 * not a constant: it depends on the eye, the camera and the frame.
 *
 * So find it. Walk outward from the iris centre and look for the radius where
 * the image brightens fastest, which is the limbus: dark iris giving way to
 * sclera. Angles outside the eye opening are skipped so lashes and lids do not
 * vote.
 *
 * @returns {number} radius in pixels, or the landmark radius if the edge is too
 *   soft to find
 */
export function measureLimbus(src, width, height, g) {
  const ea = Math.max(2, g.openW / 2);
  const eb = Math.max(1.5, g.openH / 2);
  const steps = 14;
  const from = g.irisR * 0.55;
  const to = g.irisR * 1.55;
  const profile = new Float64Array(steps);
  const counts = new Int32Array(steps);

  for (let i = 0; i < steps; i += 1) {
    const r = from + ((to - from) * i) / (steps - 1);
    for (let a = 0; a < 32; a += 1) {
      const theta = (a / 32) * Math.PI * 2;
      const px = g.irisX + Math.cos(theta) * r;
      const py = g.irisY + Math.sin(theta) * r;
      if (px < 1 || py < 1 || px >= width - 1 || py >= height - 1) continue;
      const ex = (px - g.cx) / ea;
      const ey = (py - g.cy) / eb;
      if (Math.hypot(ex, ey) > 0.82) continue;      // outside the opening
      const idx = ((py | 0) * width + (px | 0)) * 4;
      profile[i] += (src[idx] + src[idx + 1] + src[idx + 2]) / 3;
      counts[i] += 1;
    }
    if (counts[i]) profile[i] /= counts[i];
  }

  let best = -1;
  let bestRise = 0;
  for (let i = 1; i < steps - 1; i += 1) {
    if (!counts[i] || !counts[i + 1]) continue;
    const rise = profile[i + 1] - profile[i];
    if (rise > bestRise) { bestRise = rise; best = i; }
  }

  // A soft or unlit edge gives no clear peak, and guessing then is how this
  // went wrong twice already.
  if (best < 0 || bestRise < 4) return g.irisR;

  const r0 = from + ((to - from) * best) / (steps - 1);
  const r1 = from + ((to - from) * (best + 1)) / (steps - 1);
  const edge = (r0 + r1) / 2;
  return Math.max(g.irisR * 0.7, Math.min(g.irisR * 1.4, edge));
}

/** Patch big enough to hold the eye and its lids, in frame pixels. */
export function patchSize(openW, openH) {
  return {
    w: Math.max(24, Math.ceil(openW * 2.0)),
    h: Math.max(20, Math.ceil(openH * 4.0)),
  };
}

function bilinear(data, width, height, x, y, out) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const cx0 = Math.min(width - 1, Math.max(0, x0));
  const cy0 = Math.min(height - 1, Math.max(0, y0));
  const cx1 = Math.min(width - 1, cx0 + 1);
  const cy1 = Math.min(height - 1, cy0 + 1);
  const i00 = (cy0 * width + cx0) * 4;
  const i10 = (cy0 * width + cx1) * 4;
  const i01 = (cy1 * width + cx0) * 4;
  const i11 = (cy1 * width + cx1) * 4;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  for (let c = 0; c < 3; c += 1) {
    out[c] = data[i00 + c] * w00 + data[i10 + c] * w10 + data[i01 + c] * w01 + data[i11 + c] * w11;
  }
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/**
 * Catmull-Rom sample. Sharper than bilinear at the limbus, which is where a
 * soft iris edge reads as a dead eye.
 */
export function bicubic(data, width, height, x, y, out) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const at = (ix, iy, c) => {
    const cx = Math.min(width - 1, Math.max(0, ix));
    const cy = Math.min(height - 1, Math.max(0, iy));
    return data[(cy * width + cx) * 4 + c];
  };
  for (let c = 0; c < 3; c += 1) {
    const rows = [];
    for (let m = -1; m <= 2; m += 1) {
      rows.push(catmull(at(xi - 1, yi + m, c), at(xi, yi + m, c), at(xi + 1, yi + m, c), at(xi + 2, yi + m, c), fx));
    }
    out[c] = Math.min(255, Math.max(0, catmull(rows[0], rows[1], rows[2], rows[3], fy)));
  }
}

export function ease(t) {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Geometry of both eyes for one frame, in frame pixels. */
export function frameGeometry(points, specs, width, height) {
  return specs.map((spec) => {
    const g = eyeGeometry(points, spec, width, height);
    return {
      irisX: g.iris.x, irisY: g.iris.y, irisR: g.irisR,
      cx: g.centre.x, cy: g.centre.y,
      openW: g.openW, openH: g.openH,
      hx: g.hx, vy: g.vy,
    };
  });
}

/**
 * Collects eye-region samples across frames and medians them into a plate.
 *
 * Samples are taken in a patch centred on the eye, so a head that drifts during
 * the take still lines up. Pixels the iris was covering in that frame are left
 * out, which is what removes the iris from the result.
 */
export class PlateBuilder {
  constructor(patch, frameCount) {
    this.patch = patch;
    this.capacity = frameCount;
    this.count = patch.w * patch.h;
    this.samples = new Uint8Array(this.count * 3 * frameCount);
    this.used = new Uint16Array(this.count);
  }

  add(frameData, frameW, frameH, g) {
    const { w, h } = this.patch;
    const originX = g.cx - w / 2;
    const originY = g.cy - h / 2;
    const px = [0, 0, 0];
    const skip = (Number.isFinite(g.limbus) && g.limbus > 0 ? g.limbus : g.irisR) * PLATE_CLEAR;

    for (let j = 0; j < h; j += 1) {
      const sy = originY + j + 0.5;
      for (let i = 0; i < w; i += 1) {
        const sx = originX + i + 0.5;
        if (sx < 0 || sy < 0 || sx >= frameW || sy >= frameH) continue;
        if (Math.hypot(sx - g.irisX, sy - g.irisY) < skip) continue;

        const idx = j * w + i;
        const n = this.used[idx];
        if (n >= this.capacity) continue;
        bilinear(frameData, frameW, frameH, sx - 0.5, sy - 0.5, px);
        const base = (idx * this.capacity + n) * 3;
        this.samples[base] = px[0];
        this.samples[base + 1] = px[1];
        this.samples[base + 2] = px[2];
        this.used[idx] = n + 1;
      }
    }
  }

  /** @returns {{data: Uint8ClampedArray, valid: Uint8Array, w: number, h: number, coverage: number}} */
  finish(minSamples = 5) {
    const { w, h } = this.patch;
    const data = new Uint8ClampedArray(this.count * 3);
    const valid = new Uint8Array(this.count);
    const scratch = new Uint8Array(this.capacity);
    let covered = 0;

    for (let idx = 0; idx < this.count; idx += 1) {
      const n = this.used[idx];
      if (n < minSamples) continue;
      for (let c = 0; c < 3; c += 1) {
        for (let k = 0; k < n; k += 1) scratch[k] = this.samples[(idx * this.capacity + k) * 3 + c];
        const slice = scratch.subarray(0, n);
        const sorted = Array.prototype.slice.call(slice).sort((a, b) => a - b);
        data[idx * 3 + c] = sorted[n >> 1];
      }
      valid[idx] = 1;
      covered += 1;
    }
    return { data, valid, w, h, coverage: covered / this.count };
  }
}

/**
 * Draw one eye: the plate behind, the iris moved on top, the lids untouched.
 *
 * @param {Uint8ClampedArray} out   frame-sized RGBA, written in place
 * @param {Uint8ClampedArray} src   the original frame
 * @param {object} plate            from PlateBuilder.finish
 * @returns {number} pixels written
 */
export function composeEye(out, src, width, height, g, plate, dx, dy) {
  const ea = Math.max(2, g.openW / 2);
  const eb = Math.max(1.5, g.openH / 2);
  const edge = Number.isFinite(g.limbus) && g.limbus > 0 ? g.limbus : g.irisR * IRIS_COVER;
  const feather = RIM_FEATHER;

  const originX = g.cx - plate.w / 2;
  const originY = g.cy - plate.h / 2;

  const x0 = Math.max(0, Math.floor(g.cx - ea - 3));
  const y0 = Math.max(0, Math.floor(g.cy - eb - 3));
  const x1 = Math.min(width, Math.ceil(g.cx + ea + 3));
  const y1 = Math.min(height, Math.ceil(g.cy + eb + 3));

  // Match the plate's exposure to this frame before using any of it.
  //
  // The plate is a median across the whole take, so it carries the eye's average
  // brightness, not this frame's. Dropping it straight into a shadowed frame
  // paints an average-brightness crescent against a darker surround, and that
  // crescent hugging the iris is what reads as a contact lens. Measured on the
  // sclera that both the plate and this frame can see, and applied as an offset
  // rather than a gain so shadows do not get crushed.
  const offset = [0, 0, 0];
  {
    const sums = [0, 0, 0];
    const plateSums = [0, 0, 0];
    let n = 0;
    for (let y = y0; y < y1; y += 1) {
      const py = y + 0.5;
      const ey = (py - g.cy) / eb;
      for (let x = x0; x < x1; x += 1) {
        const px = x + 0.5;
        const ex = (px - g.cx) / ea;
        if (Math.hypot(ex, ey) > 0.9) continue;
        if (Math.hypot(px - g.irisX, py - g.irisY) < g.irisR * 1.25) continue;
        if (Math.hypot(px - (g.irisX + dx), py - (g.irisY + dy)) < g.irisR * 1.25) continue;
        const pi = Math.round(px - originX - 0.5);
        const pj = Math.round(py - originY - 0.5);
        if (pi < 0 || pj < 0 || pi >= plate.w || pj >= plate.h) continue;
        const pidx = pj * plate.w + pi;
        if (!plate.valid[pidx]) continue;
        const i = (y * width + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          sums[c] += src[i + c];
          plateSums[c] += plate.data[pidx * 3 + c];
        }
        n += 1;
      }
    }
    if (n >= 8) {
      for (let c = 0; c < 3; c += 1) {
        // Clamped: a wild correction means the sample was bad, and no fill is
        // better than a luminous one.
        offset[c] = Math.max(-60, Math.min(60, (sums[c] - plateSums[c]) / n));
      }
    }
  }

  const iris = [0, 0, 0];
  let written = 0;

  for (let y = y0; y < y1; y += 1) {
    const py = y + 0.5;
    const ey = (py - g.cy) / eb;
    for (let x = x0; x < x1; x += 1) {
      const px = x + 0.5;
      const ex = (px - g.cx) / ea;

      const lid = 1 - ease((Math.hypot(ex, ey) - 0.72) / 0.28);
      if (lid <= 0.002) continue;

      const i = (y * width + x) * 4;
      const dNew = Math.hypot(px - (g.irisX + dx), py - (g.irisY + dy));
      const onIris = 1 - ease((dNew - edge) / feather);
      const dOld = Math.hypot(px - g.irisX, py - g.irisY);
      const wasIris = 1 - ease((dOld - edge) / feather);
      if (onIris <= 0.002 && wasIris <= 0.002) continue;

      // Background: the plate, which is this eye with the iris taken out.
      let r = src[i];
      let gg = src[i + 1];
      let b = src[i + 2];
      const pi = Math.round(px - originX - 0.5);
      const pj = Math.round(py - originY - 0.5);
      if (pi >= 0 && pj >= 0 && pi < plate.w && pj < plate.h) {
        const pidx = pj * plate.w + pi;
        if (plate.valid[pidx]) {
          const reveal = wasIris * (1 - onIris);
          if (reveal > 0.002) {
            const pr = plate.data[pidx * 3] + offset[0];
            const pg = plate.data[pidx * 3 + 1] + offset[1];
            const pb = plate.data[pidx * 3 + 2] + offset[2];
            r = r * (1 - reveal) + pr * reveal;
            gg = gg * (1 - reveal) + pg * reveal;
            b = b * (1 - reveal) + pb * reveal;
          }
        }
      }

      if (onIris > 0.002) {
        bicubic(src, width, height, px - dx - 0.5, py - dy - 0.5, iris);
        r = r * (1 - onIris) + iris[0] * onIris;
        gg = gg * (1 - onIris) + iris[1] * onIris;
        b = b * (1 - onIris) + iris[2] * onIris;
      }

      out[i] = src[i] * (1 - lid) + r * lid;
      out[i + 1] = src[i + 1] * (1 - lid) + gg * lid;
      out[i + 2] = src[i + 2] * (1 - lid) + b * lid;
      written += 1;
    }
  }
  return written;
}

/**
 * Centred moving average over a series, which is what offline buys over the
 * live pass: no lag, and jitter either side of a frame cancels instead of
 * trailing it.
 */
export function smoothSeries(values, radius) {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    let sum = 0;
    let n = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const j = i + k;
      if (j < 0 || j >= values.length) continue;
      const v = values[j];
      if (!Number.isFinite(v)) continue;
      sum += v;
      n += 1;
    }
    out[i] = n ? sum / n : 0;
  }
  return out;
}
