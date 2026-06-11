// Port of rPPG-App tests/test_confidence.py, with the mapping tables updated
// for this port's recalibrated constants (see src/confidence.ts's header).

import { describe, expect, it } from "vitest";

import {
  ConfidenceScorer,
  GEOMEAN_EPS,
  motionTo01,
  nextBand,
  qualityGeomean,
  snrDb,
  snrTo01,
  W_SNR,
  type Spectrum,
} from "../src/confidence";
import { HREstimator } from "../src/hr";

/** rfftfreq equivalent: bins k * fps / n for k = 0..n/2. */
function rfftfreq(n: number, fps: number): Float64Array {
  const out = new Float64Array(Math.floor(n / 2) + 1);
  for (let k = 0; k < out.length; k++) out[k] = (k * fps) / n;
  return out;
}

function argminAbsDiff(freqs: Float64Array, target: number): number {
  let best = 0;
  for (let i = 1; i < freqs.length; i++) {
    if (Math.abs(freqs[i] - target) < Math.abs(freqs[best] - target)) best = i;
  }
  return best;
}

/** A Welch-like PSD: flat floor with sharp lobes at f0 and 2*f0. */
function peakySpectrum(
  f0 = 1.2,
  fps = 30,
  n = 256,
  floor = 0.01,
  peak = 10,
  harm = 2,
): Spectrum {
  const freqs = rfftfreq(n, fps);
  const psd = new Float64Array(freqs.length).fill(floor);
  psd[argminAbsDiff(freqs, f0)] += peak;
  psd[argminAbsDiff(freqs, 2 * f0)] += harm;
  return { freqs, psd, fPeak: f0 };
}

describe("snrDb", () => {
  it("is high for a peaky spectrum", () => {
    const { freqs, psd, fPeak } = peakySpectrum();
    expect(snrDb(freqs, psd, fPeak)).toBeGreaterThan(6);
  });

  it("is low for a flat spectrum", () => {
    const freqs = rfftfreq(256, 30);
    const psd = new Float64Array(freqs.length).fill(1);
    const db = snrDb(freqs, psd, 1.2);
    expect(db).toBeGreaterThan(-10);
    expect(db).toBeLessThan(0);
  });

  it("maps an all-zero PSD to the floor, not the cap", () => {
    const freqs = rfftfreq(256, 30);
    const psd = new Float64Array(freqs.length);
    // All-zero PSD (e.g. an all-zero pulse) must NOT read as perfect SNR;
    // snrTo01 of this must be 0, never 1.
    expect(snrTo01(snrDb(freqs, psd, 1.2))).toBe(0);
  });

  it("counts the second harmonic as signal", () => {
    // A spectrum whose ONLY power is at the 2nd harmonic (2*f0 = 2.4 Hz,
    // above the 0.75-2.5 HR band but inside the 0.7-4.0 SNR band) must still
    // be counted as signal.
    const freqs = rfftfreq(256, 30);
    const psd = new Float64Array(freqs.length).fill(0.01);
    psd[argminAbsDiff(freqs, 2.4)] += 10;
    expect(snrDb(freqs, psd, 1.2)).toBeGreaterThan(0);
  });
});

describe("snrTo01", () => {
  it.each([
    [-5.0, 0.0],
    [0.0, 0.5],
    [2.5, 0.75],
    [5.0, 1.0],
    [20.0, 1.0],
    [-20.0, 0.0],
    [-Infinity, 0.0],
  ])("maps %f dB to %f", (db, expected) => {
    expect(snrTo01(db)).toBeCloseTo(expected, 9);
  });
});

describe("motionTo01", () => {
  it("is 1 inside the deadband", () => {
    expect(motionTo01(0)).toBe(1);
    expect(motionTo01(0.008)).toBe(1);
  });

  it("decays exponentially past the deadband", () => {
    // deadband 0.008; k=50 -> exp(-50*(0.028-0.008)) = exp(-1) ~ 0.368
    expect(motionTo01(0.028)).toBeCloseTo(0.368, 2);
  });

  it("is near zero for large motion", () => {
    expect(motionTo01(0.11)).toBeLessThan(0.01);
  });
});

