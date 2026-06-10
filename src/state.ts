/**
 * Per-frame display state passed from the pipeline to the renderer.
 *
 * Ports rppg/state.py — the frozen State dataclass becomes a plain readonly
 * interface.
 */

/** Axis-aligned box (x, y, w, h) in source-video pixel coordinates. */
export type BBox = readonly [number, number, number, number];

/** Confidence color band for the face box. */
export type ColorBand = "gray" | "red" | "yellow" | "green";

export interface State {
  /** Face bounding box, or null when no face was detected this frame. */
  readonly bbox: BBox | null;
  /** Latest pulse waveform over the buffered window (may be empty). */
  readonly pulseSignal: Float64Array;
  /** Most recent heart-rate estimate in BPM, or null before the first one. */
  readonly bpm: number | null;
  /** Whether a face was detected this frame. */
  readonly hasFace: boolean;
  /** EMA-smoothed confidence in [0, 1], or null while warming up. */
  readonly confidence: number | null;
  /** Color band derived from the confidence score. */
  readonly confidenceColor: ColorBand;
}
