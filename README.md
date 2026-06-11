# rPPG Demo

Estimate heart rate from your webcam, entirely in the browser, using remote
photoplethysmography (rPPG). The live view shows the camera feed with the
sampled skin regions outlined, a face box colored along a continuous
red → yellow → green gradient by a confidence score (gray while warming up),
the estimated heart rate in BPM, a scrolling pulse-waveform panel, and a
frequency-spectrum panel with the detected heart-rate peak marked.

All processing happens locally in your browser — no video is recorded or
uploaded.

**Live demo:** https://dcrew44.github.io/rPPG-Demo/

No camera (or no permission)? [Demo mode](https://dcrew44.github.io/rPPG-Demo/?demo)
plays a short recorded clip through the identical tracker + pipeline — it is
also offered automatically when the camera can't be opened. If the clip or
the face model can't load, it falls back to a synthetic pulse source
(forceable with `?demo=synthetic`).

This is a TypeScript port of the [rPPG-App](https://github.com/dcrew44/rPPG-App)
Python implementation, which is the ground-truth reference for all algorithms,
constants and conventions. The Python version also includes **EfficientPhys**
(a neural rPPG method) and an offline evaluation suite; both are out of scope
here — this demo ports the classical **POS** path only.

## Run

```bash
npm install
npm run dev       # local dev server (camera needs localhost or HTTPS)
npm test          # vitest unit tests (all pure-math modules, no camera)
npm run build     # type-check + production build to dist/
npm run preview   # serve the production build locally
npm run lint      # eslint + prettier check
```

The MediaPipe face-landmark model (~3.8 MB) and its WASM runtime are fetched
from CDNs on page load; everything else is static.

## Architecture

One-way pipeline, mirroring the Python app (each module header comments which
Python module it ports):

```
camera → FaceTracker → RingBuffer (skin-ROI mean RGB) → POS → pulse
         (bbox, ROI,                                            ↓
          centroid)                       HREstimator (BPM) + ConfidenceScorer
                                                       ↓
                                          Pipeline → State → display (video + DOM box)
```

- `src/capture.ts` — webcam + per-frame loop with real media timestamps
  (`requestVideoFrameCallback`, rAF fallback).
- `src/face.ts` — MediaPipe Tasks `FaceLandmarker` (same model asset and
  landmark indices as the Python): face bbox, forehead+cheeks skin-ROI mean
  RGB via convex-hull masks, landmark centroid.
- `src/buffer.ts` — 10 s time-windowed ring buffer; fps from the median
  inter-sample interval.
- `src/pos.ts` — POS (Wang et al. 2017): overlap-add 1.6·fps windows, fixed
  2×3 projection, alpha tuning.
- `src/hr.ts` — heart-rate estimator: detrend → Hann → FFT → 0.75–2.5 Hz
  band peak → parabolic interpolation (scipy-free reimplementation).
- `src/confidence.ts` — SNR + motion composite score, EMA-smoothed, rendered
  as a continuous border gradient (recalibrated for the hr.ts periodogram).
- `src/pipeline.ts` — orchestration: 5 s warm-up, ~0.5 s HR tick. The
  camera-free `ingest()` entry point takes a face observation directly, so
  demo mode and the integration tests run the identical math path.
- `src/display.ts` / `src/main.ts` — video preview, ROI/face-box overlays
  (SVG/DOM, canvas-free) and the waveform/spectrum panels; wiring.
- `src/demo.ts` — the synthetic-pulse fallback for demo mode (PPG-like
  waveform on a skin-tone mean RGB, gentle motion, seeded noise); the primary
  demo path plays `public/demo.mp4` through the real tracker, accumulating a
  timestamp offset at each loop wrap to keep the sample clock monotonic.

## Deploy

Pushes to `main` build and deploy to GitHub Pages via
`.github/workflows/deploy.yml` (set the repository's Pages source to "GitHub
Actions"). The Vite `base` is `/rPPG-Demo/` to match the project-site URL.