describe("qualityGeomean", () => {
  it("is the weighted product of powers", () => {
    const val = qualityGeomean([0.81, 0.25], [0.6, 0.4]);
    expect(val).toBeCloseTo(0.81 ** 0.6 * 0.25 ** 0.4, 9);
  });

  it("floors a zero factor at eps", () => {
    const val = qualityGeomean([0, 1], [0.6, 0.4]);
    // zero factor is clamped to eps, so quality == eps ** (w_snr normalized)
    expect(val).toBeCloseTo(GEOMEAN_EPS ** W_SNR, 6);
  });

  it("is monotonic in each factor", () => {
    const low = qualityGeomean([0.4, 0.5], [0.6, 0.4]);
    const high = qualityGeomean([0.9, 0.5], [0.6, 0.4]);
    expect(high).toBeGreaterThan(low);
  });
});

describe("nextBand", () => {
  it("enters from gray by region (no hysteresis)", () => {
    expect(nextBand(0.8, "gray")).toBe("green");
    expect(nextBand(0.5, "gray")).toBe("yellow");
    expect(nextBand(0.2, "gray")).toBe("red");
  });

  it.each([
    [0.72, "yellow", "yellow"], // below 0.75 -> no jump to green
    [0.76, "yellow", "green"],
    [0.34, "yellow", "red"],
    [0.36, "yellow", "yellow"], // above 0.35 -> hold
    [0.66, "green", "green"], // above 0.65 -> hold green
    [0.64, "green", "yellow"],
    [0.44, "red", "red"], // below 0.45 -> hold red
    [0.46, "red", "yellow"],
  ] as const)(
    "applies hysteresis (%f from %s -> %s)",
    (conf, current, expected) => {
      expect(nextBand(conf, current)).toBe(expected);
    },
  );
});

