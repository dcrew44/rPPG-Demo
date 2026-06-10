/**
 * Plane-Orthogonal-to-Skin (POS) remote-PPG algorithm.
 *
 * Ports rppg/algorithms/pos.py — the canonical POS method of Wang et al.
 * (2017), "Algorithmic Principles of Remote PPG". Temporally normalized RGB
 * is projected onto a plane orthogonal to the skin-tone direction, the two
 * projections are alpha-tuned by their std ratio to suppress
 * intensity/specular distortions, and overlap-add windows of 1.6 * fps
 * frames (mean-subtracted per window) accumulate into the pulse so the
 * per-window statistics track slow illumination drift.
 */

import type { RgbSample } from "./buffer";

// The fixed 2x3 POS projection matrix (rows produce s1 and s2).
const PROJECTION: readonly (readonly [number, number, number])[] = [
  [0, 1, -1],
  [-2, 1, 1],
];

/** Population (ddof = 0) standard deviation, matching numpy's default. */
function std(values: Float64Array): number {
  const n = values.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += values[i];
  mean /= n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    sq += d * d;
  }
  return Math.sqrt(sq / n);
}

/**
 * Estimate a pulse signal from an RGB time series via POS.
 *
 * `rgb` holds the per-frame mean RGB over the skin ROI, oldest to newest;
 * `fps` is its sampling rate. Returns the pulse waveform of the same length.
 * With fewer frames than one window (or a window shorter than two frames) an
 * all-zero array is returned, as in the Python.
 */
export function posEstimate(
  rgb: readonly RgbSample[],
  fps: number,
): Float64Array {
  const n = rgb.length;
  const pulse = new Float64Array(n);

  const window = Math.round(1.6 * fps);
  if (window < 2 || n < window) return pulse;

  const s1 = new Float64Array(window);
  const s2 = new Float64Array(window);

  for (let start = 0; start + window <= n; start++) {
    // Per-window temporal mean normalization (zero means are set to 1).
    let mr = 0;
    let mg = 0;
    let mb = 0;
    for (let i = 0; i < window; i++) {
      const [r, g, b] = rgb[start + i];
      mr += r;
      mg += g;
      mb += b;
    }
    mr = mr / window || 1;
    mg = mg / window || 1;
    mb = mb / window || 1;

    for (let i = 0; i < window; i++) {
      const r = rgb[start + i][0] / mr;
      const g = rgb[start + i][1] / mg;
      const b = rgb[start + i][2] / mb;
      s1[i] =
        PROJECTION[0][0] * r + PROJECTION[0][1] * g + PROJECTION[0][2] * b;
      s2[i] =
        PROJECTION[1][0] * r + PROJECTION[1][1] * g + PROJECTION[1][2] * b;
    }

    const std2 = std(s2);
    const alpha = std2 > 0 ? std(s1) / std2 : 0;

    let componentMean = 0;
    for (let i = 0; i < window; i++) componentMean += s1[i] + alpha * s2[i];
    componentMean /= window;

    for (let i = 0; i < window; i++) {
      pulse[start + i] += s1[i] + alpha * s2[i] - componentMean;
    }
  }

  return pulse;
}
