/**
 * Demo mode: a synthetic pulse source that stands in for the camera and the
 * face tracker, so the full POS -> HR -> confidence pipeline (and every
 * panel of the UI) runs without camera permission. No Python equivalent —
 * this is web-demo-only.
 *
 * DemoSignal fabricates per-frame FaceObservations: a gently swaying face
 * box with sub-pixel jitter, fixed ROI outline shapes, and a skin-tone mean
 * RGB carrying a PPG-like pulse (fundamental + softer second harmonic,
 * strongest in green), slow illumination drift, and broadband noise. It is
 * deterministic (seeded PRNG) and clocked entirely by the caller's `t`, so
 * tests drive the real Pipeline with it sample by sample.
 */

import type { FaceObservation, Point } from "./face";

export const DEMO_WIDTH = 640;
export const DEMO_HEIGHT = 480;
export const DEMO_FPS = 30;

const FACE_W = 212;
const FACE_H = 268;

/** Deterministic uniform [0, 1) PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stylized forehead/cheek outlines, relative to the face center (px) —
// stand-ins for the convex hulls the real tracker extracts.
const ROI_TEMPLATES: readonly (readonly Point[])[] = [
  [
    [-58, -118],
    [0, -126],
    [58, -118],
    [52, -84],
    [0, -76],
    [-52, -84],
  ],
  [
    [-80, -16],
    [-40, -4],
    [-32, 38],
    [-60, 50],
    [-82, 20],
  ],
  [
    [80, -16],
    [40, -4],
    [32, 38],
    [60, 50],
    [82, 20],
  ],
];

export class DemoSignal {
  private phase = 0;
  private lastT: number | null = null;
  private readonly rand: () => number;

  constructor(seed = 7) {
    this.rand = mulberry32(seed);
  }

  /** Instantaneous heart rate in Hz: a slow drift around ~68 bpm. */
  private freqAt(t: number): number {
    return 1.13 + 0.07 * Math.sin((2 * Math.PI * t) / 53);
  }

  /**
   * The synthetic observation for sample time `t` (seconds, monotonically
   * increasing). The pulse phase is integrated across calls so the slow
   * heart-rate drift never causes phase jumps.
   */
  observation(t: number): FaceObservation {
    const dt = this.lastT === null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    this.phase += 2 * Math.PI * this.freqAt(t) * dt;

    // Gentle two-axis sway plus sub-pixel jitter — enough to look alive,
    // small enough to stay inside the motion deadband.
    const cx =
      DEMO_WIDTH / 2 +
      9 * Math.sin((2 * Math.PI * t) / 9.7) +
      (this.rand() - 0.5);
    const cy =
      DEMO_HEIGHT / 2 -
      14 +
      6 * Math.sin((2 * Math.PI * t) / 7.3) +
      (this.rand() - 0.5);

    // PPG-like waveform: fundamental plus a softer second harmonic.
    const s = Math.sin(this.phase) + 0.35 * Math.sin(2 * this.phase + 0.9);
    // Slow illumination drift (exercises the detrending) and per-channel
    // broadband noise; the pulse rides mostly on green, as in real skin.
    const drift =
      2.2 * Math.sin((2 * Math.PI * t) / 37) +
      1.2 * Math.sin((2 * Math.PI * t) / 11.5);
    const a = 0.8;
    const noise = (): number => (this.rand() - 0.5) * 0.4;
    const meanRgb: readonly [number, number, number] = [
      141 + 0.45 * a * s + drift + noise(),
      109 + a * s + drift + noise(),
      97 + 0.65 * a * s + drift + noise(),
    ];

    return {
      bbox: [cx - FACE_W / 2, cy - FACE_H / 2, FACE_W, FACE_H],
      meanRgb,
      center: [cx, cy],
      roiPolygons: ROI_TEMPLATES.map((poly) =>
        poly.map(([dx, dy]): Point => [cx + dx, cy + dy]),
      ),
    };
  }
}
