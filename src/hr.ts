/**
 * Heart-rate estimation from a 1-D pulse (PPG) waveform.
 *
 * Reimplements rppg/hr.py without scipy: linear detrend → Hann window →
 * radix-2 FFT magnitude (zero-padded to the next power of two) → dominant
 * peak restricted to the heart-rate band → parabolic interpolation of the
 * peak → BPM. The Python's Butterworth band-pass + Welch PSD are replaced by
 * the band-restricted peak search over a single periodogram, which serves
 * the same purpose: out-of-band components (including the second harmonic of
 * any rate below 120 bpm) can never win the peak.
 *
 * The default 0.75–2.5 Hz (45–150 bpm) band is copied from the Python and is
 * deliberately narrow — a wider upper edge admits the second harmonic of any
 * heart rate below 120 bpm, reporting double the true rate.
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

/** Estimate heart rate (BPM) from a 1-D pulse waveform. */
export class HREstimator {
  constructor(
    private readonly lowHz: number = 0.75,
    private readonly highHz: number = 2.5,
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

    const fPeak = interpolatePeak(freqs, psd, peak);
    return { bpm: fPeak * 60, freqs, psd, fPeak };
  }

  /** Thin wrapper over analyze() returning only the BPM. */
  bpm(signal: ArrayLike<number>, fps: number): number | null {
    return this.analyze(signal, fps)?.bpm ?? null;
  }
}
