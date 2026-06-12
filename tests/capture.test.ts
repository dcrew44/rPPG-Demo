// startFrameLoop's requestVideoFrameCallback path, driven by a stub video.
// Covers the iOS Safari workaround: camera streams whose metadata.mediaTime
// stops advancing must not freeze the sample clock.

import { describe, expect, it } from "vitest";

import { MEDIA_TIME_STALL_FRAMES, startFrameLoop } from "../src/capture";

type RvfcCallback = (
  now: DOMHighResTimeStamp,
  metadata: VideoFrameCallbackMetadata,
) => void;

/** A stub video exposing requestVideoFrameCallback; fire() delivers one
 * frame to the most recently registered callback. */
function makeRvfcVideo(): {
  video: HTMLVideoElement;
  fire: (nowMs: number, mediaTime: number) => void;
} {
  let pending: RvfcCallback | null = null;
  const video = {
    requestVideoFrameCallback(cb: RvfcCallback): number {
      pending = cb;
      return 0;
    },
  } as unknown as HTMLVideoElement;
  return {
    video,
    fire: (nowMs, mediaTime) => {
      const cb = pending;
      pending = null;
      cb?.(nowMs, { mediaTime } as VideoFrameCallbackMetadata);
    },
  };
}

describe("startFrameLoop (requestVideoFrameCallback)", () => {
  it("passes advancing mediaTime through as the sample clock", () => {
    const { video, fire } = makeRvfcVideo();
    const samples: [number, number][] = [];
    startFrameLoop(video, (t, nowMs) => samples.push([t, nowMs]));

    for (let i = 0; i < 5; i++) fire(1000 + i * 33, i / 30);
    expect(samples.map(([t]) => t)).toEqual([
      0,
      1 / 30,
      2 / 30,
      3 / 30,
      4 / 30,
    ]);
    expect(samples[0][1]).toBe(1000);
  });

  it("falls back to the callback clock when mediaTime never advances", () => {
    const { video, fire } = makeRvfcVideo();
    const ts: number[] = [];
    startFrameLoop(video, (t) => ts.push(t));

    const total = MEDIA_TIME_STALL_FRAMES + 30;
    for (let i = 0; i < total; i++) fire(2000 + i * 33, 0);

    // Until the stall is recognized the frozen mediaTime is reported as-is
    // (the switch itself is anchored, so it introduces no jump)…
    for (let i = 0; i <= MEDIA_TIME_STALL_FRAMES; i++) expect(ts[i]).toBe(0);
    // …then the clock advances at the callback rate.
    for (let i = MEDIA_TIME_STALL_FRAMES + 1; i < total; i++) {
      const sinceSwitch = (i - MEDIA_TIME_STALL_FRAMES) * 33;
      expect(ts[i]).toBeCloseTo(sinceSwitch / 1000, 10);
    }
    // Sanity: the clock spans real duration once fallen back.
    expect(ts[total - 1]).toBeGreaterThan(0.5);
  });

  it("falls back when mediaTime freezes after advancing for a while", () => {
    const { video, fire } = makeRvfcVideo();
    const ts: number[] = [];
    startFrameLoop(video, (t) => ts.push(t));

    // Healthy for 5 frames, then frozen at the last good mediaTime.
    for (let i = 0; i < 5; i++) fire(i * 33, i / 30);
    const frozen = 4 / 30;
    const total = 5 + MEDIA_TIME_STALL_FRAMES + 20;
    for (let i = 5; i < total; i++) fire(i * 33, frozen);

    // The stall run reports the frozen value until the switch (the switch
    // frame itself is the re-anchored clock, equal up to float rounding)…
    for (let i = 5; i <= 4 + MEDIA_TIME_STALL_FRAMES; i++) {
      expect(ts[i]).toBeCloseTo(frozen, 10);
    }
    // …then advances at the callback rate, anchored at the frozen value.
    const switchIndex = 4 + MEDIA_TIME_STALL_FRAMES;
    for (let i = switchIndex + 1; i < total; i++) {
      expect(ts[i]).toBeCloseTo(frozen + (i - switchIndex) * 0.033, 10);
    }
  });

  it("treats a backwards mediaTime jump (loop wrap) as progress", () => {
    const { video, fire } = makeRvfcVideo();
    const ts: number[] = [];
    startFrameLoop(video, (t) => ts.push(t));

    // A looping clip: mediaTime restarts near 0 at the wrap, then keeps
    // advancing. Every frame changes, so the fallback must never trigger.
    const mediaTimes = [29.9, 29.933, 29.966, 0.01, 0.043];
    for (let i = 0; i < MEDIA_TIME_STALL_FRAMES; i++) {
      mediaTimes.push(0.076 + i / 30);
    }
    mediaTimes.forEach((mt, i) => fire(i * 33, mt));
    expect(ts).toEqual(mediaTimes);
  });

  it("stops delivering frames after the stop function is called", () => {
    const { video, fire } = makeRvfcVideo();
    const ts: number[] = [];
    const stop = startFrameLoop(video, (t) => ts.push(t));

    fire(0, 0);
    stop();
    fire(33, 1 / 30);
    expect(ts).toEqual([0]);
  });
});
