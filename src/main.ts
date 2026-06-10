/**
 * Entry point: wires camera → Pipeline → render, mirroring main.py.
 */

import "./style.css";
import { CameraError, openCamera, startFrameLoop } from "./capture";
import { renderFaceBox, renderReadout } from "./display";
import { FaceTracker } from "./face";
import { Pipeline } from "./pipeline";

function getElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`Missing #${id}`);
  return el as T;
}

const video = getElement<HTMLVideoElement>("video");
const facebox = getElement<HTMLDivElement>("facebox");
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
  const pipeline = new Pipeline(tracker);

  startFrameLoop(video, (tSeconds, nowMs) => {
    const state = pipeline.update(video, tSeconds, nowMs);
    renderFaceBox(facebox, video, state);
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
