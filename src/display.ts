/**
 * Renderer: positions the confidence-colored face box and ROI outlines over
 * the live video and updates the BPM readout, pulse-waveform panel and
 * spectrum panel from a State snapshot.
 *
 * Ports rppg/display.py — the single cv2 window becomes the <video> element
 * (which previews itself) plus plain DOM/SVG overlays. Deliberately
 * canvas-free: compositing camera frames (or anything else) through a
 * GPU-accelerated 2D canvas can come up black/empty on some hardware-decode
 * setups; all plots are SVG. The video is mirrored (selfie view) purely in
 * CSS — the face-box div's x is flipped here and the ROI <svg> carries the
 * same CSS scaleX(-1) as the video — while all upstream processing sees the
 * unmirrored frame.
 *
 * Deviations from display.py: the border is a continuous red -> yellow ->
 * green ramp over the smoothed confidence (anchored at the band thresholds,
 * gray when there is no estimate) rather than the discrete band color, and
 * the waveform/spectrum/ROI views have no Python equivalent. The plot
 * geometry builders (waveformPoints, spectrumPoints, hzToX) are pure and
 * DOM-free for the tests.
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

/**
 * Where the State's pixel coordinates come from and how large they appear
 * on screen. The camera path derives this from the <video> element; demo
 * mode supplies its virtual frame size and the stage's client size.
 */
export interface ViewMetrics {
  readonly srcWidth: number;
  readonly srcHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
}

/** ViewMetrics of a playing <video> element. */
export function videoView(video: HTMLVideoElement): ViewMetrics {
  return {
    srcWidth: video.videoWidth,
    srcHeight: video.videoHeight,
    clientWidth: video.clientWidth,
    clientHeight: video.clientHeight,
  };
}

export interface Readout {
  readonly bpm: HTMLElement;
  readonly status: HTMLElement;
}

/**
 * Position and color the face-box div, scaling the bbox from source pixels
 * to the displayed size. Hidden when there is no face.
 */
export function renderFaceBox(
  facebox: HTMLElement,
  view: ViewMetrics,
  state: State,
): void {
  if (state.bbox === null || view.srcWidth === 0) {
    facebox.hidden = true;
    return;
  }

  const scaleX = view.clientWidth / view.srcWidth;
  const scaleY = view.clientHeight / view.srcHeight;
  const [x, y, w, h] = state.bbox;

  // The video is CSS-mirrored, so flip the box's x to match.
  facebox.style.left = `${(view.srcWidth - x - w) * scaleX}px`;
  facebox.style.top = `${y * scaleY}px`;
  facebox.style.width = `${w * scaleX}px`;
  facebox.style.height = `${h * scaleY}px`;
  facebox.style.borderColor = confidenceColor(state.confidence);
  facebox.hidden = false;
}

/**
 * Draw the skin-ROI outlines as <polygon>s in an SVG overlay whose viewBox
 * is the source pixel space (the SVG itself is CSS-mirrored like the video,
 * so the raw coordinates land in the right place). Polygon elements are
 * created once and reused frame to frame.
 */
export function renderRoi(
  svg: SVGSVGElement,
  view: ViewMetrics,
  state: State,
): void {
  if (state.roiPolygons.length === 0 || view.srcWidth === 0) {
    svg.style.visibility = "hidden";
    return;
  }

  svg.setAttribute("viewBox", `0 0 ${view.srcWidth} ${view.srcHeight}`);

  while (svg.children.length < state.roiPolygons.length) {
    svg.appendChild(
      document.createElementNS("http://www.w3.org/2000/svg", "polygon"),
    );
  }
  for (let i = 0; i < svg.children.length; i++) {
    const poly = svg.children[i] as SVGPolygonElement;
    const hull = state.roiPolygons[i];
    if (hull === undefined) {
      poly.setAttribute("points", "");
      continue;
    }
    poly.setAttribute(
      "points",
      hull.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "),
    );
  }
  svg.style.visibility = "visible";
}

