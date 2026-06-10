// Port of rPPG-App tests/test_hr.py.

import { describe, expect, it } from "vitest";

import { HREstimator } from "../src/hr";

function sinusoid(freqHz: number, fps: number, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++)
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / fps);
  return out;
}

describe("HREstimator", () => {
  it.each([
    [1.0, 60.0],
    [1.25, 75.0],
    [2.0, 120.0],
  ])("recovers a pure %f Hz sinusoid as ~%f bpm", (freqHz, expectedBpm) => {
    const bpm = new HREstimator().bpm(sinusoid(freqHz, 30, 300), 30);
    expect(bpm).not.toBeNull();
    expect(Math.abs((bpm as number) - expectedBpm)).toBeLessThanOrEqual(3);
  });

  it("returns null for a too-short signal", () => {
    const signal = Float64Array.from({ length: 10 }, (_, i) => Math.sin(i));
    expect(new HREstimator().bpm(signal, 30)).toBeNull();
  });

  it("returns null for an empty signal", () => {
    expect(new HREstimator().bpm(new Float64Array(0), 30)).toBeNull();
  });

  it("accepts plain-array input", () => {
    const signal = [...sinusoid(1.0, 30, 300)];
    const bpm = new HREstimator().bpm(signal, 30);
    expect(bpm).not.toBeNull();
    expect(Math.abs((bpm as number) - 60)).toBeLessThanOrEqual(3);
  });

  it("returns null for non-positive fps", () => {
    const signal = Float64Array.from({ length: 300 }, (_, i) => Math.sin(i));
    expect(new HREstimator().bpm(signal, 0)).toBeNull();
  });

  it("rejects an out-of-band harmonic", () => {
    // A fundamental at 80 bpm with a dominant 2nd harmonic at 160 bpm
    // (2.67 Hz, above the 2.5 Hz passband) must report the fundamental, not
    // the harmonic. A wide band (up to 4 Hz / 240 bpm) would lock onto the
    // stronger harmonic and report ~160 bpm — the doubling failure seen on
    // real subjects.
    const fps = 30;
    const n = 600;
    const signal = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / fps;
      signal[i] =
        Math.sin(2 * Math.PI * (80 / 60) * t) +
        3 * Math.sin(2 * Math.PI * (160 / 60) * t);
    }
    const bpm = new HREstimator().bpm(signal, fps);
    expect(bpm).not.toBeNull();
    expect(Math.abs((bpm as number) - 80)).toBeLessThanOrEqual(4);
  });

  it("analyze returns the spectrum and the bpm", () => {
    const result = new HREstimator().analyze(sinusoid(1.2, 30, 300), 30); // 72 bpm
    expect(result).not.toBeNull();
    const { bpm, freqs, psd, fPeak } = result!;
    expect(Math.abs(bpm - 72)).toBeLessThanOrEqual(3);
    expect(freqs.length).toBe(psd.length);
    expect(Math.abs(fPeak - 1.2)).toBeLessThanOrEqual(0.1);
  });

  it("analyze bpm matches the bpm() method", () => {
    const est = new HREstimator();
    const signal = sinusoid(1.0, 30, 300);
    const result = est.analyze(signal, 30);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.bpm - 60)).toBeLessThanOrEqual(3);
    expect(result!.bpm).toBe(est.bpm(signal, 30));
  });

  it("analyze returns null for a too-short signal", () => {
    const signal = Float64Array.from({ length: 10 }, (_, i) => Math.sin(i));
    expect(new HREstimator().analyze(signal, 30)).toBeNull();
  });
});
