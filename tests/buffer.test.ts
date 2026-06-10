// Port of rPPG-App tests/test_buffer.py.

import { describe, expect, it } from "vitest";

import { RingBuffer } from "../src/buffer";

describe("RingBuffer", () => {
  it("starts empty", () => {
    const buf = new RingBuffer(10);
    expect(buf.length).toBe(0);
    const { rgb, t } = buf.asArrays();
    expect(rgb).toHaveLength(0);
    expect(t).toHaveLength(0);
    expect(buf.fps()).toBe(0);
    expect(buf.duration()).toBe(0);
  });

  it("keeps all samples within the window", () => {
    const buf = new RingBuffer(10);
    for (let i = 0; i < 5; i++) buf.append([i, i + 1, i + 2], i);
    expect(buf.length).toBe(5);
    const { t } = buf.asArrays();
    expect([...t]).toEqual([0, 1, 2, 3, 4]);
  });

  it("evicts samples older than the window", () => {
    const buf = new RingBuffer(2);
    // Timestamps 0..5 with a 2 s window. After the last append at t=5 the
    // cutoff is 5 - 2 = 3; samples *older than* 3 (t in {0, 1, 2}) are
    // evicted, so t in {3, 4, 5} survive.
    for (let i = 0; i < 6; i++) buf.append([i, i, i], i);
    expect(buf.length).toBe(3);
    const { t } = buf.asArrays();
    expect([...t]).toEqual([3, 4, 5]);
  });

  it("keeps the boundary sample on eviction", () => {
    const buf = new RingBuffer(2);
    // Eviction is strictly-older-than the cutoff, so the boundary stays.
    buf.append([1, 1, 1], 0);
    buf.append([2, 2, 2], 1);
    buf.append([3, 3, 3], 2);
    // cutoff = 2 - 2 = 0; t=0 is not strictly older than 0, so it stays.
    expect(buf.length).toBe(3);
    expect([...buf.asArrays().t]).toEqual([0, 1, 2]);
  });

  it("removes samples strictly older than the cutoff", () => {
    const buf = new RingBuffer(2);
    buf.append([1, 1, 1], 0);
    buf.append([2, 2, 2], 2.5);
    // cutoff = 2.5 - 2 = 0.5; t=0 < 0.5, so it is evicted.
    expect(buf.length).toBe(1);
    expect([...buf.asArrays().t]).toEqual([2.5]);
  });

  it("returns samples and timestamps with matching values", () => {
    const buf = new RingBuffer(100);
    buf.append([10, 20, 30], 0);
    buf.append([11, 21, 31], 0.5);
    buf.append([12, 22, 32], 1);
    const { rgb, t } = buf.asArrays();
    expect(rgb).toEqual([
      [10, 20, 30],
      [11, 21, 31],
      [12, 22, 32],
    ]);
    expect([...t]).toEqual([0, 0.5, 1]);
  });

  it("keeps chronological order", () => {
    const buf = new RingBuffer(100);
    for (let i = 0; i < 4; i++) buf.append([i, 0, 0], i * 0.25);
    const { t } = buf.asArrays();
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
  });

  it("estimates ~30 fps from 30 fps timestamps", () => {
    const buf = new RingBuffer(100);
    const dt = 1 / 30;
    for (let i = 0; i < 50; i++) buf.append([0, 0, 0], i * dt);
    expect(buf.fps()).toBeCloseTo(30, 6);
  });

  it("reports fps 0 with fewer than two samples", () => {
    const buf = new RingBuffer(10);
    expect(buf.fps()).toBe(0);
    buf.append([0, 0, 0], 0);
    expect(buf.fps()).toBe(0);
  });

  it("reports fps 0 when the median interval is zero", () => {
    const buf = new RingBuffer(10);
    for (let i = 0; i < 4; i++) buf.append([0, 0, 0], 5);
    expect(buf.fps()).toBe(0);
  });

  it("reports the duration spanned by the samples", () => {
    const buf = new RingBuffer(100);
    buf.append([0, 0, 0], 2);
    buf.append([0, 0, 0], 3.5);
    buf.append([0, 0, 0], 7);
    expect(buf.duration()).toBeCloseTo(5);
  });

  it("reports duration 0 with fewer than two samples", () => {
    const buf = new RingBuffer(10);
    expect(buf.duration()).toBe(0);
    buf.append([0, 0, 0], 1);
    expect(buf.duration()).toBe(0);
  });

  it("accepts typed-array input", () => {
    const buf = new RingBuffer(10);
    buf.append(Float64Array.from([1, 2, 3]), 0);
    expect(buf.asArrays().rgb).toEqual([[1, 2, 3]]);
  });
});
