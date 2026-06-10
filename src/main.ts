/**
 * Entry point: wires camera → face tracking → render, mirroring main.py.
 */

import "./style.css";
import { RingBuffer } from "./buffer";
import { CameraError, openCamera, startFrameLoop } from "./capture";
import { renderFrame, renderReadout } from "./display";
import { FaceTracker } from "./face";
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
  startFrameLoop(video, (tSeconds, nowMs) => {
    const detection = tracker.detect(video, nowMs);
    if (detection !== null) buffer.append(detection.meanRgb, tSeconds);
    const state: State = {
      bbox: detection?.bbox ?? null,
      pulseSignal: new Float64Array(0),
      bpm: null,
      hasFace: detection !== null,
      confidence: null,
      confidenceColor: "gray",
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
