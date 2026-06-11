/**
 * Renderer: positions the confidence-colored face box over the live video
 * and updates the BPM/status readout from a State snapshot.
 *
 * Ports rppg/display.py — the single cv2 window becomes the <video> element
 * (which previews itself) plus a plain DOM div for the box and two text
 * nodes. Deliberately canvas-free: compositing camera frames (or anything
 * else) through a GPU-accelerated 2D canvas can come up black/empty on some
 * hardware-decode setups. The video is mirrored (selfie view) purely in CSS,
 * so the box's x is flipped here to match; all processing upstream sees the
 * unmirrored frame.
 *
 * Deviation from display.py: the border is not the discrete band color but a
 * continuous red -> yellow -> green ramp over the smoothed confidence score,
 * anchored at the band thresholds (gray when there is no estimate).
 */

import { BAND_LO, BAND_HI } from "./confidence";
import type { State } from "./state";

const GRAY = "#9aa0a8";

type Rgb = readonly [number, number, number];
const RED: Rgb = [239, 68, 68]; // #ef4444
const YELLOW: Rgb = [234, 179, 8]; // #eab308
const GREEN: Rgb = [34, 197, 94]; // #22c55e

function lerpRgb(a: Rgb, b: Rgb, t: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/**
 * Map a confidence score to a CSS color: gray when null, otherwise a
 * piecewise-linear sRGB ramp red -> yellow -> green anchored at BAND_LO,
 * the band midpoint, and BAND_HI (pure red/green outside the band edges).
 */
export function confidenceColor(score: number | null): string {
  if (score === null) return GRAY;
  const mid = (BAND_LO + BAND_HI) / 2;
  if (score <= BAND_LO) return lerpRgb(RED, YELLOW, 0);
  if (score < mid)
    return lerpRgb(RED, YELLOW, (score - BAND_LO) / (mid - BAND_LO));
  if (score < BAND_HI)
    return lerpRgb(YELLOW, GREEN, (score - mid) / (BAND_HI - mid));
  return lerpRgb(YELLOW, GREEN, 1);
}

export interface Readout {
  readonly bpm: HTMLElement;
  readonly status: HTMLElement;
}

/**
 * Position and color the face-box div over the video, scaling the bbox from
 * video pixels to the video's displayed size. Hidden when there is no face.
 */
export function renderFaceBox(
  facebox: HTMLElement,
  video: HTMLVideoElement,
  state: State,
): void {
  if (state.bbox === null || video.videoWidth === 0) {
    facebox.hidden = true;
    return;
  }

  const scaleX = video.clientWidth / video.videoWidth;
  const scaleY = video.clientHeight / video.videoHeight;
  const [x, y, w, h] = state.bbox;

  // The video is CSS-mirrored, so flip the box's x to match.
  facebox.style.left = `${(video.videoWidth - x - w) * scaleX}px`;
  facebox.style.top = `${y * scaleY}px`;
  facebox.style.width = `${w * scaleX}px`;
  facebox.style.height = `${h * scaleY}px`;
  facebox.style.borderColor = confidenceColor(state.confidence);
  facebox.hidden = false;
}

/** Update the BPM number and the status line beneath the video. */
export function renderReadout(readout: Readout, state: State): void {
  readout.bpm.textContent =
    state.bpm === null ? "searching…" : `${Math.round(state.bpm)} BPM`;
  readout.status.textContent = state.hasFace ? "" : "No face";
}
