/**
 * Fixed-duration sliding-window ring buffer of per-frame mean RGB samples.
 *
 * Ports rppg/buffer.py: stores (timestamp, rgb) pairs, retains only samples
 * whose timestamps fall within the most recent windowSeconds relative to the
 * newest appended sample, and estimates the sampling rate from the median
 * inter-sample interval.
 */

export type RgbSample = readonly [number, number, number];

export class RingBuffer {
  private readonly windowSeconds: number;
  private readonly times: number[] = [];
  private readonly samples: RgbSample[] = [];

  constructor(windowSeconds: number) {
    this.windowSeconds = windowSeconds;
  }

  /**
   * Append one RGB sample and evict samples strictly older than
   * `t - windowSeconds`. Timestamps are expected to be non-decreasing.
   */
  append(rgb: ArrayLike<number>, t: number): void {
    this.times.push(t);
    this.samples.push([rgb[0], rgb[1], rgb[2]]);

    const cutoff = t - this.windowSeconds;
    let drop = 0;
    while (drop < this.times.length && this.times[drop] < cutoff) drop += 1;
    if (drop > 0) {
      this.times.splice(0, drop);
      this.samples.splice(0, drop);
    }
  }

  /** Retained samples in chronological (oldest-first) order. */
  asArrays(): { rgb: readonly RgbSample[]; t: Float64Array } {
    return { rgb: this.samples, t: Float64Array.from(this.times) };
  }

  /**
   * Sampling rate estimated as 1 / median(diff(t)); 0 with fewer than two
   * samples or a zero median interval.
   */
  fps(): number {
    if (this.times.length < 2) return 0;
    const diffs: number[] = [];
    for (let i = 1; i < this.times.length; i++) {
      diffs.push(this.times[i] - this.times[i - 1]);
    }
    diffs.sort((a, b) => a - b);
    const mid = diffs.length >> 1;
    const median =
      diffs.length % 2 === 1 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
    return median === 0 ? 0 : 1 / median;
  }

  /** Time span t[last] - t[first] in seconds; 0 with fewer than two samples. */
  duration(): number {
    if (this.times.length < 2) return 0;
    return this.times[this.times.length - 1] - this.times[0];
  }

  get length(): number {
    return this.times.length;
  }
}
