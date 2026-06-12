// Pure color-ramp and plot-geometry math from display.ts; no DOM.

import { describe, expect, it } from "vitest";

import {
  confidenceColor,
  GATE_CONFIDENCE,
  gateBpm,
  hzToX,
  qualityHint,
  spectrumPoints,
  trendPoints,
  trendRange,
  waveformPoints,
} from "../src/display";
import type { State } from "../src/state";

/** A baseline healthy State for the gating/hint helpers. */
function makeState(over: Partial<State> = {}): State {
  return {
    bbox: [100, 100, 200, 250],
    pulseSignal: new Float64Array(0),
    bpm: 70,
    hasFace: true,
    confidence: 0.8,
    confidenceColor: "green",
    confidenceComponents: { snr: 0.8, motion: 0.9, quality: 0.84 },
    warmupProgress: null,
    bpmTrend: [],
    roiPolygons: [],
    spectrum: null,
    ...over,
  };
}

describe("confidenceColor", () => {
  it("is gray when there is no estimate", () => {
    expect(confidenceColor(null)).toBe("#9aa0a8");
  });

  it("is pure red at and below BAND_LO", () => {
    expect(confidenceColor(0)).toBe("rgb(239, 68, 68)");
    expect(confidenceColor(0.2)).toBe("rgb(239, 68, 68)");
    expect(confidenceColor(0.4)).toBe("rgb(239, 68, 68)");
  });

  it("is pure yellow at the band midpoint", () => {
    expect(confidenceColor(0.55)).toBe("rgb(234, 179, 8)");
  });

  it("is pure green at and above BAND_HI", () => {
    expect(confidenceColor(0.7)).toBe("rgb(34, 197, 94)");
    expect(confidenceColor(0.9)).toBe("rgb(34, 197, 94)");
    expect(confidenceColor(1)).toBe("rgb(34, 197, 94)");
  });

  it("blends linearly between anchors", () => {
    // Halfway between the red (0.4) and yellow (0.55) anchors. The green
    // channel is 123, not 124: (0.475 - 0.4) / 0.15 is a hair under 0.5 in
    // float, so 68 + 111*t rounds down.
    expect(confidenceColor(0.475)).toBe("rgb(237, 123, 38)");
  });

  it("ramps the green channel monotonically across the band", () => {
    const green = (score: number): number => {
      const m = /^rgb\(\d+, (\d+), \d+\)$/.exec(confidenceColor(score));
      return Number(m![1]);
    };
    let prev = green(0.4);
    for (let s = 0.45; s <= 0.7001; s += 0.05) {
      const g = green(s);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
  });
});

function parsePoints(points: string): [number, number][] {
  if (points === "") return [];
  return points.split(" ").map((pair) => {
    const [x, y] = pair.split(",");
    return [Number(x), Number(y)];
  });
}

describe("waveformPoints", () => {
  it("is empty for fewer than two samples", () => {
    expect(waveformPoints([])).toBe("");
    expect(waveformPoints([1])).toBe("");
  });

  it("draws a constant signal on the midline", () => {
    const pts = parsePoints(waveformPoints(new Float64Array(50).fill(3)));
    expect(pts).toHaveLength(50);
    for (const [, y] of pts) expect(y).toBeCloseTo(20, 6);
  });

  it("spans the width and stays inside the plot for a sine", () => {
    const sig = Float64Array.from({ length: 300 }, (_, i) =>
      Math.sin((2 * Math.PI * 1.2 * i) / 30),
    );
    const pts = parsePoints(waveformPoints(sig));
    expect(pts).toHaveLength(300);
    expect(pts[0][0]).toBe(0);
    expect(pts[pts.length - 1][0]).toBe(100);
    for (const [, y] of pts) {
      expect(y).toBeGreaterThanOrEqual(2);
      expect(y).toBeLessThanOrEqual(38);
    }
    // The trace actually uses the height (2-sigma scaling, clamped).
    const ys = pts.map(([, y]) => y);
    expect(Math.min(...ys)).toBeLessThan(10);
    expect(Math.max(...ys)).toBeGreaterThan(30);
  });

  it("clips a transient spike instead of flattening the rest", () => {
    const sig = Float64Array.from({ length: 100 }, (_, i) =>
      Math.sin((2 * Math.PI * i) / 25),
    );
    sig[50] = 8; // an ~8x transient spike
    const ys = parsePoints(waveformPoints(sig)).map(([, y]) => y);
    // The spike clamps to the top margin...
    expect(Math.min(...ys)).toBeCloseTo(2, 6);
    // ...while the sine still visibly oscillates around the midline.
    expect(Math.max(...ys)).toBeGreaterThan(24);
  });
});

describe("hzToX", () => {
  it("maps the view range onto the plot width", () => {
    expect(hzToX(0.5)).toBeCloseTo(0, 9);
    expect(hzToX(4.0)).toBeCloseTo(100, 9);
    expect(hzToX(2.25)).toBeCloseTo(50, 9);
  });
});

describe("spectrumPoints", () => {
  const freqs = Float64Array.from({ length: 101 }, (_, i) => i * 0.05);
  const psd = Float64Array.from(freqs, (f) =>
    Math.exp(-(((f - 1.2) / 0.1) ** 2)),
  );

  it("is empty when no in-range bin has power", () => {
    expect(spectrumPoints(freqs, new Float64Array(freqs.length))).toBe("");
  });

  it("normalizes the tallest in-range bin to the top margin", () => {
    const pts = parsePoints(spectrumPoints(freqs, psd));
    const ys = pts.map(([, y]) => y);
    expect(Math.min(...ys)).toBeCloseTo(2, 2);
    for (const y of ys) expect(y).toBeLessThanOrEqual(38);
  });

  it("only plots bins inside the view range", () => {
    const pts = parsePoints(spectrumPoints(freqs, psd));
    const inRange = Array.from(freqs).filter((f) => f >= 0.5 && f <= 4);
    expect(pts).toHaveLength(inRange.length);
    for (const [x] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
    }
  });

  it("places the peak at the peak frequency's x", () => {
    const pts = parsePoints(spectrumPoints(freqs, psd));
    const [peakX] = pts.reduce((a, b) => (b[1] < a[1] ? b : a));
    expect(peakX).toBeCloseTo(hzToX(1.2), 1);
  });
});

describe("gateBpm", () => {
  it("passes the live value through at good confidence", () => {
    expect(gateBpm(72, 0.8, 65)).toEqual({ shown: 72, held: false });
  });

  it("holds the last good value below the gate", () => {
    expect(gateBpm(140, GATE_CONFIDENCE - 0.05, 72)).toEqual({
      shown: 72,
      held: true,
    });
  });

  it("holds when there is no confidence estimate (re-warming)", () => {
    expect(gateBpm(72, null, 70)).toEqual({ shown: 70, held: true });
  });

  it("falls back to the live value when nothing was held yet", () => {
    expect(gateBpm(95, 0.1, null)).toEqual({ shown: 95, held: true });
  });

  it("shows nothing without a BPM", () => {
    expect(gateBpm(null, 0.9, 70)).toEqual({ shown: null, held: false });
  });
});

describe("qualityHint", () => {
  it("asks for a face first", () => {
    expect(qualityHint(makeState({ hasFace: false, confidence: null }))).toBe(
      "No face — face the camera",
    );
  });

  it("reports warm-up progress", () => {
    expect(qualityHint(makeState({ warmupProgress: 0.6 }))).toBe(
      "Calibrating 60%",
    );
  });

  it("is silent at good confidence", () => {
    expect(qualityHint(makeState())).toBe("");
  });

  it("blames motion when motion is the weaker component", () => {
    const state = makeState({
      confidence: 0.2,
      confidenceComponents: { snr: 0.7, motion: 0.1, quality: 0.2 },
    });
    expect(qualityHint(state)).toBe("Low confidence — hold still");
  });

  it("blames lighting when SNR is the weaker component", () => {
    const state = makeState({
      confidence: 0.2,
      confidenceComponents: { snr: 0.1, motion: 0.9, quality: 0.2 },
    });
    expect(qualityHint(state)).toBe(
      "Low confidence — try brighter, more even lighting",
    );
  });
});

describe("trendPoints / trendRange", () => {
  it("is empty with fewer than two points", () => {
    expect(trendPoints([])).toBe("");
    expect(trendPoints([[0, 70]])).toBe("");
    expect(trendRange([])).toBeNull();
  });

  it("stretches a short history across the full width", () => {
    const trend: (readonly [number, number])[] = [
      [0, 70],
      [10, 72],
      [20, 74],
    ];
    const pts = parsePoints(trendPoints(trend));
    expect(pts).toHaveLength(3);
    expect(pts[0][0]).toBe(0);
    expect(pts[pts.length - 1][0]).toBe(100);
  });

  it("only plots points inside the window", () => {
    const trend: (readonly [number, number])[] = [
      [0, 200], // far outside the 120 s window — must not skew the scale
      [200, 70],
      [210, 72],
    ];
    const pts = parsePoints(trendPoints(trend));
    expect(pts).toHaveLength(2);
    expect(trendRange(trend)).toEqual([70, 72]);
  });

  it("keeps a flat trend near the midline with the minimum span", () => {
    const trend: (readonly [number, number])[] = [
      [0, 70],
      [10, 70.5],
      [20, 70],
    ];
    const ys = parsePoints(trendPoints(trend)).map(([, y]) => y);
    for (const y of ys) {
      expect(y).toBeGreaterThan(15);
      expect(y).toBeLessThan(25);
    }
  });

  it("stays inside the plot for a wide-ranging trend", () => {
    const trend: (readonly [number, number])[] = [];
    for (let i = 0; i <= 60; i++) {
      trend.push([i * 2, 70 + 50 * Math.sin(i / 6)]);
    }
    const ys = parsePoints(trendPoints(trend)).map(([, y]) => y);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(2);
      expect(y).toBeLessThanOrEqual(38);
    }
  });
});
