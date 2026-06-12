/**
 * Single-face detection and skin-ROI mean-RGB extraction via MediaPipe Tasks
 * FaceLandmarker.
 *
 * Ports rppg/face.py. Wraps the browser FaceLandmarker (same
 * face_landmarker.task asset and landmark index space as the Python
 * FaceTracker) to locate one face per frame and reduce it to the compact
 * quantities the pipeline consumes: the bounding box from the min/max
 * landmark extent, the mean (R, G, B) over a skin region of interest
 * (forehead plus both cheeks, the exact landmark groups of the Python), and
 * the landmark centroid (a motion-stable anchor for the confidence score,
 * since the bbox extent jitters frame to frame).
 *
 * The ROI mask is the union of the filled convex hulls of the landmark
 * groups, sampled on an offscreen canvas at reduced resolution. The geometry
 * helpers (bboxFromPoints, centroidFromPoints, convexHull, meanRgbOfMasked)
 * are pure and unit-testable without a camera, mirroring the Python
 * module-level helpers.
 */

import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// Both assets are served from public/ rather than fetched from CDNs, so the
// deployed demo is self-contained: the model is the same face_landmarker.task
// the Python app downloads (committed to the repo), and the WASM runtime is
// copied from the installed @mediapipe/tasks-vision package by
// scripts/copy-wasm.mjs before every dev/build, so the two can never
// version-skew.
const MODEL_URL = `${import.meta.env.BASE_URL}models/face_landmarker.task`;
const WASM_BASE = `${import.meta.env.BASE_URL}wasm`;

// Face Mesh landmark indices for the skin regions used to sample
// pulse-bearing colour, copied verbatim from rppg/face.py. The groups cover
// well-perfused, mostly hairless skin while avoiding the eyes, eyebrows and
// mouth, whose motion and pigment would corrupt the mean colour.
export const FOREHEAD_LANDMARKS: readonly number[] = [
  10, 67, 69, 104, 108, 151, 337, 299, 297, 338,
];
export const LEFT_CHEEK_LANDMARKS: readonly number[] = [
  205, 50, 101, 118, 117, 123, 147, 187,
];
export const RIGHT_CHEEK_LANDMARKS: readonly number[] = [
  425, 280, 330, 347, 346, 352, 376, 411,
];

export const ROI_LANDMARK_GROUPS: readonly (readonly number[])[] = [
  FOREHEAD_LANDMARKS,
  LEFT_CHEEK_LANDMARKS,
  RIGHT_CHEEK_LANDMARKS,
];

// The ROI is sampled on an offscreen canvas whose longest side is capped, so
// the per-frame getImageData + pixel scan stays cheap at any camera size.
const SAMPLE_MAX_SIDE = 256;

/** One (x, y) pixel coordinate. */
export type Point = readonly [number, number];

/** Per-frame face detection facts consumed by the pipeline. */
export interface FaceObservation {
  /** Face bounding box (x, y, w, h) in pixel coordinates. */
  readonly bbox: readonly [number, number, number, number];
  /** Mean (R, G, B) over the skin ROI, each channel in [0, 255]. */
  readonly meanRgb: readonly [number, number, number];
  /** Landmark centroid (cx, cy) in pixels — a motion-stable face anchor. */
  readonly center: readonly [number, number];
  /** Convex hull of each ROI landmark group, in pixel coordinates — the
   * exact regions the mean RGB is sampled from, for the display overlay. */
  readonly roiPolygons: readonly (readonly Point[])[];
}

/**
 * Tight axis-aligned bounding box around a set of pixel coordinates, clamped
 * to the frame, with non-negative width and height. Port of bbox_from_points.
 */
export function bboxFromPoints(
  points: readonly Point[],
  width: number,
  height: number,
): readonly [number, number, number, number] {
  if (points.length === 0) return [0, 0, 0, 0];

  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const [x, y] of points) {
    if (x < xMin) xMin = x;
    if (y < yMin) yMin = y;
    if (x > xMax) xMax = x;
    if (y > yMax) yMax = y;
  }

  // Clamp the corners into the frame before deriving width/height so the box
  // can never extend past the image bounds. trunc matches Python's int().
  const clamp = (v: number, hi: number): number =>
    Math.trunc(Math.min(Math.max(v, 0), hi));
  const x0 = clamp(xMin, width);
  const y0 = clamp(yMin, height);
  const x1 = clamp(xMax, width);
  const y1 = clamp(yMax, height);

  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

/**
 * Mean (x, y) of a set of pixel coordinates; (0, 0) when empty. Port of
 * centroid_from_points.
 */
export function centroidFromPoints(points: readonly Point[]): Point {
  if (points.length === 0) return [0, 0];
  let sx = 0;
  let sy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
  }
  return [sx / points.length, sy / points.length];
}

/**
 * Convex hull of a point set (Andrew's monotone chain), counter-clockwise,
 * without repeating the first point. The browser stand-in for cv2.convexHull;
 * filling the hull as a canvas path is the cv2.fillConvexPoly equivalent.
 */