// Plot geometry. Plot SVGs use a fixed abstract viewBox and stretch to the
// panel (preserveAspectRatio="none"), so all builders work in these units.
export const PLOT_W = 100;
export const PLOT_H = 40;

/**
 * Polyline points for the pulse trace: x spans the window, y is the signal
 * centered on its mean and scaled by 2 standard deviations (clamped), so a
 * clean quasi-sinusoidal pulse fills most of the height while transient
 * spikes clip instead of flattening the rest of the trace. Empty string
 * when there are fewer than two samples.
 */
export function waveformPoints(
  signal: ArrayLike<number>,
  width: number = PLOT_W,
  height: number = PLOT_H,
): string {
  const n = signal.length;
  if (n < 2) return "";

  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i];
  mean /= n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (signal[i] - mean) ** 2;
  const std = Math.sqrt(varSum / n);

  const mid = height / 2;
  const amp = height * 0.45;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const z = std > 0 ? (signal[i] - mean) / (2 * std) : 0;
    const x = (i / (n - 1)) * width;
    const y = mid - Math.max(-1, Math.min(1, z)) * amp;
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(" ");
}

/** Frequency range shown by the spectrum panel (covers the SNR band). */
export const SPECTRUM_VIEW_HZ: readonly [number, number] = [0.5, 4.0];

/** Map a frequency to a plot x coordinate within [lo, hi]. */
export function hzToX(
  f: number,
  lo: number = SPECTRUM_VIEW_HZ[0],
  hi: number = SPECTRUM_VIEW_HZ[1],
  width: number = PLOT_W,
): number {
  return ((f - lo) / (hi - lo)) * width;
}

/**
 * Polyline points for the PSD over [lo, hi] Hz, normalized so the tallest
 * in-range bin touches the top margin. Empty string when no bin in range
 * has power.
 */
export function spectrumPoints(
  freqs: ArrayLike<number>,
  psd: ArrayLike<number>,
  lo: number = SPECTRUM_VIEW_HZ[0],
  hi: number = SPECTRUM_VIEW_HZ[1],
  width: number = PLOT_W,
  height: number = PLOT_H,
): string {
  let max = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= lo && freqs[i] <= hi && psd[i] > max) max = psd[i];
  }
  if (max <= 0) return "";

  const pts: string[] = [];
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    if (f < lo || f > hi) continue;
    const x = hzToX(f, lo, hi, width);
    const y = (1 - psd[i] / max) * (height - 4) + 2;
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(" ");
}

/** Update the pulse-waveform trace, colored by the confidence score. */
export function renderWaveform(trace: SVGPolylineElement, state: State): void {
  trace.setAttribute("points", waveformPoints(state.pulseSignal));
  trace.style.stroke = confidenceColor(state.confidence);
}

export interface SpectrumElements {
  readonly trace: SVGPolylineElement;
  readonly peakline: SVGLineElement;
  readonly label: HTMLElement;
}

/** Update the spectrum trace, the picked-peak marker and its BPM label. */
export function renderSpectrum(els: SpectrumElements, state: State): void {
  if (state.spectrum === null) {
    els.trace.setAttribute("points", "");
    els.peakline.style.visibility = "hidden";
    els.label.textContent = "waiting for signal…";
    return;
  }

  const { freqs, psd, fPeak, bpm } = state.spectrum;
  els.trace.setAttribute("points", spectrumPoints(freqs, psd));

  const x = hzToX(fPeak).toFixed(2);
  els.peakline.setAttribute("x1", x);
  els.peakline.setAttribute("x2", x);
  els.peakline.style.visibility = "visible";
  els.label.textContent = `peak ${fPeak.toFixed(2)} Hz → ${Math.round(bpm)} BPM`;
}

/** Update the BPM number and the status line beneath the video. */
export function renderReadout(readout: Readout, state: State): void {
  readout.bpm.textContent =
    state.bpm === null ? "searching…" : `${Math.round(state.bpm)} BPM`;
  readout.status.textContent = state.hasFace ? "" : "No face";
}
