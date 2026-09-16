/* music.js: Hz <-> note conversions, tuning-reference estimation, note
 * segmentation, and the pitch-correction indicators. No DOM. */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** MIDI note number, fractional. 69 = A4. */
export function hzToMidi(hz, a4 = 440) {
  return 69 + 12 * Math.log2(hz / a4);
}

export function midiToHz(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function midiToName(midi, { flats = false } = {}) {
  const n = Math.round(midi);
  const names = flats ? NOTE_NAMES_FLAT : NOTE_NAMES;
  return names[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

/** True for the white keys: C D E F G A B. */
export function isNatural(midi) {
  return [0, 2, 4, 5, 7, 9, 11].includes(((Math.round(midi) % 12) + 12) % 12);
}

/**
 * Axis label padded so the columns line up in a monospace font: the letter, the
 * accidental (a space on naturals), then the octave. "A#4" sits directly above
 * "A 4", which is what makes a stack of them readable as a scale.
 */
export function midiToAxisLabel(midi) {
  const n = Math.round(midi);
  const name = NOTE_NAMES[((n % 12) + 12) % 12];
  const octave = Math.floor(n / 12) - 1;
  const letter = name[0];
  const accidental = name.length > 1 ? name[1] : ' ';
  return `${letter}${accidental}${octave}`;
}

/** Signed distance to the nearest semitone, in cents, in (-50, +50]. */
export function centsOffGrid(midi) {
  let d = (midi - Math.round(midi)) * 100;
  if (d <= -50) d += 100;
  if (d > 50) d -= 100;
  return d;
}

/* ---------- tuning reference ---------- */

/**
 * Estimate the track's tuning reference.
 *
 * Deviations live on a circle (mod 100 cents), so a plain mean is wrong: a take
 * centred on +49/-49 cents would average to 0. Circular mean handles the wrap.
 * Without this, a session recorded at A=442 reads as uniformly sharp and every
 * downstream statistic is garbage.
 */
export function estimateTuning(midiValues) {
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (const m of midiValues) {
    if (!isFinite(m)) continue;
    const theta = 2 * Math.PI * (m - Math.floor(m));
    sx += Math.cos(theta);
    sy += Math.sin(theta);
    count++;
  }
  if (!count) return { centsOffset: 0, a4: 440, concentration: 0 };

  const meanAngle = Math.atan2(sy / count, sx / count);
  let offset = (meanAngle / (2 * Math.PI)) * 100;
  if (offset > 50) offset -= 100;
  if (offset <= -50) offset += 100;

  const R = Math.hypot(sx / count, sy / count); // 0 = uniform, 1 = perfectly locked
  return { centsOffset: offset, a4: 440 * Math.pow(2, offset / 1200), concentration: R };
}

/** Circular standard deviation of cent deviations, in cents. */
export function circularSdCents(cents) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const c of cents) {
    if (!isFinite(c)) continue;
    const theta = (2 * Math.PI * c) / 100;
    sx += Math.cos(theta);
    sy += Math.sin(theta);
    n++;
  }
  if (n < 2) return NaN;
  const R = Math.hypot(sx / n, sy / n);
  if (R <= 1e-9) return 100 / Math.sqrt(12);
  return (100 / (2 * Math.PI)) * Math.sqrt(-2 * Math.log(R));
}

/* ---------- note segmentation ---------- */

/**
 * Group voiced frames into sung notes.
 *
 * Frames are quantised to the (tuning-corrected) semitone grid and runs of the
 * same semitone are merged. Runs shorter than `minMs` are dropped as passing
 * tones or detector noise rather than notes.
 */
export function segmentNotes(time, midi, { minMs = 70, gapMs = 40 } = {}) {
  const notes = [];
  const n = midi.length;
  const frameMs = n > 1 ? (time[1] - time[0]) * 1000 : 10;
  const maxGapFrames = Math.round(gapMs / frameMs);

  let i = 0;
  while (i < n) {
    if (!isFinite(midi[i])) {
      i++;
      continue;
    }
    const target = Math.round(midi[i]);
    let j = i;
    let gap = 0;
    let last = i;
    while (j < n) {
      if (isFinite(midi[j]) && Math.round(midi[j]) === target) {
        last = j;
        gap = 0;
      } else {
        gap++;
        if (gap > maxGapFrames) break;
      }
      j++;
    }

    const frames = [];
    for (let k = i; k <= last; k++) if (isFinite(midi[k])) frames.push(midi[k]);
    const durMs = (time[last] - time[i]) * 1000 + frameMs;
    if (frames.length && durMs >= minMs) {
      const cents = frames.map((m) => (m - target) * 100);
      notes.push({
        midi: target,
        startIdx: i,
        endIdx: last,
        start: time[i],
        end: time[last] + frameMs / 1000,
        durationMs: durMs,
        meanCents: cents.reduce((a, b) => a + b, 0) / cents.length,
        // Spread within the note: vibrato and drift both show up here.
        spreadCents: stdev(cents),
        frames: frames.length,
      });
    }
    i = last + 1;
  }
  return notes;
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/* ---------- pitch-correction indicators ---------- */

/**
 * Four independent indicators, each mapped to 0..1, then combined.
 *
 * The point is that any one of these has an innocent explanation (a great
 * singer really is accurate, a stem really can be tuned to A=442), so the
 * report always shows the components, never just the number.
 */
export function analyseCorrection(time, midi, notes, opts = {}) {
  const { minNoteMs = 120 } = opts;
  const frameMs = time.length > 1 ? (time[1] - time[0]) * 1000 : 10;

  // Only sustained notes: transitions and grace notes are off-grid for both
  // corrected and uncorrected takes, so including them just adds noise.
  const sustained = notes.filter((nt) => nt.durationMs >= minNoteMs);

  const centre = sustained.map((nt) => nt.meanCents);
  const spread = sustained.map((nt) => nt.spreadCents);

  // 1. How tightly note centres sit on the grid.
  const centreSd = circularSdCents(centre);
  const accuracy = clamp01(invLerp(centreSd, 22, 5));

  // 2. How still the pitch is *within* a note. Human sustains drift and
  //    vibrate; hard-quantised ones sit on a rail.
  const medSpread = median(spread);
  const steadiness = clamp01(invLerp(medSpread, 30, 7));

  // 3. Transition time between consecutive notes. Fast retune settings snap
  //    across a semitone in a few milliseconds; a voice takes far longer.
  const transitions = measureTransitions(time, midi, sustained, frameMs);
  const medTransition = median(transitions);
  const snap = transitions.length >= 3 ? clamp01(invLerp(medTransition, 90, 25)) : 0;

  // 4. Proportion of frames parked inside a narrow window around a semitone.
  const inTune = frameInTuneRatio(midi, 10);
  const quantisation = clamp01(invLerp(inTune, 0.55, 0.92));

  const components = [
    { key: 'accuracy', label: 'Note centres on grid', score: accuracy,
      detail: fmt(centreSd, 1) + ' cents spread across note centres' },
    { key: 'steadiness', label: 'Pitch held still within notes', score: steadiness,
      detail: fmt(medSpread, 1) + ' cents typical movement inside a note' },
    { key: 'snap', label: 'Note-to-note transition speed', score: snap,
      detail: transitions.length >= 3
        ? fmt(medTransition, 0) + ' ms to move a semitone at the fastest point'
        : 'not enough note changes to judge' },
    { key: 'quantisation', label: 'Time parked on exact pitches', score: quantisation,
      detail: fmt(inTune * 100, 0) + '% of sung frames within 10 cents' },
  ];

  const weights = { accuracy: 0.34, steadiness: 0.3, snap: 0.18, quantisation: 0.18 };
  let total = 0;
  let wsum = 0;
  for (const c of components) {
    // An indicator that couldn't be measured drops out rather than scoring zero.
    if (c.key === 'snap' && transitions.length < 3) continue;
    total += c.score * weights[c.key];
    wsum += weights[c.key];
  }
  const score = wsum ? total / wsum : 0;

  return {
    score,
    verdict: verdictFor(score, sustained.length),
    components,
    sustainedNotes: sustained.length,
    centreSd,
    medSpread,
    medTransition,
    inTuneRatio: inTune,
    histogram: centsHistogram(midi),
  };
}

/**
 * Time to travel a semitone at the fastest point of each note change, in ms.
 *
 * Counting frames "between" two notes does not work: segmentation has already
 * absorbed the glide into whichever note each frame rounds to, and for adjacent
 * semitones there is no gap left to measure. Threshold crossings are no better,
 * because vibrato of +/-35 cents swamps any sensible threshold.
 *
 * Peak slope avoids both problems. It needs no threshold, it is well resolved at
 * a 10 ms hop (a 120 ms human glide peaks near 8 cents/frame, an 18 ms retune
 * near 55), and reporting it as "ms per semitone" keeps it readable.
 */
function measureTransitions(time, midi, notes, frameMs) {
  const out = [];
  const window = Math.max(2, Math.round(60 / frameMs)); // look +/-60 ms around the change

  for (let i = 1; i < notes.length; i++) {
    const prev = notes[i - 1];
    const cur = notes[i];
    if (cur.midi === prev.midi) continue;
    // A breath between notes is not a glide, so those pairs say nothing.
    if ((cur.start - prev.end) * 1000 > 80) continue;

    const boundary = cur.startIdx;
    const from = Math.max(prev.startIdx + 1, boundary - window);
    const to = Math.min(cur.endIdx - 1, boundary + window);

    let peak = 0; // semitones per frame
    for (let k = from; k <= to; k++) {
      const a = midi[k - 1];
      const b = midi[k + 1];
      if (!isFinite(a) || !isFinite(b)) continue;
      const slope = Math.abs(b - a) / 2;
      if (slope > peak) peak = slope;
    }
    if (peak > 1e-6) out.push(frameMs / peak); // ms to cover one semitone
  }
  return out;
}

function frameInTuneRatio(midi, windowCents) {
  let inTune = 0;
  let total = 0;
  for (const m of midi) {
    if (!isFinite(m)) continue;
    total++;
    if (Math.abs(centsOffGrid(m)) <= windowCents) inTune++;
  }
  return total ? inTune / total : 0;
}

/** 50 bins across -50..+50 cents, for the deviation histogram. */
export function centsHistogram(midi, bins = 50) {
  const hist = new Float64Array(bins);
  let total = 0;
  for (const m of midi) {
    if (!isFinite(m)) continue;
    const c = centsOffGrid(m);
    let idx = Math.floor(((c + 50) / 100) * bins);
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    hist[idx]++;
    total++;
  }
  if (total) for (let i = 0; i < bins; i++) hist[i] /= total;
  return hist;
}

function verdictFor(score, noteCount) {
  if (noteCount < 8) {
    return { label: 'Not enough material', tone: 'unknown',
      text: 'Too few sustained notes to say anything useful. Try a longer passage.' };
  }
  if (score >= 0.78) {
    return { label: 'Strong signs of pitch correction', tone: 'high',
      text: 'Pitch sits on the grid more precisely, and more consistently, than an unprocessed voice normally does.' };
  }
  if (score >= 0.58) {
    return { label: 'Some signs of pitch correction', tone: 'mid',
      text: 'Tuning is tighter than typical, but a very accurate singer can look like this. Compare against another take before drawing conclusions.' };
  }
  if (score >= 0.35) {
    return { label: 'Little sign of pitch correction', tone: 'low',
      text: 'Pitch moves the way an unprocessed voice usually moves. Light, transparent correction would not necessarily show up here.' };
  }
  return { label: 'No sign of pitch correction', tone: 'none',
    text: 'Natural drift, scooping and vibrato are all present.' };
}

/* ---------- helpers ---------- */

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/** 0 at `zero`, 1 at `one`; works in either direction. */
function invLerp(x, zero, one) {
  if (!isFinite(x)) return 0;
  return (x - zero) / (one - zero);
}

function fmt(x, digits) {
  return isFinite(x) ? x.toFixed(digits) : '–';
}