export function convexHull(points: readonly Point[]): Point[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;

  const cross = (o: Point, a: Point, b: Point): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Point[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/**
 * Mean (R, G, B) over the fully opaque pixels of RGBA image data. The
 * counterpart of mean_rgb_in_mask: the ROI canvas keeps only masked pixels
 * opaque, so "alpha === 255" is the binary mask (partially transparent
 * anti-aliased hull edges are excluded, matching the Python's hard-edged
 * fillConvexPoly mask). Returns (0, 0, 0) when no pixel is selected.
 */
export function meanRgbOfMasked(
  data: Uint8ClampedArray,
): readonly [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 255) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count += 1;
    }
  }
  if (count === 0) return [0, 0, 0];
  return [r / count, g / count, b / count];
}

/**
 * Detect one face per video frame and extract its bounding box, skin-ROI
 * mean RGB and centroid. Browser counterpart of the Python FaceTracker
 * (VIDEO running mode, numFaces: 1).
 */
export class FaceTracker {
  private readonly sampleCanvas = document.createElement("canvas");
  private readonly sampleCtx: CanvasRenderingContext2D;

  private constructor(private readonly landmarker: FaceLandmarker) {
    const ctx = this.sampleCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (ctx === null) throw new Error("Could not create a 2D canvas context");
    this.sampleCtx = ctx;
  }

  static async create(): Promise<FaceTracker> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    const landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    return new FaceTracker(landmarker);
  }

  /**
   * Detect a face in the current video frame. `timestampMs` must be
   * monotonically increasing (MediaPipe VIDEO-mode requirement).
   */
  detect(video: HTMLVideoElement, timestampMs: number): FaceObservation | null {
    const result = this.landmarker.detectForVideo(video, timestampMs);
    if (result.faceLandmarks.length === 0) return null;

    const landmarks = result.faceLandmarks[0];
    const width = video.videoWidth;
    const height = video.videoHeight;

    // Box the whole face from the full landmark mesh, as the Python does; the
    // ROI groups below only drive the colour mask, not the displayed box.
    const facePoints: Point[] = landmarks.map((lm) => [
      lm.x * width,
      lm.y * height,
    ]);
    const bbox = bboxFromPoints(facePoints, width, height);
    const center = centroidFromPoints(facePoints);

    // Hull each ROI group once in full-resolution pixels; the mask sampler
    // below rescales these same hulls, so the overlay shows exactly the
    // sampled regions.
    const roiPolygons: Point[][] = [];
    for (const group of ROI_LANDMARK_GROUPS) {
      if (group.length < 3) continue;
      const hull = convexHull(
        group.map(
          (idx): Point => [landmarks[idx].x * width, landmarks[idx].y * height],
        ),
      );
      if (hull.length >= 3) roiPolygons.push(hull);
    }

    const meanRgb = this.roiMeanRgb(video, roiPolygons, width, height);

    return { bbox, meanRgb, center, roiPolygons };
  }

  /**
   * Mean RGB over the union of the filled convex hulls of the ROI landmark
   * groups, computed at reduced resolution. The _roi_mask + mean_rgb_in_mask
   * equivalent: the frame is drawn to an offscreen canvas, then
   * "destination-in" compositing erases everything outside the hull union, so
   * one getImageData pass yields exactly the masked pixels.
   */
  private roiMeanRgb(
    video: HTMLVideoElement,
    hulls: readonly (readonly Point[])[],
    width: number,
    height: number,
  ): readonly [number, number, number] {
    const scale = Math.min(1, SAMPLE_MAX_SIDE / Math.max(width, height));
    const sw = Math.max(1, Math.round(width * scale));
    const sh = Math.max(1, Math.round(height * scale));
    if (this.sampleCanvas.width !== sw || this.sampleCanvas.height !== sh) {
      this.sampleCanvas.width = sw;
      this.sampleCanvas.height = sh;
    }

    const ctx = this.sampleCtx;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, sw, sh);
    ctx.drawImage(video, 0, 0, sw, sh);

    // Rescale the full-resolution hulls onto the sample canvas (convexity is
    // preserved under the axis scaling).
    const sx = sw / width;
    const sy = sh / height;
    const mask = new Path2D();
    for (const hull of hulls) {
      mask.moveTo(hull[0][0] * sx, hull[0][1] * sy);
      for (let i = 1; i < hull.length; i++) {
        mask.lineTo(hull[i][0] * sx, hull[i][1] * sy);
      }
      mask.closePath();
    }

    ctx.globalCompositeOperation = "destination-in";
    ctx.fill(mask);
    ctx.globalCompositeOperation = "source-over";

    const data = ctx.getImageData(0, 0, sw, sh).data;
    return meanRgbOfMasked(data);
  }

  close(): void {
    this.landmarker.close();
  }
}
