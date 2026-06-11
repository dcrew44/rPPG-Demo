/**
 * Entry point: wires camera → Pipeline → render, mirroring main.py, plus the
 * web-only demo mode (?demo, or offered when the camera fails). The demo
 * plays a bundled looping clip through the real tracker + pipeline; if the
 * clip or the face model can't load, it falls back to a synthetic pulse
 * source (forceable with ?demo=synthetic).
 */

import "./style.css";
import { CameraError, openCamera, openClip, startFrameLoop } from "./capture";
import { DEMO_FPS, DEMO_HEIGHT, DEMO_WIDTH, DemoSignal } from "./demo";
import {
  renderFaceBox,
  renderReadout,
  renderRoi,
  renderSpectrum,
  renderWaveform,
  videoView,
  type ViewMetrics,
} from "./display";
import { FaceTracker } from "./face";
import { Pipeline } from "./pipeline";
import type { State } from "./state";

const DEMO_CLIP_URL = `${import.meta.env.BASE_URL}demo.mp4`;

function getElement<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`Missing #${id}`);
  return el as unknown as T;
}

const stage = getElement<HTMLDivElement>("stage");
const video = getElement<HTMLVideoElement>("video");
const roi = getElement<SVGSVGElement>("roi");
const facebox = getElement<HTMLDivElement>("facebox");
const demobadge = getElement<HTMLDivElement>("demobadge");
const overlay = getElement<HTMLDivElement>("overlay");
const readout = {
  bpm: getElement<HTMLSpanElement>("bpm"),
  status: getElement<HTMLSpanElement>("status"),
};
const spectrumEls = {
  trace: getElement<SVGPolylineElement>("spectrace"),
  peakline: getElement<SVGLineElement>("peakline"),
  label: getElement<HTMLSpanElement>("peaklabel"),
};
const wavetrace = getElement<SVGPolylineElement>("wavetrace");

function renderAll(view: ViewMetrics, state: State): void {
  renderFaceBox(facebox, view, state);
  renderRoi(roi, view, state);
  renderWaveform(wavetrace, state);
  renderSpectrum(spectrumEls, state);
  renderReadout(readout, state);
}

async function runCamera(): Promise<void> {
  readout.status.textContent = "Loading face model…";
  const tracker = await FaceTracker.create();

  readout.status.textContent = "Waiting for camera permission…";
  await openCamera(video);

  readout.status.textContent = "";
  const pipeline = new Pipeline(tracker);

  startFrameLoop(video, (tSeconds, nowMs) => {
    renderAll(videoView(video), pipeline.update(video, tSeconds, nowMs));
  });
}

/**
 * Demo on the bundled clip: the identical camera path (real tracker, real
 * ROI sampling), just fed by a looping video file. Throws before the frame
 * loop starts when the model or the clip can't load.
 */
async function runClipDemo(): Promise<void> {
  overlay.hidden = true;
  demobadge.textContent = "Demo mode — recorded clip";
  demobadge.hidden = false;

  readout.status.textContent = "Loading face model…";
  const tracker = await FaceTracker.create();

  readout.status.textContent = "Loading demo clip…";
  await openClip(video, DEMO_CLIP_URL);

  readout.status.textContent = "";
  const pipeline = new Pipeline(tracker);

  // The clip loops, so its media timestamps restart at 0 every ~30 s; keep
  // the pipeline's sample clock monotonic by accumulating an offset at each
  // wrap (plus one nominal frame so no two samples collide).
  let offset = 0;
  let lastMediaT = 0;
  startFrameLoop(video, (mediaT, nowMs) => {
    if (mediaT < lastMediaT) offset += lastMediaT - mediaT + 1 / 30;
    lastMediaT = mediaT;
    renderAll(videoView(video), pipeline.update(video, offset + mediaT, nowMs));
  });
}

/** Demo on the synthetic pulse source — no camera, no model, no clip. */
function runSyntheticDemo(): void {
  overlay.hidden = true;
  video.hidden = true;
  stage.classList.add("demo");
  demobadge.textContent = "Demo mode — synthetic pulse";
  demobadge.hidden = false;
  readout.status.textContent = "";
  readout.bpm.textContent = "searching…";

  const pipeline = new Pipeline(null);
  const source = new DemoSignal();
  const t0 = performance.now();
  let lastT = -Infinity;

  const tick = (now: DOMHighResTimeStamp): void => {
    const t = (now - t0) / 1000;
    if (t - lastT >= 1 / DEMO_FPS) {
      lastT = t;
      const state = pipeline.ingest(source.observation(t), t);
      renderAll(
        {
          srcWidth: DEMO_WIDTH,
          srcHeight: DEMO_HEIGHT,
          clientWidth: stage.clientWidth,
          clientHeight: stage.clientHeight,
        },
        state,
      );
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Clip demo first; synthetic when forced or when the clip path fails. */
async function runDemo(kind: string): Promise<void> {
  if (kind !== "synthetic") {
    try {
      await runClipDemo();
      return;
    } catch (err) {
      console.warn("Clip demo failed; falling back to synthetic:", err);
    }
  }
  runSyntheticDemo();
}

/** Show the failure and offer the camera-free demo instead. */
function showError(err: unknown): void {
  const message =
    err instanceof CameraError
      ? err.message
      : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;

  const p = document.createElement("p");
  p.textContent = message;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "demo-btn";
  btn.textContent = "Run the demo without a camera";
  btn.addEventListener("click", () => void runDemo(""));

  overlay.replaceChildren(p, btn);
  overlay.hidden = false;
  readout.status.textContent = "";
  readout.bpm.textContent = "—";
}

const demoParam = new URLSearchParams(location.search).get("demo");
if (demoParam !== null) {
  void runDemo(demoParam);
} else {
  runCamera().catch(showError);
}
