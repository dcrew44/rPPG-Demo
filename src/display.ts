/**
 * Renderer: draws the live (mirrored) video, the confidence-colored face box
 * and the BPM/status readout from a State snapshot.
 *
 * Ports rppg/display.py — the single cv2 window becomes one canvas plus two
 * DOM text nodes. The video is mirrored (selfie view) at draw time only; all
 * processing upstream sees the unmirrored frame.
 */

import type { ColorBand, State } from "./state";

const BAND_COLORS: Record<ColorBand, string> = {
  gray: "#9aa0a8",
  red: "#ef4444",
  yellow: "#eab308",
  green: "#22c55e",
};

export interface Readout {
  readonly bpm: HTMLElement;
  readonly status: HTMLElement;
}

/** Draw one frame: mirrored video plus the colored face box. */
export function renderFrame(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  state: State,
): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;

  if (
    video.videoWidth > 0 &&
    (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)
  ) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const { width, height } = canvas;

  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(video, -width, 0, width, height);
  ctx.restore();

  if (state.bbox !== null) {
    const [x, y, w, h] = state.bbox;
    ctx.strokeStyle = BAND_COLORS[state.confidenceColor];
    ctx.lineWidth = 3;
    // Mirror the box x to match the mirrored video.
    ctx.strokeRect(width - (x + w), y, w, h);
  }
}

/** Update the BPM number and the status line beneath the canvas. */
export function renderReadout(readout: Readout, state: State): void {
  readout.bpm.textContent =
    state.bpm === null ? "searching…" : `${Math.round(state.bpm)} BPM`;
  readout.status.textContent = state.hasFace ? "" : "No face";
}
