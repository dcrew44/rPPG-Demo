/**
 * Composite per-session confidence score for the rPPG face box.
 *
 * Verbatim port of rppg/confidence.py: a two-factor quality score in [0, 1]
 * — spectral SNR and head motion — combined via a weighted geometric mean,
 * EMA-smoothed, and mapped to a red/yellow/green box color with hysteresis.
 * Visual indicator only; the heart-rate path is untouched.
 *
 * The mapping math lives in pure, camera-free module functions; only
 * ConfidenceScorer holds running state.
 */

import type { ColorBand } from "./state";

// --- SNR -------------------------------------------------------------------
export const SNR_DEV_HZ = 0.1;
export const SNR_BAND_HZ: readonly [number, number] = [0.7, 4.0];
export const SNR_DB_MIN = -6.0;
export const SNR_DB_MAX = 9.0;
export const SNR_DB_CAP = 10.0;

/** Spectrum handed from HREstimator.analyze() to the scorer. */
export interface Spectrum {
  readonly freqs: Float64Array;
  readonly psd: Float64Array;
  readonly fPeak: number;
}

/**
 * Self-referential rPPG SNR in decibels (de Haan / rPPG-Toolbox form).
 * Signal power is the PSD summed within +/-dev of the peak f0 and of its
 * second harmonic 2*f0; noise is the rest of the [lo, hi] band. Returns
 * -Infinity when the band holds no power or no signal (so the [0, 1] mapping
 * floors to 0), and SNR_DB_CAP when there is signal but no in-band noise.
 */
export function snrDb(
  freqs: ArrayLike<number>,
  psd: ArrayLike<number>,
  f0: number,
  dev: number = SNR_DEV_HZ,
  lo: number = SNR_BAND_HZ[0],
  hi: number = SNR_BAND_HZ[1],
): number {
  let bandSum = 0;
  let sig = 0;
  let noise = 0;
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    if (f < lo || f > hi) continue;
    bandSum += psd[i];
    if (Math.abs(f - f0) <= dev || Math.abs(f - 2 * f0) <= dev) {
      sig += psd[i];
    } else {
      noise += psd[i];
    }
  }
  if (bandSum <= 1e-12) return -Infinity;
  if (sig <= 0) return -Infinity;
  if (noise <= 0) return SNR_DB_CAP;
  return 10 * Math.log10(sig / noise);
}

/** Map an SNR in dB to [0, 1] with a clamped linear ramp (-Infinity -> 0). */
export function snrTo01(
  snrDbVal: number,
  loDb: number = SNR_DB_MIN,
  hiDb: number = SNR_DB_MAX,
): number {
  return Math.min(Math.max((snrDbVal - loDb) / (hiDb - loDb), 0), 1);
}

// --- motion ------------------------------------------------------------------
export const MOTION_K = 100.0;
export const MOTION_DEADBAND = 0.004;
// Per-frame displacement cap applied by ConfidenceScorer.
export const MOTION_WINSOR = 0.2;
// Min box diagonal (px) used by ConfidenceScorer to normalize.
export const DIAG_FLOOR = 1.0;

/**
 * Map mean normalized centroid displacement to a [0, 1] sub-score:
 * exp(-k * max(0, meanNormDisp - deadband)). The deadband absorbs sub-pixel
 * jitter.
 */
export function motionTo01(
  meanNormDisp: number,
  k: number = MOTION_K,
  deadband: number = MOTION_DEADBAND,
): number {
  return Math.exp(-k * Math.max(0, meanNormDisp - deadband));
}

// --- combination -------------------------------------------------------------
export const W_SNR = 0.6;
export const W_MOTION = 0.4;
export const GEOMEAN_EPS = 1e-3;

/**
 * Weighted geometric mean of [0, 1] factors, eps-floored before the log so a
 * zero factor cannot produce -Infinity and its veto is bounded. Weights need
 * not sum to 1 (normalized internally).
 */
export function qualityGeomean(
  values: readonly number[],
  weights: readonly number[],
  eps: number = GEOMEAN_EPS,
): number {
  let weightSum = 0;
  for (const w of weights) weightSum += w;
  let logSum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Math.min(Math.max(values[i], eps), 1);
    logSum += (weights[i] / weightSum) * Math.log(v);
  }
  return Math.exp(logSum);
}

// --- color band ----------------------------------------------------------------
export const BAND_LO = 0.4;
export const BAND_HI = 0.7;
export const HYSTERESIS = 0.05;

