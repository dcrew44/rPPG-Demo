/**
 * Entry point: wires camera → Pipeline → render, mirroring main.py, plus the
 * web-only demo mode (?demo, or offered when the camera fails). The demo
 * plays a bundled looping clip through the real tracker + pipeline; if the
 * clip or the face model can't load, it falls back to a synthetic pulse
 * source (forceable with ?demo=synthetic).
 */

import "./style.css";
import {
  CameraError,
  listCameras,
  openCamera,
  openClip,
  startFrameLoop,
  stopStream,
} from "./capture";
import { DEMO_FPS, DEMO_HEIGHT, DEMO_WIDTH, DemoSignal } from "./demo";
import {
  ReadoutRenderer,
  renderFaceBox,
  renderRoi,
  renderSpectrum,
  renderTrend,
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
const bpmEl = getElement<HTMLSpanElement>("bpm");
const statusEl = getElement<HTMLSpanElement>("status");
const readout = new ReadoutRenderer({
  bpm: bpmEl,
  status: statusEl,
  beat: getElement<HTMLSpanElement>("beat"),
  warmup: getElement<HTMLDivElement>("warmup"),
  warmbar: getElement<HTMLDivElement>("warmbar"),
});
const spectrumEls = {
  trace: getElement<SVGPolylineElement>("spectrace"),
  peakline: getElement<SVGLineElement>("peakline"),
  label: getElement<HTMLSpanElement>("peaklabel"),
};
const trendEls = {
  trace: getElement<SVGPolylineElement>("trendtrace"),
  label: getElement<HTMLSpanElement>("trendlabel"),
};
const wavetrace = getElement<SVGPolylineElement>("wavetrace");
const camerarow = getElement<HTMLLabelElement>("camerarow");
const camerapick = getElement<HTMLSelectElement>("camerapick");

function renderAll(view: ViewMetrics, state: State): void {
  renderFaceBox(facebox, view, state);
  renderRoi(roi, view, state);
  renderWaveform(wavetrace, state);
  renderSpectrum(spectrumEls, state);
  renderTrend(trendEls, state);
  readout.render(state);
}

/**
 * Offer a camera <select> when more than one camera exists. Labels are only
 * available once permission is granted, so this runs after openCamera.
 */
async function setupCameraPicker(
  onSwitch: (deviceId: string) => void,
): Promise<void> {
  const cameras = await listCameras();
  if (cameras.length < 2) return;

  camerapick.replaceChildren(
    ...cameras.map((cam, i) => {
      const opt = document.createElement("option");
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${i + 1}`;
      return opt;
    }),
  );
  const current =
    video.srcObject instanceof MediaStream
      ? video.srcObject.getVideoTracks()[0]?.getSettings().deviceId
      : undefined;
  if (current !== undefined) camerapick.value = current;
  camerarow.hidden = false;
  camerapick.addEventListener("change", () => onSwitch(camerapick.value));
}

async function runCamera(): Promise<void> {
  statusEl.textContent = "Loading face model…";
  const tracker = await FaceTracker.create();

  statusEl.textContent = "Waiting for camera permission…";
  await openCamera(video);
  statusEl.textContent = "";

  // The pipeline is rebuilt per stream: a new camera restarts the media
  // timestamps (the sample clock), and its framing is a new subject anyway.
  const startLoop = (): (() => void) => {
    const pipeline = new Pipeline(tracker);
    return startFrameLoop(video, (tSeconds, nowMs) => {
      renderAll(videoView(video), pipeline.update(video, tSeconds, nowMs));
    });
  };
  let stopLoop = startLoop();

  await setupCameraPicker((deviceId) => {
    void (async () => {
      stopLoop();
      stopStream(video);
      statusEl.textContent = "Switching camera…";
      try {
        await openCamera(video, deviceId);
      } catch (err) {
        showError(err);
        return;
      }
      statusEl.textContent = "";
      stopLoop = startLoop();
    })();
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

  statusEl.textContent = "Loading face model…";
  const tracker = await FaceTracker.create();

  statusEl.textContent = "Loading demo clip…";
  await openClip(video, DEMO_CLIP_URL);

  statusEl.textContent = "";
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
  statusEl.textContent = "";
  bpmEl.textContent = "searching…";

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
  statusEl.textContent = "";
  bpmEl.textContent = "—";
}

const demoParam = new URLSearchParams(location.search).get("demo");
if (demoParam !== null) {
  void runDemo(demoParam);
} else {
  runCamera().catch(showError);
}
