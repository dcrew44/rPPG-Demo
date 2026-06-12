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
    // The displayed BPM is median-smoothed over recent ticks, so it tracks
    // the raw spectral peak closely but not exactly.
    expect(Math.abs(state!.spectrum!.fPeak * 60 - state!.bpm!)).toBeLessThan(5);
    expect(state!.warmupProgress).toBeNull();
    expect(state!.bpmTrend.length).toBeGreaterThan(5);
    const lastTrend = state!.bpmTrend[state!.bpmTrend.length - 1];
    expect(lastTrend[1]).toBe(state!.bpm);
    expect(state!.confidenceComponents.snr).toBeGreaterThan(0);

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

  it("reports warm-up progress until minSeconds is buffered", () => {
    const pipeline = new Pipeline(null);
    const source = new DemoSignal();

    let state = pipeline.ingest(source.observation(0), 0);
    expect(state.warmupProgress).toBe(0);

    for (let i = 1; i <= 2.5 * DEMO_FPS; i++) {
      const t = i / DEMO_FPS;
      state = pipeline.ingest(source.observation(t), t);
    }
    // ~2.5 s of the 5 s warm-up buffered.
    expect(state.warmupProgress).toBeGreaterThan(0.4);
    expect(state.warmupProgress).toBeLessThan(0.6);

    for (let i = 2.5 * DEMO_FPS + 1; i <= 6 * DEMO_FPS; i++) {
      const t = i / DEMO_FPS;
      state = pipeline.ingest(source.observation(t), t);
    }
    expect(state.warmupProgress).toBeNull();
  });

  it("re-warms after a sample-clock gap, holding the last BPM", () => {
    const pipeline = new Pipeline(null);
    const source = new DemoSignal();

    let state: State | undefined;
    for (let i = 0; i <= 8 * DEMO_FPS; i++) {
      const t = i / DEMO_FPS;
      state = pipeline.ingest(source.observation(t), t);
    }
    const bpmBefore = state!.bpm;
    expect(bpmBefore).not.toBeNull();
    expect(state!.warmupProgress).toBeNull();

    // The sample clock jumps 5 s (hidden tab / camera switch): the stale
    // window must be discarded — back to warm-up, gray confidence, no
    // spectrum — while the last BPM is kept for the held readout.
    const tAfterGap = 8 + 5;
    state = pipeline.ingest(source.observation(tAfterGap), tAfterGap);
    expect(state.warmupProgress).not.toBeNull();
    expect(state.confidence).toBeNull();
    expect(state.confidenceColor).toBe("gray");
    expect(state.spectrum).toBeNull();
    expect(state.pulseSignal.length).toBe(0);
    expect(state.bpm).toBe(bpmBefore);
  });

  it("does not reset across an ordinary inter-frame interval", () => {
    const pipeline = new Pipeline(null);
    const source = new DemoSignal();

    let state: State | undefined;
    for (let i = 0; i <= 8 * DEMO_FPS; i++) {
      const t = i / DEMO_FPS;
      state = pipeline.ingest(source.observation(t), t);
    }
    // A 1 s hiccup (below GAP_RESET_S) must not throw the window away.
    const t = 8 + 1;
    state = pipeline.ingest(source.observation(t), t);
    expect(state.warmupProgress).toBeNull();
    expect(state.spectrum).not.toBeNull();
  });
});