/**
 * Schmitt-trigger color band for a confidence value. From "gray" (no prior
 * color) entry is by region with no hysteresis; otherwise transitions
 * require clearing the margin.
 */
export function nextBand(
  conf: number,
  currentBand: ColorBand,
  lo: number = BAND_LO,
  hi: number = BAND_HI,
  hyst: number = HYSTERESIS,
): ColorBand {
  if (currentBand === "gray") {
    if (conf >= hi) return "green";
    return conf >= lo ? "yellow" : "red";
  }
  if (currentBand === "green") {
    return conf > hi - hyst ? "green" : "yellow";
  }
  if (currentBand === "red") {
    return conf >= lo + hyst ? "yellow" : "red";
  }
  // yellow
  if (conf >= hi + hyst) return "green";
  if (conf <= lo - hyst) return "red";
  return "yellow";
}

// --- scorer ----------------------------------------------------------------
export const TAU_CONF_S = 1.5;

/** One tick's confidence outcome. */
export interface ConfidenceResult {
  /** EMA-smoothed confidence in [0, 1], or null when there is no valid
   * estimate (warm-up / no face / degenerate window). */
  readonly score: number | null;
  readonly colorBand: ColorBand;
  /** Raw sub-scores {snr, motion, quality} for calibration logging; empty
   * when score is null. */
  readonly components: Readonly<Record<string, number>>;
}

/**
 * Stateful per-session composite confidence scorer. Fed a centroid every
 * frame (observeFrame, motion) and the HR-tick spectrum (score, SNR).
 */
export class ConfidenceScorer {
  private prevCenter: readonly [number, number] | null = null;
  private dispSum = 0;
  private dispCount = 0;
  private confSmooth: number | null = null;
  private band: ColorBand = "gray";

  constructor(
    private readonly weights: readonly [number, number] = [W_SNR, W_MOTION],
    private readonly tauConf: number = TAU_CONF_S,
  ) {}

  /**
   * Accumulate normalized centroid displacement for the current frame. A
   * null center/bbox (no face this frame) is a no-op that preserves the
   * previous centroid.
   */
  observeFrame(
    center: readonly [number, number] | null,
    bbox: readonly [number, number, number, number] | null,
  ): void {
    if (center === null || bbox === null) return;
    if (this.prevCenter !== null) {
      const [, , w, h] = bbox;
      const diag = Math.max(Math.hypot(w, h), DIAG_FLOOR);
      const d = Math.hypot(
        center[0] - this.prevCenter[0],
        center[1] - this.prevCenter[1],
      );
      this.dispSum += Math.min(d / diag, MOTION_WINSOR);
      this.dispCount += 1;
    }
    this.prevCenter = [center[0], center[1]];
  }

  /**
   * Compute the confidence for one HR tick. `dt` is the elapsed seconds
   * since the previous tick (for the EMA alpha). A null spectrum yields
   * score null / band "gray" and resets the EMA so the next valid tick
   * re-seeds.
   */
  score(spectrum: Spectrum | null, dt: number): ConfidenceResult {
    if (spectrum === null) {
      this.confSmooth = null;
      this.band = "gray";
      this.resetMotion();
      return { score: null, colorBand: "gray", components: {} };
    }

    const snr01 = snrTo01(snrDb(spectrum.freqs, spectrum.psd, spectrum.fPeak));
    const motion01 = motionTo01(this.motionMean());
    this.resetMotion();
    const quality = qualityGeomean([snr01, motion01], this.weights);

    let conf: number;
    if (this.confSmooth === null) {
      conf = quality;
    } else {
      const alpha = 1 - Math.exp(-dt / this.tauConf);
      conf = alpha * quality + (1 - alpha) * this.confSmooth;
    }
    this.confSmooth = conf;
    this.band = nextBand(conf, this.band);
    return {
      score: conf,
      colorBand: this.band,
      components: { snr: snr01, motion: motion01, quality },
    };
  }

  /** Forget all running state (new session/subject). */
  reset(): void {
    this.prevCenter = null;
    this.resetMotion();
    this.confSmooth = null;
    this.band = "gray";
  }

  private motionMean(): number {
    return this.dispCount === 0 ? 0 : this.dispSum / this.dispCount;
  }

  private resetMotion(): void {
    this.dispSum = 0;
    this.dispCount = 0;
  }
}
