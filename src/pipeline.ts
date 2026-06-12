/**
 * Orchestration tying face ROI, buffering, POS and HR into a State snapshot.
 *
 * Ports the "rgb_trace" path of rppg/pipeline.py (POS only — EfficientPhys
 * is out of scope for the web demo). Each update() extracts the skin-ROI
 * mean RGB for the current frame, appends it to the sliding buffer, runs POS
 * over the buffered window once warmed up (min 5 s), and re-estimates the
 * heart rate and confidence on a throttled tick (~0.5 s).
 *
 * Web-only additions over the Python: the displayed BPM is median-smoothed
 * (BpmSmoother) while the spectrum stays raw, a (t, bpm) trend history feeds
 * the trend panel, and a sample-clock gap larger than GAP_RESET_S (capture
 * stalled — hidden tab, camera switch, long face loss) clears the buffer and
 * all running estimator state, so the window never spans a discontinuity.
 */

import { RingBuffer } from "./buffer";
import {
  ConfidenceScorer,
  type ConfidenceResult,
  type Spectrum,
} from "./confidence";
import type { FaceObservation, FaceTracker } from "./face";
import { BpmSmoother, HREstimator, type HRAnalysis } from "./hr";
import { posEstimate } from "./pos";
import type { State } from "./state";

/** Sample-clock gap (s) beyond which the buffered window is considered
 * discontinuous and the pipeline re-warms from scratch. */
export const GAP_RESET_S = 1.5;

/** How much (t, bpm) trend history is retained, in seconds. */
export const TREND_WINDOW_S = 120;

export class Pipeline {
  private readonly buffer: RingBuffer;
  private readonly hr = new HREstimator();
  private readonly scorer = new ConfidenceScorer();
  private readonly smoother = new BpmSmoother();
  private readonly minSeconds: number;
  private readonly hrUpdateInterval: number;
  private lastSampleT: number | null = null;
  private lastHrT: number | null = null;
  private lastBpm: number | null = null;
  private lastAnalysis: HRAnalysis | null = null;
  private lastPulse: Float64Array = new Float64Array(0);
  private readonly bpmTrend: (readonly [number, number])[] = [];
  private lastConf: ConfidenceResult = {
    score: null,
    colorBand: "gray",
    components: {},
  };

  constructor(
    private readonly faceTracker: FaceTracker | null,
    {
      windowSeconds = 10,
      minSeconds = 5,
      hrUpdateInterval = 0.5,
    }: {
      windowSeconds?: number;
      minSeconds?: number;
      hrUpdateInterval?: number;
    } = {},
  ) {
    this.buffer = new RingBuffer(windowSeconds);
    this.minSeconds = minSeconds;
    this.hrUpdateInterval = hrUpdateInterval;
  }

  /**
   * Process one frame and return the current display state. `t` is the
   * frame's media timestamp in seconds (the sample clock); `nowMs` is the
   * monotonic milliseconds timestamp MediaPipe's VIDEO mode requires.
   */
  update(video: HTMLVideoElement, t: number, nowMs: number): State {
    return this.ingest(this.faceTracker?.detect(video, nowMs) ?? null, t);
  }

  /**
   * Process one face observation (or a no-face frame) at sample time `t`.
   * The camera-free core of update(): demo mode and tests feed synthetic
   * observations through here, so the math path is identical.
   */
  ingest(detection: FaceObservation | null, t: number): State {
    if (detection !== null) {
      // A long hole in the sample clock (hidden tab, camera switch, face
      // lost for a while) would leave the window discontinuous; re-warm.
      if (this.lastSampleT !== null && t - this.lastSampleT > GAP_RESET_S) {
        this.resetAfterGap();
      }
      this.lastSampleT = t;
      this.scorer.observeFrame(detection.center, detection.bbox);
      this.buffer.append(detection.meanRgb, t);
    } else {
      this.scorer.observeFrame(null, null);
    }

    this.updateRgb(t);

    const duration = this.buffer.duration();
    return {
      bbox: detection?.bbox ?? null,
      pulseSignal: this.lastPulse,
      bpm: this.lastBpm,
      hasFace: detection !== null,
      confidence: this.lastConf.score,
      confidenceColor: this.lastConf.colorBand,
      confidenceComponents: this.lastConf.components,
      warmupProgress:
        duration < this.minSeconds
          ? Math.min(duration / this.minSeconds, 1)
          : null,
      bpmTrend: this.bpmTrend,
      roiPolygons: detection?.roiPolygons ?? [],
      spectrum: this.lastAnalysis,
    };
  }

  /** Run POS each frame once warmed up; throttle HR re-estimation. */
  private updateRgb(t: number): void {
    if (this.buffer.duration() < this.minSeconds) return;
    const fps = this.buffer.fps();
    if (fps <= 0) return;
    this.lastPulse = posEstimate(this.buffer.asArrays().rgb, fps);
    if (this.lastHrT === null || t - this.lastHrT >= this.hrUpdateInterval) {
      this.scoreTick(this.lastPulse, fps, t);
    }
  }

  /** Re-estimate BPM, score confidence, and stamp the tick time. */
  private scoreTick(pulse: Float64Array, fps: number, t: number): void {
    const analysis = this.hr.analyze(pulse, fps);
    let spectrum: Spectrum | null = null;
    if (analysis !== null) {
      // The spectrum stays raw; only the displayed BPM is median-smoothed.
      this.lastBpm = this.smoother.push(analysis.bpm);
      this.lastAnalysis = analysis;
      spectrum = analysis;
      this.bpmTrend.push([t, this.lastBpm]);
      while (
        this.bpmTrend.length > 0 &&
        this.bpmTrend[0][0] < t - TREND_WINDOW_S
      ) {
        this.bpmTrend.shift();
      }
    }
    // First tick has no prior timestamp: seed dt with the nominal update
    // interval (a moderate EMA alpha; avoids a cold-start jump at dt->0).
    const dt = this.lastHrT === null ? this.hrUpdateInterval : t - this.lastHrT;
    this.lastConf = this.scorer.score(spectrum, dt);
    this.lastHrT = t;
  }

  /**
   * Forget everything derived from the (now stale) sample window. The last
   * BPM is kept so the readout can hold it, visibly gated, while re-warming;
   * the trend history survives (the gap shows as a jump in the panel).
   */
  private resetAfterGap(): void {
    this.buffer.clear();
    this.smoother.reset();
    this.scorer.reset();
    this.lastHrT = null;
    this.lastPulse = new Float64Array(0);
    this.lastAnalysis = null;
    this.lastConf = { score: null, colorBand: "gray", components: {} };
  }

  close(): void {
    this.faceTracker?.close();
  }
}
