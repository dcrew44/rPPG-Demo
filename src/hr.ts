/**
 * Heart-rate estimation from a 1-D pulse (PPG) waveform.
 *
 * Reimplements rppg/hr.py without scipy: linear detrend → Hann window →
 * radix-2 FFT magnitude (zero-padded to the next power of two) → dominant
 * peak restricted to the heart-rate band → parabolic interpolation of the
 * peak → BPM. The Python's Butterworth band-pass + Welch PSD are replaced by
 * the band-restricted peak search over a single periodogram.
 *
 * Deviation from the Python's 0.75–2.5 Hz band: the band here is
 * 0.75–3.3 Hz (45–198 bpm) so elevated (e.g. post-exercise) rates are
 * readable. The Python kept the band narrow because a wider upper edge
 * admits the second harmonic of rates below 120 bpm; instead of capping the
 * band, analyze() checks each winning peak against its own subharmonic —
 * when the spectrum holds comparable power at half the peak frequency, the
 * peak is taken to be a second harmonic and the half-rate fundamental is
 * reported.
 *
 * analyze() returns the spectrum alongside the BPM, mirroring the Python, so
 * the confidence score can compute its SNR without a second FFT.
 */

/** Result of one spectral analysis of the pulse window. */
export interface HRAnalysis {
  /** Heart rate in beats per minute. */
  readonly bpm: number;
  /** Frequency bins of the full 0..fps/2 grid, in hertz. */
  readonly freqs: Float64Array;
  /** Power spectrum aligned with freqs (|FFT|^2 of the windowed signal). */
  readonly psd: Float64Array;
  /** Parabolic-interpolated peak frequency in hertz. */
  readonly fPeak: number;
}

