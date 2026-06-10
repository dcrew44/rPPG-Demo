# rPPG Demo

Estimate heart rate from your webcam, entirely in the browser, using remote
photoplethysmography (rPPG). A single live view shows the camera feed with a
face box colored red / yellow / green by a confidence score (gray while
warming up) and the estimated heart rate in BPM.

All processing happens locally in your browser — no video is recorded or
uploaded.

**Live demo:** _coming soon (GitHub Pages)_

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
                                          Pipeline → State → display (canvas)
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
- `src/confidence.ts` — SNR + motion composite score, EMA-smoothed, mapped
  to the color band with hysteresis.
- `src/pipeline.ts` — orchestration: 5 s warm-up, ~0.5 s HR tick.
- `src/display.ts` / `src/main.ts` — canvas renderer and wiring.

## Deploy

Pushes to `main` build and deploy to GitHub Pages via
`.github/workflows/deploy.yml` (set the repository's Pages source to "GitHub
Actions"). The Vite `base` is `/rPPG-Demo/` to match the project-site URL.
