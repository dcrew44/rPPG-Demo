/**
 * Single-face detection via MediaPipe Tasks FaceLandmarker.
 *
 * Ports rppg/face.py. Wraps the browser FaceLandmarker (same
 * face_landmarker.task asset and landmark index space as the Python
 * FaceTracker) to locate one face per frame and reduce it to the compact
 * quantities the pipeline consumes: the bounding box from the min/max
 * landmark extent and the landmark centroid (a motion-stable anchor for the
 * confidence score, since the bbox extent jitters frame to frame).
 *
 * The geometry helpers (bboxFromPoints, centroidFromPoints) are pure and
 * unit-testable without a camera, mirroring the Python module-level helpers.
 */

import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// Same model asset the Python app downloads to models/face_landmarker.task.
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/" +
  "face_landmarker/float16/1/face_landmarker.task";

// Pinned to the installed @mediapipe/tasks-vision version (see package.json).
const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";

/** One (x, y) pixel coordinate. */
export type Point = readonly [number, number];

/** Per-frame face detection facts consumed by the pipeline. */
export interface FaceObservation {
  /** Face bounding box (x, y, w, h) in pixel coordinates. */
  readonly bbox: readonly [number, number, number, number];
  /** Landmark centroid (cx, cy) in pixels — a motion-stable face anchor. */
  readonly center: readonly [number, number];
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
 * Detect one face per video frame and extract its bounding box and centroid.
 * Browser counterpart of the Python FaceTracker (VIDEO running mode,
 * numFaces: 1).
 */
export class FaceTracker {
  private constructor(private readonly landmarker: FaceLandmarker) {}

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

    // Box the whole face from the full landmark mesh, as the Python does.
    const facePoints: Point[] = landmarks.map((lm) => [
      lm.x * width,
      lm.y * height,
    ]);
    const bbox = bboxFromPoints(facePoints, width, height);
    const center = centroidFromPoints(facePoints);

    return { bbox, center };
  }

  close(): void {
    this.landmarker.close();
  }
}