describe("calibration against the hr.ts periodogram", () => {
  // Deterministic uniform [0, 1) PRNG so the spectrum is reproducible.
  function mulberry32(seed: number): () => number {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The full steady-state window: 10 s of a clean 1.2 Hz pulse at 30 fps
  // with mild broadband noise — the signal the SNR ramp is calibrated for.
  const fps = 30;
  const rand = mulberry32(1234);
  const signal = Float64Array.from({ length: 10 * fps }, (_, i) => {
    const t = i / fps;
    return Math.sin(2 * Math.PI * 1.2 * t) + 0.5 * (rand() - 0.5);
  });
  const analysis = new HREstimator().analyze(signal, fps)!;

  it("scores a clean pulse high on the raw Hann periodogram", () => {
    const { freqs, psd, fPeak } = analysis;
    expect(fPeak).toBeCloseTo(1.2, 1);
    expect(snrDb(freqs, psd, fPeak)).toBeGreaterThanOrEqual(3);
    expect(snrTo01(snrDb(freqs, psd, fPeak))).toBeGreaterThanOrEqual(0.8);
  });

  it("needs the widened dev: a +/-0.1 Hz window leaks the peak's own Hann lobe into noise", () => {
    const { freqs, psd, fPeak } = analysis;
    expect(snrDb(freqs, psd, fPeak, 0.2)).toBeGreaterThan(
      snrDb(freqs, psd, fPeak, 0.1),
    );
  });
});

const STILL_BBOX = [50, 50, 100, 100] as const;
const STILL_CENTER = [100, 100] as const;

function stillObserve(scorer: ConfidenceScorer, n = 10): void {
  for (let i = 0; i < n; i++) scorer.observeFrame(STILL_CENTER, STILL_BBOX);
}

describe("ConfidenceScorer", () => {
  it("returns gray with a null spectrum", () => {
    const result = new ConfidenceScorer().score(null, 0.5);
    expect(result.score).toBeNull();
    expect(result.colorBand).toBe("gray");
  });

  it("scores a clean still signal green", () => {
    const scorer = new ConfidenceScorer();
    stillObserve(scorer);
    const result = scorer.score(peakySpectrum(), 0.5);
    expect(result.score).not.toBeNull();
    expect(result.colorBand).toBe("green");
    expect(result.components.motion).toBeCloseTo(1, 6);
    expect(result.components.snr).toBeGreaterThan(0.9);
  });

  it("seeds the EMA with the first tick's quality", () => {
    const scorer = new ConfidenceScorer();
    stillObserve(scorer);
    const result = scorer.score(peakySpectrum(), 0.5);
    // First valid tick seeds the EMA: score == raw quality, not lerped from 0.
    expect(result.score).toBeCloseTo(result.components.quality, 9);
  });

  it("lowers the score under motion", () => {
    const spectrum = peakySpectrum();

    const still = new ConfidenceScorer();
    stillObserve(still);
    const rStill = still.score(spectrum, 0.5);

    const moving = new ConfidenceScorer();
    for (let i = 0; i < 10; i++) {
      moving.observeFrame([100 + 20 * i, 100], STILL_BBOX);
    }
    const rMove = moving.score(spectrum, 0.5);

    expect(rMove.components.motion).toBeLessThan(rStill.components.motion);
    expect(rMove.score!).toBeLessThan(rStill.score!);
  });

  it("does not let a returning face spike the motion (winsor cap)", () => {
    const scorer = new ConfidenceScorer();
    // 9 frames: face perfectly still (zero displacement each).
    for (let i = 0; i < 9; i++) scorer.observeFrame(STILL_CENTER, STILL_BBOX);
    // 1 frame: face reappears far away (raw d/diag ~3.0; cap clips to 0.20).
    scorer.observeFrame([400, 400], STILL_BBOX);
    const result = scorer.score(peakySpectrum(), 0.5);
    // With the cap the tick mean stays low enough that motion is clearly
    // usable; without it one outlier would drive motion to ~0.
    expect(result.components.motion).toBeGreaterThan(0.05);
  });

  it("lags a step change through the EMA", () => {
    const scorer = new ConfidenceScorer();
    stillObserve(scorer);
    const r1 = scorer.score(peakySpectrum(), 0.5); // seeds high

    // A flat (bad) spectrum on the next tick: confidence drops but is
    // smoothed.
    const freqs = rfftfreq(256, 30);
    const psd = new Float64Array(freqs.length).fill(1);
    stillObserve(scorer);
    const r2 = scorer.score({ freqs, psd, fPeak: 1.2 }, 0.5);
    expect(r2.score!).toBeLessThan(r1.score!); // moved toward the bad value
    expect(r2.score!).toBeGreaterThan(r2.components.quality); // lagged
  });

  it("reset clears the running state", () => {
    const scorer = new ConfidenceScorer();
    stillObserve(scorer);
    scorer.score(peakySpectrum(), 0.5);
    scorer.reset();
    // After reset the next tick re-seeds (score == quality again).
    stillObserve(scorer);
    const result = scorer.score(peakySpectrum(), 0.5);
    expect(result.score).toBeCloseTo(result.components.quality, 9);
  });

  it("re-seeds the EMA after a gray gap", () => {
    const scorer = new ConfidenceScorer();
    stillObserve(scorer);
    scorer.score(peakySpectrum(), 0.5); // seed
    scorer.score(null, 0.5); // gray gap resets the EMA
    stillObserve(scorer);
    const result = scorer.score(peakySpectrum(), 0.5);
    // Re-seeded after the gap: score == raw quality again, not lerped.
    expect(result.score).toBeCloseTo(result.components.quality, 9);
  });
});