/** Smallest power of two >= n. */
function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` must have the same
 * power-of-two length.
 */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let start = 0; start < n; start += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const i = start + k;
        const j = i + len / 2;
        const tRe = re[j] * curRe - im[j] * curIm;
        const tIm = re[j] * curIm + im[j] * curRe;
        re[j] = re[i] - tRe;
        im[j] = im[i] - tIm;
        re[i] += tRe;
        im[i] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Remove the least-squares straight line from the signal (linear detrend). */
function detrend(x: Float64Array): Float64Array {
  const n = x.length;
  if (n < 2) return Float64Array.from(x);

  // Closed-form simple linear regression of x against the sample index.
  const meanI = (n - 1) / 2;
  let meanX = 0;
  for (let i = 0; i < n; i++) meanX += x[i];
  meanX /= n;

  let cov = 0;
  let varI = 0;
  for (let i = 0; i < n; i++) {
    cov += (i - meanI) * (x[i] - meanX);
    varI += (i - meanI) * (i - meanI);
  }
  const slope = varI > 0 ? cov / varI : 0;
  const intercept = meanX - slope * meanI;

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i] - (intercept + slope * i);
  return out;
}

/**
 * Refine a spectral peak location via parabolic interpolation across the
 * neighbouring bins, mitigating the coarse FFT bin grid. Port of
 * _interpolate_peak from rppg/hr.py.
 */
export function interpolatePeak(
  freqs: Float64Array,
  psd: Float64Array,
  peak: number,
): number {
  if (peak <= 0 || peak >= freqs.length - 1) return freqs[peak];

  const yLeft = psd[peak - 1];
  const yMid = psd[peak];
  const yRight = psd[peak + 1];
  const denom = yLeft - 2 * yMid + yRight;
  if (denom === 0) return freqs[peak];

  // Sub-bin offset of the parabola vertex, in units of the bin spacing.
  const offset = (0.5 * (yLeft - yRight)) / denom;
  const binWidth = freqs[peak + 1] - freqs[peak];
  return freqs[peak] + offset * binWidth;
}

// Subharmonic (second-harmonic rejection) check: half-width of the lobe
// summed around the peak and its subharmonic (matches confidence.ts's
// SNR_DEV_HZ, the Hann main-lobe half-width of the 10 s window), and the
// minimum subharmonic/peak power ratio at which the half-rate wins. The 0.1
// floor sits well above the in-window noise share of any usable signal but
// below the fundamental of even a strongly harmonic-dominated pulse.
export const SUBHARMONIC_DEV_HZ = 0.2;
export const SUBHARMONIC_MIN_RATIO = 0.1;

/** Sum of psd over bins within ±dev of f0 (restricted to [lo, hi]). */
function lobePower(
  freqs: Float64Array,
  psd: Float64Array,
  f0: number,
  dev: number,
): number {
  let sum = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (Math.abs(freqs[i] - f0) <= dev) sum += psd[i];
  }
  return sum;
}

/**
 * Median-of-recent-estimates smoother for the displayed BPM. The raw
 * periodogram peak can flick between neighbouring spectral candidates from
 * one HR tick to the next; a short median rejects single-tick outliers while
 * following a persistent change within ~windowSize/2 ticks. Display-side
 * only — the spectrum/peak in State stay raw.
 */
export class BpmSmoother {
  private readonly recent: number[] = [];

  constructor(private readonly windowSize: number = 5) {}

  /** Add a raw estimate and return the median of the recent window. */
  push(bpm: number): number {
    this.recent.push(bpm);
    if (this.recent.length > this.windowSize) this.recent.shift();
    const sorted = [...this.recent].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /** Forget all history (new session or buffer reset). */
  reset(): void {
    this.recent.length = 0;
  }
}

/** Estimate heart rate (BPM) from a 1-D pulse waveform. */
export class HREstimator {
  constructor(
    private readonly lowHz: number = 0.75,
    private readonly highHz: number = 3.3,
  ) {}

  /**
   * Estimate BPM and return the spectrum it was derived from, or null when
   * the signal is too short (fewer than max(64, round(2 * fps)) samples, the
   * same guard as the Python) or no bin falls inside the band.
   */
  analyze(signal: ArrayLike<number>, fps: number): HRAnalysis | null {
    const n = signal.length;
    // Need at least ~2 s of data (and a sane absolute minimum) to resolve a
    // heart rate spectrally.
    if (fps <= 0 || n < Math.max(64, Math.round(2 * fps))) return null;

    const x = detrend(Float64Array.from(signal));

    const nfft = nextPow2(n);
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    for (let i = 0; i < n; i++) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
      re[i] = x[i] * hann;
    }
    fft(re, im);

    const bins = nfft / 2 + 1;
    const freqs = new Float64Array(bins);
    const psd = new Float64Array(bins);
    for (let k = 0; k < bins; k++) {
      freqs[k] = (k * fps) / nfft;
      psd[k] = re[k] * re[k] + im[k] * im[k];
    }

    let peak = -1;
    for (let k = 0; k < bins; k++) {
      if (freqs[k] < this.lowHz || freqs[k] > this.highHz) continue;
      if (peak === -1 || psd[k] > psd[peak]) peak = k;
    }
    if (peak === -1) return null;

    // Second-harmonic rejection: when the winning peak's subharmonic also
    // lies in band and carries comparable power, the peak is the second
    // harmonic of that lower rate — report the fundamental instead.
    const fHalf = freqs[peak] / 2;
    if (fHalf >= this.lowHz) {
      const peakPower = lobePower(freqs, psd, freqs[peak], SUBHARMONIC_DEV_HZ);
      const subPower = lobePower(freqs, psd, fHalf, SUBHARMONIC_DEV_HZ);
      if (subPower >= SUBHARMONIC_MIN_RATIO * peakPower) {
        let sub = -1;
        for (let k = 0; k < bins; k++) {
          if (Math.abs(freqs[k] - fHalf) > SUBHARMONIC_DEV_HZ) continue;
          if (sub === -1 || psd[k] > psd[sub]) sub = k;
        }
        if (sub !== -1) peak = sub;
      }
    }

    const fPeak = interpolatePeak(freqs, psd, peak);
    return { bpm: fPeak * 60, freqs, psd, fPeak };
  }

  /** Thin wrapper over analyze() returning only the BPM. */
  bpm(signal: ArrayLike<number>, fps: number): number | null {
    return this.analyze(signal, fps)?.bpm ?? null;
  }
}
