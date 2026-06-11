// Pure color-ramp math from display.ts; no DOM.

import { describe, expect, it } from "vitest";

import { confidenceColor } from "../src/display";

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
