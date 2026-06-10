// Port of rPPG-App tests/test_pos.py (the synthetic-signal recovery and
// too-short-input cases; the class-attribute tests do not apply to the
// function port).

import { describe, expect, it } from "vitest";

import type { RgbSample } from "../src/buffer";
import { posEstimate } from "../src/pos";

/** Deterministic 32-bit PRNG (mulberry32), standing in for numpy's rng. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal samples via Box-Muller over the uniform PRNG. */
function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Dominant frequency of `signal` within [low, high] Hz via a naive DFT over
 * the rfft frequency grid (n is small, so O(n^2) is fine for a test).
 */
function dominantFrequency(
  signal: Float64Array,
  fps: number,
  low = 0.7,
  high = 4.0,
): number {
  const n = signal.length;
  let bestFreq = 0;
  let bestPower = -1;
  for (let k = 0; k <= n / 2; k++) {
    const freq = (k * fps) / n;
    if (freq < low || freq > high) continue;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const angle = (-2 * Math.PI * k * i) / n;
      re += signal[i] * Math.cos(angle);
      im += signal[i] * Math.sin(angle);
    }
    const power = re * re + im * im;
    if (power > bestPower) {
      bestPower = power;
      bestFreq = freq;
    }
  }
  return bestFreq;
}

describe("posEstimate", () => {
  it("recovers an embedded 1.2 Hz heart rate from noisy RGB", () => {
    const fps = 30;
    const n = 300;
    const rand = mulberry32(0);

    const rgb: RgbSample[] = [];
    for (let i = 0; i < n; i++) {
      const p = Math.sin((2 * Math.PI * 1.2 * i) / fps); // 1.2 Hz ~= 72 bpm
      rgb.push([
        0.8 + 0.01 * p + 0.001 * gaussian(rand),
        0.7 + 0.02 * p + 0.001 * gaussian(rand),
        0.6 + 0.005 * p + 0.001 * gaussian(rand),
      ]);
    }

    const pulse = posEstimate(rgb, fps);

    expect(pulse).toHaveLength(n);
    expect(Math.abs(dominantFrequency(pulse, fps) - 1.2)).toBeLessThan(0.15);
  });

  it("returns zeros when there are fewer samples than one window", () => {
    const fps = 30;
    const n = 5; // window length is round(1.6 * 30) = 48, so n < window
    const rgb: RgbSample[] = Array.from({ length: n }, () => [1, 1, 1]);

    const pulse = posEstimate(rgb, fps);

    expect(pulse).toHaveLength(n);
    expect([...pulse]).toEqual(new Array(n).fill(0));
  });
});
