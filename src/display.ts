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
  facebox.style.borderColor = BAND_COLORS[state.confidenceColor];
  facebox.hidden = false;
}

/** Update the BPM number and the status line beneath the video. */
export function renderReadout(readout: Readout, state: State): void {
  readout.bpm.textContent =
    state.bpm === null ? "searching…" : `${Math.round(state.bpm)} BPM`;
  readout.status.textContent = state.hasFace ? "" : "No face";
}
