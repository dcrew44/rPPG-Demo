// End-to-end Pipeline test, camera-free: the synthetic demo source drives
// the real buffer -> POS -> HR -> confidence path through ingest(), pinning
// that demo mode shows a working pipeline (correct BPM, green confidence).

import { describe, expect, it } from "vitest";

import { DEMO_FPS, DemoSignal } from "../src/demo";
import { Pipeline } from "../src/pipeline";
import type { State } from "../src/state";

describe("DemoSignal", () => {
  it("is deterministic for a given seed", () => {
    const a = new DemoSignal(7);
    const b = new DemoSignal(7);
    for (let i = 0; i < 60; i++) {
      const t = i / DEMO_FPS;
      expect(a.observation(t)).toEqual(b.observation(t));
    }
  });

  it("emits a face-shaped observation", () => {
    const obs = new DemoSignal().observation(0);
    expect(obs.roiPolygons).toHaveLength(3);
    expect(obs.bbox[2]).toBeGreaterThan(0);
    for (const c of obs.meanRgb) {
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(255);
    }
  });
});

describe("Pipeline.ingest on the demo signal", () => {
  it("recovers the synthetic heart rate with green confidence", () => {
    const pipeline = new Pipeline(null);
    const source = new DemoSignal();

    let state: State | undefined;
    for (let i = 0; i <= 12 * DEMO_FPS; i++) {
      const t = i / DEMO_FPS;
      state = pipeline.ingest(source.observation(t), t);
    }

    // DemoSignal's rate drifts in 1.06-1.20 Hz (~64-72 bpm).
    expect(state!.bpm).toBeGreaterThan(60);
    expect(state!.bpm).toBeLessThan(76);
    expect(state!.spectrum).not.toBeNull();
    expect(state!.spectrum!.fPeak * 60).toBeCloseTo(state!.bpm!, 6);

    expect(state!.hasFace).toBe(true);
    expect(state!.bbox).not.toBeNull();
    expect(state!.roiPolygons).toHaveLength(3);

    // A clean, nearly-still synthetic pulse must read as high confidence —
    // this is the demo's first impression.
    expect(state!.confidence!).toBeGreaterThan(0.7);
    expect(state!.confidenceColor).toBe("green");
    expect(state!.pulseSignal.length).toBeGreaterThan(5 * DEMO_FPS);
  });

  it("returns a no-face state when fed null", () => {
    const pipeline = new Pipeline(null);
    const state = pipeline.ingest(null, 0);
    expect(state.hasFace).toBe(false);
    expect(state.bbox).toBeNull();
    expect(state.roiPolygons).toHaveLength(0);
    expect(state.bpm).toBeNull();
  });
});
