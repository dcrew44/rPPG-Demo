/**
 * Webcam capture: opens the user-facing camera and drives a per-frame loop.
 *
 * Ports rppg/capture.py. Where the Python wraps cv2.VideoCapture in a
 * generator yielding (frame, timestamp), the browser pushes frames at us:
 * startFrameLoop() invokes a callback once per delivered video frame,
 * carrying the frame's real media timestamp in seconds — frame rate is never
 * assumed. Uses video.requestVideoFrameCallback when available and falls back
 * to requestAnimationFrame (skipping repeats of the same frame).
 */

/** Raised when the camera cannot be opened; message is user-presentable. */
export class CameraError extends Error {}

/** Open the user-facing camera into the given (hidden) video element. */
export async function openCamera(video: HTMLVideoElement): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError(
      "Camera access (getUserMedia) is not available in this browser. " +
        "Try a recent Chrome, Edge, Firefox or Safari over HTTPS.",
    );
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    });
  } catch (err) {
    if (
      err instanceof DOMException &&
      (err.name === "NotAllowedError" || err.name === "SecurityError")
    ) {
      throw new CameraError(
        "Camera permission was denied. Allow camera access for this site " +
          "and reload the page.",
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new CameraError(`Could not open the camera: ${reason}`);
  }
  video.srcObject = stream;
  await video.play();
}

/**
 * Play a looping media file in the given video element (the demo-clip
 * stand-in for openCamera). Rejects when the file can't be loaded/decoded.
 */
export async function openClip(
  video: HTMLVideoElement,
  url: string,
): Promise<void> {
  video.srcObject = null;
  video.src = url;
  video.loop = true;
  await video.play();
}

/**
 * Per-frame callback. `tSeconds` is the frame's media timestamp (the
 * pipeline's sample clock); `nowMs` is a monotonic wall-clock milliseconds
 * value (what MediaPipe's detectForVideo expects).
 */
export type FrameCallback = (tSeconds: number, nowMs: number) => void;

/** Start a per-frame loop over the playing video. Returns a stop function. */
export function startFrameLoop(
  video: HTMLVideoElement,
  callback: FrameCallback,
): () => void {
  let stopped = false;

  // typeof check (not `in`) so older browsers without the API fall through
  // without TypeScript narrowing `video` to never in the else branch.
  if (typeof video.requestVideoFrameCallback === "function") {
    const tick = (
      now: DOMHighResTimeStamp,
      metadata: VideoFrameCallbackMetadata,
    ): void => {
      if (stopped) return;
      callback(metadata.mediaTime, now);
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  } else {
    // rAF fires per display refresh, not per video frame; skip repeats so the
    // sample timestamps stay tied to actual new frames.
    let lastMediaTime = -1;
    const tick = (now: DOMHighResTimeStamp): void => {
      if (stopped) return;
      if (video.currentTime !== lastMediaTime) {
        lastMediaTime = video.currentTime;
        callback(video.currentTime, now);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  return () => {
    stopped = true;
  };
}
