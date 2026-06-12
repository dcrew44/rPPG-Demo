/**
 * Webcam capture: opens the user-facing camera and drives a per-frame loop.
 *
 * Ports rppg/capture.py. Where the Python wraps cv2.VideoCapture in a
 * generator yielding (frame, timestamp), the browser pushes frames at us:
 * startFrameLoop() invokes a callback once per delivered video frame,
 * carrying the frame's real media timestamp in seconds — frame rate is never
 * assumed. Uses video.requestVideoFrameCallback when available and falls back
 * to requestAnimationFrame (skipping repeats of the same frame). When the
 * media timestamps themselves are broken (iOS Safari camera streams can
 * report a mediaTime that never advances) the loop falls back to the
 * callback clock so downstream consumers always see time moving.
 */

/** Raised when the camera cannot be opened; message is user-presentable. */
export class CameraError extends Error {}

/**
 * Open a camera into the given (hidden) video element: a specific device
 * when `deviceId` is given (the camera picker), the user-facing default
 * otherwise.
 */
export async function openCamera(
  video: HTMLVideoElement,
  deviceId?: string,
): Promise<void> {
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
        ...(deviceId === undefined
          ? { facingMode: "user" }
          : { deviceId: { exact: deviceId } }),
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

/** Stop the video element's current camera stream (if any). */
export function stopStream(video: HTMLVideoElement): void {
  const stream = video.srcObject;
  if (stream instanceof MediaStream) {
    for (const track of stream.getTracks()) track.stop();
  }
  video.srcObject = null;
}

/**
 * The available video-input devices. Labels are only populated once camera
 * permission has been granted, so call this after openCamera resolves.
 */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
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

/** Frames delivered with no mediaTime progress before the sample clock gives
 * up on mediaTime and switches to the callback timestamp instead. */
export const MEDIA_TIME_STALL_FRAMES = 10;

/** Start a per-frame loop over the playing video. Returns a stop function. */
export function startFrameLoop(
  video: HTMLVideoElement,
  callback: FrameCallback,
): () => void {
  let stopped = false;

  // typeof check (not `in`) so older browsers without the API fall through
  // without TypeScript narrowing `video` to never in the else branch.
  if (typeof video.requestVideoFrameCallback === "function") {
    // iOS Safari can deliver camera frames whose metadata.mediaTime never
    // advances, which freezes the pipeline's sample clock: the buffer never
    // spans any duration and the warmup bar sits at "Calibrating 0%"
    // forever. Probe the first few frames: once mediaTime moves, trust it
    // for the life of the loop; if MEDIA_TIME_STALL_FRAMES frames arrive
    // without movement, switch permanently to the callback timestamp,
    // anchored at the frozen mediaTime so the sample clock stays continuous.
    let clock: "probing" | "media" | "fallback" = "probing";
    let firstMediaTime: number | null = null;
    let stalledFrames = 0;
    let fallbackBase = 0;

    const tick = (
      now: DOMHighResTimeStamp,
      metadata: VideoFrameCallbackMetadata,
    ): void => {
      if (stopped) return;
      if (clock === "probing") {
        firstMediaTime ??= metadata.mediaTime;
        if (metadata.mediaTime > firstMediaTime) {
          clock = "media";
        } else if (++stalledFrames >= MEDIA_TIME_STALL_FRAMES) {
          clock = "fallback";
          fallbackBase = metadata.mediaTime - now / 1000;
        }
      }
      const t =
        clock === "fallback" ? fallbackBase + now / 1000 : metadata.mediaTime;
      callback(t, now);
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
