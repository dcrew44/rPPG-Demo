/**
 * Entry point: wires camera → face tracking → POS → HR → confidence →
 * render, mirroring main.py.
 */

import "./style.css";
import { RingBuffer } from "./buffer";
import { CameraError, openCamera, startFrameLoop } from "./capture";
import { ConfidenceScorer, type ConfidenceResult } from "./confidence";
import { renderFrame, renderReadout } from "./display";
import { FaceTracker } from "./face";
import { HREstimator } from "./hr";
import { posEstimate } from "./pos";
import type { State } from "./state";

function getElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`Missing #${id}`);
  return el as T;
}

const video = getElement<HTMLVideoElement>("video");
const canvas = getElement<HTMLCanvasElement>("canvas");
const overlay = getElement<HTMLDivElement>("overlay");
const readout = {
  bpm: getElement<HTMLSpanElement>("bpm"),
  status: getElement<HTMLSpanElement>("status"),
};

function showOverlay(message: string): void {
  overlay.textContent = message;
  overlay.hidden = false;
}

async function run(): Promise<void> {
  readout.status.textContent = "Loading face model…";
  const tracker = await FaceTracker.create();

  readout.status.textContent = "Waiting for camera permission…";
  await openCamera(video);

  readout.status.textContent = "";
  const buffer = new RingBuffer(10);
  const hr = new HREstimator();
  const scorer = new ConfidenceScorer();
  let lastBpm: number | null = null;
  let lastConf: ConfidenceResult = {
    score: null,
    colorBand: "gray",
    components: {},
  };
  let lastTickT: number | null = null;

  startFrameLoop(video, (tSeconds, nowMs) => {
    const detection = tracker.detect(video, nowMs);
    let pulse: Float64Array = new Float64Array(0);

    if (detection !== null) {
      scorer.observeFrame(detection.center, detection.bbox);
      buffer.append(detection.meanRgb, tSeconds);
    } else {
      scorer.observeFrame(null, null);
    }

    const fps = buffer.fps();
    if (buffer.duration() >= 5 && fps > 0) {
      pulse = posEstimate(buffer.asArrays().rgb, fps);
      const analysis = hr.analyze(pulse, fps);
      if (analysis !== null) lastBpm = analysis.bpm;
      const dt = lastTickT === null ? 0.5 : tSeconds - lastTickT;
      lastConf = scorer.score(analysis, dt);
      lastTickT = tSeconds;
    }

    const state: State = {
      bbox: detection?.bbox ?? null,
      pulseSignal: pulse,
      bpm: lastBpm,
      hasFace: detection !== null,
      confidence: lastConf.score,
      confidenceColor: lastConf.colorBand,
    };
    renderFrame(canvas, video, state);
    renderReadout(readout, state);
  });
}

run().catch((err: unknown) => {
  const message =
    err instanceof CameraError
      ? err.message
      : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
  showOverlay(message);
  readout.status.textContent = "";
  readout.bpm.textContent = "—";
});
