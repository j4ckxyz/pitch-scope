/* synth.js: voice-like test signals with known ground truth. */

import { midiToHz } from '../js/music.js';

/** Deterministic PRNG so failures are reproducible. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Box-Muller, so per-note tuning error is distributed like a real singer's. */
function gaussian(rand) {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * Render a pitch contour (function of time -> Hz or NaN) as a voice-like tone:
 * a handful of harmonics rolling off, which is what YIN sees from a vocal.
 */
export function renderContour(contourFn, ampFn, durationSec, rate, seed = 7) {
  const n = Math.floor(durationSec * rate);
  const out = new Float32Array(n);
  const rand = rng(seed);
  let phase = 0;
  const harmonics = [1, 0.5, 0.33, 0.22, 0.15, 0.1];

  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = contourFn(t);
    const amp = ampFn(t);
    if (!isFinite(f) || amp <= 0) {
      out[i] = (rand() - 0.5) * 0.0008; // room noise in the gaps
      continue;
    }
    phase += (2 * Math.PI * f) / rate;
    let s = 0;
    for (let h = 0; h < harmonics.length; h++) s += harmonics[h] * Math.sin(phase * (h + 1));
    out[i] = amp * s * 0.14 + (rand() - 0.5) * 0.004;
  }
  return out;
}

/** Short fade at each edge so notes don't click. */
function envelope(t, start, end, fade = 0.02) {
  if (t < start || t > end) return 0;
  const up = Math.min(1, (t - start) / fade);
  const down = Math.min(1, (end - t) / fade);
  return Math.max(0, Math.min(up, down));
}

/**
 * Build a melody with configurable "humanness".
 *
 * style.centreJitter  cents of random per-note tuning error
 * style.driftCents    slow within-note wander
 * style.vibratoCents  vibrato depth (peak)
 * style.glideMs       portamento time between notes
 */
export function melody(midiNotes, style, { noteSec = 0.62, gapSec = 0.16, rate = 44100, seed = 3 } = {}) {
  const rand = rng(seed);
  const events = [];
  let t = 0.25;
  for (const m of midiNotes) {
    events.push({
      midi: m,
      start: t,
      end: t + noteSec,
      offset: gaussian(rand) * style.centreJitter,
      driftPhase: rand() * Math.PI * 2,
      vibPhase: rand() * Math.PI * 2,
    });
    t += noteSec + gapSec;
  }
  const duration = t + 0.3;

  const glide = style.glideMs / 1000;
  const legato = gapSec < 0.02;

  // Half-open intervals: at a legato boundary `end` and the next `start` are the
  // same instant, and `time < e.end` picks the incoming note unambiguously.
  const noteAt = (time) => {
    for (let i = 0; i < events.length; i++) {
      if (time >= events[i].start && time < events[i].end) return i;
    }
    return -1;
  };

  const contour = (time) => {
    const idx = noteAt(time);
    if (idx < 0) return NaN;
    const e = events[idx];

    let cents = e.offset;
    const rel = time - e.start;

    // Slow drift over the note.
    cents += style.driftCents * Math.sin(e.driftPhase + rel * 1.9);

    // Vibrato fades in, the way a singer's does.
    const vibOnset = Math.min(1, Math.max(0, (rel - 0.18) / 0.22));
    cents += style.vibratoCents * vibOnset * Math.sin(e.vibPhase + 2 * Math.PI * 5.4 * rel);

    let midi = e.midi + cents / 100;

    // Glide in from the previous note over the first `glide` seconds.
    if (idx > 0 && rel < glide && glide > 0) {
      const prev = events[idx - 1];
      midi = prev.midi + (midi - prev.midi) * smoothstep(rel / glide);
    }
    return midiToHz(midi);
  };

  // Legato phrases get one envelope over the whole line, so there is no
  // re-attack at each note to break the contour into separate segments.
  const amp = legato
    ? (time) => envelope(time, events[0].start, events[events.length - 1].end, 0.03)
    : (time) => {
        const idx = noteAt(time);
        return idx < 0 ? 0 : envelope(time, events[idx].start, events[idx].end);
      };

  return { signal: renderContour(contour, amp, duration, rate, seed), rate, duration, events };
}

function smoothstep(x) {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
}

// centreJitter is now a standard deviation. Values chosen to match published
// ranges for untreated pop vocals (note centres scatter ~15-20 cents).
export const NATURAL = { centreJitter: 18, driftCents: 12, vibratoCents: 36, glideMs: 120 };
export const CORRECTED = { centreJitter: 3, driftCents: 1.5, vibratoCents: 5, glideMs: 18 };
// A genuinely excellent singer: accurate centres, but still human inside the note.
export const PRECISE_SINGER = { centreJitter: 8, driftCents: 8, vibratoCents: 28, glideMs: 95 };
