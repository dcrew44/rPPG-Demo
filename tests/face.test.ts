// Tests for the pure geometry/sampling helpers of src/face.ts (the camera-
// free part of rPPG-App tests/test_face.py).

import { describe, expect, it } from "vitest";

import {
  bboxFromPoints,
  centroidFromPoints,
  convexHull,
  meanRgbOfMasked,
  type Point,
} from "../src/face";

describe("bboxFromPoints", () => {
  it("returns the tight box around the points", () => {
    const pts: Point[] = [
      [10, 20],
      [30, 25],
      [15, 60],
    ];
    expect(bboxFromPoints(pts, 100, 100)).toEqual([10, 20, 20, 40]);
  });

  it("clamps to the frame bounds", () => {
    const pts: Point[] = [
      [-5, -10],
      [120, 90],
    ];
    expect(bboxFromPoints(pts, 100, 80)).toEqual([0, 0, 100, 80]);
  });

  it("returns a zero box for no points", () => {
    expect(bboxFromPoints([], 100, 100)).toEqual([0, 0, 0, 0]);
  });
});

describe("centroidFromPoints", () => {
  it("averages the coordinates", () => {
    const pts: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(centroidFromPoints(pts)).toEqual([5, 5]);
  });

  it("returns (0, 0) for no points", () => {
    expect(centroidFromPoints([])).toEqual([0, 0]);
  });
});

describe("convexHull", () => {
  it("drops interior points", () => {
    const pts: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5], // interior
    ];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(4);
    expect(hull).toEqual(
      expect.arrayContaining([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ]),
    );
  });

  it("passes through degenerate inputs", () => {
    expect(convexHull([[1, 2]])).toEqual([[1, 2]]);
    expect(
      convexHull([
        [3, 4],
        [1, 2],
      ]),
    ).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

describe("meanRgbOfMasked", () => {
  it("averages only fully opaque pixels", () => {
    // Three pixels: opaque red, opaque blue, transparent green (excluded).
    const data = Uint8ClampedArray.from([
      255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 0,
    ]);
    expect(meanRgbOfMasked(data)).toEqual([127.5, 0, 127.5]);
  });

  it("returns zeros when nothing is opaque", () => {
    const data = Uint8ClampedArray.from([10, 20, 30, 0]);
    expect(meanRgbOfMasked(data)).toEqual([0, 0, 0]);
  });
});
