// startFrameLoop's requestVideoFrameCallback path, driven by a stub video.
// Covers the iOS Safari workaround: camera streams whose metadata.mediaTime
// never advances must not freeze the sample clock.

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

    // During the probe the frozen mediaTime is reported as-is…
    for (let i = 0; i < MEDIA_TIME_STALL_FRAMES - 1; i++) expect(ts[i]).toBe(0);
    // …then the clock advances at the callback rate, anchored so the switch
    // itself introduces no jump.
    expect(ts[MEDIA_TIME_STALL_FRAMES - 1]).toBe(0);
    for (let i = MEDIA_TIME_STALL_FRAMES; i < total; i++) {
      const sinceSwitch = (i - (MEDIA_TIME_STALL_FRAMES - 1)) * 33;
      expect(ts[i]).toBeCloseTo(sinceSwitch / 1000, 10);
    }
    // Sanity: the clock spans real duration once fallen back.
    expect(ts[total - 1]).toBeGreaterThan(0.5);
  });

  it("keeps trusting mediaTime once it has advanced, even through stalls", () => {
    const { video, fire } = makeRvfcVideo();
    const ts: number[] = [];
    startFrameLoop(video, (t) => ts.push(t));

    fire(0, 0);
    fire(33, 1 / 30); // mediaTime proves itself here
    // A long run of repeated mediaTime (e.g. a paused clip) must not trigger
    // the fallback clock afterwards.
    for (let i = 0; i < MEDIA_TIME_STALL_FRAMES * 2; i++) {
      fire(66 + i * 33, 1 / 30);
    }
    expect(ts.every((t) => t === 0 || t === 1 / 30)).toBe(true);
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
