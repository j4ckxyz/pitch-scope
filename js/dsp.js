/* dsp.js: monophonic pitch tracking for vocal stems.
 *
 * YIN (de Cheveigne & Kawahara 2002) with a half-rate coarse search and a
 * full-rate parabolic refinement, which is what keeps a 4-minute stem under a
 * couple of seconds without giving up cent-level accuracy.
 *
 * Pure functions and no DOM, so it runs in a Worker and under Node for the tests.
 */

export const WORK_RATE = 22050; // vocal fundamentals top out well below Nyquist here

/* ---------- resampling ---------- */

// Linear interpolation is fine here: we low-pass first, and pitch tracking
// cares about periodicity, not about the last dB of anti-alias rejection.
export function resampleMono(channels, srcRate, dstRate) {
  const n = channels[0].length;
  const mono = new Float32Array(n);
  const chCount = channels.length;
  if (chCount === 1) {
    mono.set(channels[0]);
  } else {
    for (let c = 0; c < chCount; c++) {
      const ch = channels[c];
      for (let i = 0; i < n; i++) mono[i] += ch[i];
    }
    for (let i = 0; i < n; i++) mono[i] /= chCount;
  }
  if (srcRate === dstRate) return mono;

  const ratio = srcRate / dstRate;
  if (ratio > 1) lowpass(mono, srcRate, dstRate * 0.45);

  const outLen = Math.floor(n / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const p = i * ratio;
    const i0 = p | 0;
    const frac = p - i0;
    const a = mono[i0];
    const b = i0 + 1 < n ? mono[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// Two passes of a one-pole filter, forward then backward, so there is no phase
// shift and the rolloff is steep enough for 2-4x decimation.
function lowpass(buf, rate, cutoff) {
  const dt = 1 / rate;
  const rc = 1 / (2 * Math.PI * cutoff);
  const a = dt / (rc + dt);
  let y = buf[0];
  for (let i = 0; i < buf.length; i++) {
    y += a * (buf[i] - y);
    buf[i] = y;
  }
  y = buf[buf.length - 1];
  for (let i = buf.length - 1; i >= 0; i--) {
    y += a * (buf[i] - y);
    buf[i] = y;
  }
}

/* ---------- YIN ---------- */

/**
 * Difference function d(tau) over [minLag, maxLag], computed directly.
 * W is the integration window length; buf must hold W + maxLag samples.
 */
function differenceFunction(buf, offset, W, minLag, maxLag, out) {
  for (let tau = minLag; tau <= maxLag; tau++) {
    let sum = 0;
    const base = offset + tau;
    for (let j = 0; j < W; j++) {
      const diff = buf[offset + j] - buf[base + j];
      sum += diff * diff;
    }
    out[tau] = sum;
  }
}

/** In-place cumulative mean normalised difference (YIN step 3). */
function cmnd(d, maxLag) {
  d[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    running += d[tau];
    d[tau] = running === 0 ? 1 : (d[tau] * tau) / running;
  }
}

/** First dip below `threshold`, descended to its local minimum; else global min. */
function absoluteThreshold(d, minLag, maxLag, threshold) {
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (d[tau] < threshold) {
      while (tau + 1 <= maxLag && d[tau + 1] < d[tau]) tau++;
      return tau;
    }
  }
  let best = minLag;
  for (let tau = minLag + 1; tau <= maxLag; tau++) if (d[tau] < d[best]) best = tau;
  return best;
}

/** Parabolic interpolation around an integer lag, in lag units. */
function parabolicRefine(d, tau, maxLag) {
  if (tau <= 0 || tau >= maxLag) return tau;
  const a = d[tau - 1];
  const b = d[tau];
  const c = d[tau + 1];
  const denom = a - 2 * b + c;
  if (denom === 0) return tau;
  const shift = (0.5 * (a - c)) / denom;
  return Math.abs(shift) < 1 ? tau + shift : tau;
}

/* ---------- frame-level analysis ---------- */

export const DEFAULTS = {
  hopMs: 10,
  windowMs: 46, // ~2.5 periods at 55 Hz, short enough to follow fast runs
  fMin: 65, // C2
  fMax: 1100, // ~C#6
  threshold: 0.15,
  // Frames above this aperiodicity are unvoiced (consonants, breath, noise).
  // 0.35 rather than a looser 0.5: in the amplitude dip between two notes a
  // single frame reads as badly aperiodic *and* badly off-pitch, and it draws a
  // full-height spike on the plot. Tightening here costs well under 1% of
  // voiced frames and leaves the reported scores unchanged.
  maxAperiodicity: 0.35,
  // Silence gate, in dB below the track's loud-passage level.
  silenceDropDb: 34,
};

/**
 * Merge options over the defaults, ignoring keys explicitly set to undefined.
 * A plain spread would let a caller passing `{ maxAperiodicity: undefined }`
 * replace the default with undefined, and every comparison against it is then
 * false, which silently marks the whole track unvoiced.
 */
function withDefaults(opts) {
  const o = { ...DEFAULTS };
  for (const [k, v] of Object.entries(opts)) if (v !== undefined) o[k] = v;
  return o;
}

/**
 * Track pitch over a mono signal.
 * Returns parallel arrays; `f0[i]` is NaN wherever the frame is unvoiced.
 */
export function trackPitch(signal, rate, opts = {}) {
  const o = withDefaults(opts);
  const hop = Math.max(1, Math.round((o.hopMs / 1000) * rate));
  const W = Math.round((o.windowMs / 1000) * rate);
  const maxLag = Math.min(Math.ceil(rate / o.fMin), W - 1);
  const minLag = Math.max(2, Math.floor(rate / o.fMax));
  const frameLen = W + maxLag;

  const nFrames = Math.max(0, Math.floor((signal.length - frameLen) / hop) + 1);
  const time = new Float64Array(nFrames);
  const f0 = new Float64Array(nFrames);
  const aperiodicity = new Float64Array(nFrames);
  const rms = new Float64Array(nFrames);

  // Half-rate copy for the coarse pass.
  const half = decimate2(signal);
  const halfMaxLag = maxLag >> 1;
  const halfMinLag = Math.max(2, minLag >> 1);
  const halfW = W >> 1;

  const dCoarse = new Float64Array(halfMaxLag + 2);
  const dFine = new Float64Array(maxLag + 2);

  // Energy pass first, so the silence floor is known before any pitch work and
  // gaps cost nothing. On a real stem that's a large share of the track.
  for (let i = 0; i < nFrames; i++) {
    const start = i * hop;
    time[i] = (start + frameLen / 2) / rate;
    let energy = 0;
    for (let j = 0; j < frameLen; j++) {
      const s = signal[start + j];
      energy += s * s;
    }
    rms[i] = Math.sqrt(energy / frameLen);
  }
  const floor = silenceFloor(rms, o.silenceDropDb);

  const report = typeof o.onProgress === 'function' ? o.onProgress : null;
  const reportEvery = Math.max(1, nFrames >> 6);

  for (let i = 0; i < nFrames; i++) {
    const start = i * hop;
    if (report && i % reportEvery === 0) report(i / nFrames);

    if (rms[i] < floor || rms[i] < 1e-5) {
      f0[i] = NaN;
      aperiodicity[i] = 1;
      continue;
    }

    // Coarse: find the periodicity dip at half rate.
    const halfStart = start >> 1;
    if (halfStart + halfW + halfMaxLag >= half.length) {
      f0[i] = NaN;
      aperiodicity[i] = 1;
      continue;
    }
    differenceFunction(half, halfStart, halfW, 0, halfMaxLag, dCoarse);
    cmnd(dCoarse, halfMaxLag);
    const coarseTau = absoluteThreshold(dCoarse, halfMinLag, halfMaxLag, o.threshold);

    // Fine: re-evaluate a narrow band at full rate. The +/-3 window covers the
    // half-rate quantisation plus slack for the dip being off-centre; one extra
    // lag on each side gives parabolic interpolation its neighbours.
    const lo = Math.max(minLag, coarseTau * 2 - 3);
    const hi = Math.min(maxLag, coarseTau * 2 + 3);
    differenceFunction(signal, start, W, Math.max(1, lo - 1), Math.min(maxLag, hi + 1), dFine);
    // The raw d(tau) dips in the same place as the normalised one, so the band
    // search skips CMND; aperiodicity still comes from the coarse d'(tau).
    let bestTau = lo;
    for (let tau = lo; tau <= hi; tau++) if (dFine[tau] < dFine[bestTau]) bestTau = tau;

    const refined = bestTau > lo - 1 && bestTau < Math.min(maxLag, hi + 1)
      ? parabolicRefine(dFine, bestTau, maxLag)
      : bestTau;
    const period = refined > 0 ? refined : bestTau;
    const ap = dCoarse[coarseTau];

    aperiodicity[i] = ap;
    const hz = rate / period;
    f0[i] = ap <= o.maxAperiodicity && hz >= o.fMin && hz <= o.fMax ? hz : NaN;
  }

  return { time, f0, aperiodicity, rms, hopMs: (hop / rate) * 1000, silenceFloor: floor };
}

function decimate2(x) {
  const out = new Float32Array(x.length >> 1);
  // Short FIR so the coarse pass isn't chasing aliased periodicity.
  for (let i = 0; i < out.length; i++) {
    const j = i * 2;
    const a = x[j - 1] ?? 0;
    const b = x[j];
    const c = x[j + 1] ?? 0;
    out[i] = 0.25 * a + 0.5 * b + 0.25 * c;
  }
  return out;
}

/**
 * Gate against a loud-passage reference (95th percentile RMS) rather than the
 * peak, so one clipped breath doesn't raise the floor over the whole track.
 */
function silenceFloor(rms, dropDb) {
  if (!rms.length) return 0;
  const sorted = Float64Array.from(rms).sort();
  const ref = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];
  return ref * Math.pow(10, -dropDb / 20);
}

/* ---------- post-processing ---------- */

/**
 * Remove octave jumps and single-frame outliers. Octave errors are the classic
 * YIN failure on breathy vocals and they wreck the tuning statistics.
 */
export function cleanContour(f0, {
  medianWidth = 5,
  minRunFrames = 4,
  spikeSemitones = 3,
  maxSpikeFrames = 3,
} = {}) {
  const out = Float64Array.from(f0);
  const n = out.length;

  // Snap frames that sit a near-exact octave off their neighbourhood median.
  const med = medianFilter(out, medianWidth);
  for (let i = 0; i < n; i++) {
    if (!isFinite(out[i]) || !isFinite(med[i])) continue;
    const ratio = out[i] / med[i];
    for (const mult of [0.5, 2, 1 / 3, 3]) {
      if (Math.abs(ratio - mult) < 0.06 * mult) {
        out[i] = out[i] / mult;
        break;
      }
    }
  }

  // Drop brief excursions far from the local median. These are detector
  // transients at note attacks, and a single stray frame draws a full-height
  // spike across the plot. A real interval leap lasts longer than a few frames,
  // so bounding the run length keeps genuine octave jumps intact.
  const med2 = medianFilter(out, 7);
  let spikeStart = -1;
  for (let i = 0; i <= n; i++) {
    const far = i < n && isFinite(out[i]) && isFinite(med2[i])
      && Math.abs(12 * Math.log2(out[i] / med2[i])) > spikeSemitones;
    if (far && spikeStart < 0) spikeStart = i;
    if (!far && spikeStart >= 0) {
      if (i - spikeStart <= maxSpikeFrames) for (let j = spikeStart; j < i; j++) out[j] = NaN;
      spikeStart = -1;
    }
  }

  // Drop voiced runs too short to be a sung note.
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const voiced = i < n && isFinite(out[i]);
    if (voiced && runStart < 0) runStart = i;
    if (!voiced && runStart >= 0) {
      if (i - runStart < minRunFrames) for (let j = runStart; j < i; j++) out[j] = NaN;
      runStart = -1;
    }
  }
  return out;
}

function medianFilter(x, width) {
  const n = x.length;
  const half = width >> 1;
  const out = new Float64Array(n);
  const win = [];
  for (let i = 0; i < n; i++) {
    win.length = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < n && isFinite(x[j])) win.push(x[j]);
    }
    if (!win.length) {
      out[i] = NaN;
      continue;
    }
    win.sort((a, b) => a - b);
    out[i] = win[win.length >> 1];
  }
  return out;
}
