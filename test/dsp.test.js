/* Run with: node test/dsp.test.js */

import { trackPitch, cleanContour, resampleMono, WORK_RATE } from '../js/dsp.js';
import {
  hzToMidi, midiToHz, estimateTuning, segmentNotes, analyseCorrection, centsOffGrid,
} from '../js/music.js';
import { melody, renderContour, NATURAL, CORRECTED, PRECISE_SINGER } from './synth.js';

let failures = 0;
let checks = 0;

function check(name, cond, extra = '') {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}${extra ? '  (' + extra + ')' : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra ? '  (' + extra + ')' : ''}`);
  }
}

function section(t) {
  console.log(`\n${t}`);
}

/* ---------- 1. steady tones ---------- */

section('Steady-tone accuracy');
for (const hz of [82.41, 110, 196, 261.63, 440, 659.26, 880]) {
  const sig = renderContour(() => hz, () => 1, 1.2, WORK_RATE);
  const { f0 } = trackPitch(sig, WORK_RATE);
  const voiced = Array.from(f0).filter(isFinite);
  const med = voiced.sort((a, b) => a - b)[voiced.length >> 1];
  const errCents = Math.abs(1200 * Math.log2(med / hz));
  check(`${hz} Hz within 5 cents`, errCents < 5, `err ${errCents.toFixed(2)}c, ${voiced.length} voiced frames`);
}

/* ---------- 2. silence is not reported ---------- */

section('Silence gating');
{
  const rate = WORK_RATE;
  const sig = renderContour(
    (t) => (t < 0.8 || t > 1.8 ? 220 : NaN),
    (t) => (t < 0.8 || t > 1.8 ? 1 : 0),
    2.6, rate,
  );
  const { time, f0 } = trackPitch(sig, rate);
  let inGap = 0;
  let gapVoiced = 0;
  let outVoiced = 0;
  for (let i = 0; i < f0.length; i++) {
    if (time[i] > 0.95 && time[i] < 1.7) {
      inGap++;
      if (isFinite(f0[i])) gapVoiced++;
    } else if (time[i] > 0.15 && time[i] < 0.7) {
      if (isFinite(f0[i])) outVoiced++;
    }
  }
  check('silent stretch reports no notes', gapVoiced === 0, `${gapVoiced}/${inGap} voiced in gap`);
  check('sung stretch does report notes', outVoiced > 20, `${outVoiced} voiced frames`);
}

/* ---------- 2b. options carrying undefined must not disable detection ---------- */

section('Option merging');
{
  const sig = renderContour(() => 220, () => 1, 1.2, WORK_RATE);
  // This is exactly what a UI settings object looks like when a field is unset.
  const { f0 } = trackPitch(sig, WORK_RATE, {
    fMin: 65, fMax: 1100, silenceDropDb: 34, maxAperiodicity: undefined, threshold: undefined,
  });
  const voiced = Array.from(f0).filter(isFinite).length;
  check('undefined options fall back to defaults', voiced > 50, `${voiced} voiced frames`);
}

/* ---------- 3. octave-error cleanup ---------- */

section('Contour cleanup');
{
  const f0 = new Float64Array(60).fill(220);
  f0[20] = 440; // injected octave error
  f0[21] = 110;
  const cleaned = cleanContour(f0);
  check('octave-up outlier corrected', Math.abs(cleaned[20] - 220) < 1, `${cleaned[20].toFixed(1)} Hz`);
  check('octave-down outlier corrected', Math.abs(cleaned[21] - 220) < 1, `${cleaned[21].toFixed(1)} Hz`);

  // A one-frame transient draws a full-height spike across the plot.
  const spiky = new Float64Array(60).fill(220);
  spiky[30] = 370; // ~9 semitones up, not an octave multiple
  const despiked = cleanContour(spiky);
  check('brief non-octave spike removed', !isFinite(despiked[30]), `${despiked[30]}`);
  check('neighbours of a spike are kept', isFinite(despiked[29]) && isFinite(despiked[31]));

  // A sustained leap is real singing and must survive.
  const leap = new Float64Array(60);
  for (let i = 0; i < 60; i++) leap[i] = i < 30 ? 220 : 370;
  const kept = cleanContour(leap);
  const highKept = Array.from(kept.slice(34, 56)).filter((v) => Math.abs(v - 370) < 2).length;
  check('sustained leap survives cleanup', highKept > 18, `${highKept}/22 frames kept`);
}

/* ---------- 4. tuning reference ---------- */

section('Tuning reference estimation');
{
  // A take recorded 30 cents sharp of A440 must read as +30, not as "everything
  // is off-key" -- this is the bug that would poison every other statistic.
  const midis = [];
  for (let i = 0; i < 400; i++) midis.push(60 + (i % 7) + 0.30 + (Math.random() - 0.5) * 0.06);
  const t = estimateTuning(midis);
  check('detects +30 cent offset', Math.abs(t.centsOffset - 30) < 4, `${t.centsOffset.toFixed(1)}c, A4=${t.a4.toFixed(1)}Hz`);

  // The wrap-around case a linear mean gets wrong.
  const wrapped = [];
  for (let i = 0; i < 400; i++) wrapped.push(60 + (i % 5) + (i % 2 ? 0.48 : -0.48));
  const w = estimateTuning(wrapped);
  check('handles +/-48c wrap without collapsing to 0', Math.abs(Math.abs(w.centsOffset) - 50) < 6, `${w.centsOffset.toFixed(1)}c`);
}

/* ---------- 5. end-to-end discrimination ---------- */

section('Correction indicators: natural vs corrected');

function fullAnalysis(mel) {
  const mono = resampleMono([mel.signal], mel.rate, WORK_RATE);
  const raw = trackPitch(mono, WORK_RATE);
  const f0 = cleanContour(raw.f0);
  const midiRaw = Float64Array.from(f0, (hz) => (isFinite(hz) ? hzToMidi(hz) : NaN));
  const tuning = estimateTuning(midiRaw);
  const midi = Float64Array.from(midiRaw, (m) => (isFinite(m) ? m - tuning.centsOffset / 100 : NaN));
  const notes = segmentNotes(raw.time, midi);
  return { report: analyseCorrection(raw.time, midi, notes), notes, tuning, raw, midi };
}

const tune = [62, 64, 65, 67, 65, 64, 62, 60, 62, 64, 67, 65, 64, 62];

const nat = fullAnalysis(melody(tune, NATURAL, { seed: 11 }));
const cor = fullAnalysis(melody(tune, CORRECTED, { seed: 11 }));

console.log(`  natural   score=${nat.report.score.toFixed(3)} "${nat.report.verdict.label}"`);
for (const c of nat.report.components) console.log(`      ${c.label}: ${c.score.toFixed(2)}  ${c.detail}`);
console.log(`  corrected score=${cor.report.score.toFixed(3)} "${cor.report.verdict.label}"`);
for (const c of cor.report.components) console.log(`      ${c.label}: ${c.score.toFixed(2)}  ${c.detail}`);

check('finds the notes in the natural take', nat.notes.length >= 10, `${nat.notes.length} notes`);
check('finds the notes in the corrected take', cor.notes.length >= 10, `${cor.notes.length} notes`);
check('corrected scores higher than natural', cor.report.score > nat.report.score + 0.25,
  `${cor.report.score.toFixed(2)} vs ${nat.report.score.toFixed(2)}`);
check('natural take is not flagged', nat.report.score < 0.55, nat.report.score.toFixed(2));
check('corrected take is flagged', cor.report.score > 0.7, cor.report.score.toFixed(2));

/* ---------- 5b. legato phrasing exercises the transition indicator ---------- */

section('Legato phrasing (no gaps between notes)');
{
  const legatoOpts = { gapSec: 0, noteSec: 0.5, seed: 21 };
  const ln = fullAnalysis(melody(tune, NATURAL, legatoOpts));
  const lc = fullAnalysis(melody(tune, CORRECTED, legatoOpts));
  const tn = ln.report.components.find((c) => c.key === 'snap');
  const tc = lc.report.components.find((c) => c.key === 'snap');
  console.log(`  natural   transitions: ${tn.detail} -> ${tn.score.toFixed(2)}`);
  console.log(`  corrected transitions: ${tc.detail} -> ${tc.score.toFixed(2)}`);
  check('transition speed is measurable on legato lines', isFinite(ln.report.medTransition) && isFinite(lc.report.medTransition),
    `natural ${ln.report.medTransition} ms, corrected ${lc.report.medTransition} ms`);
  check('corrected transitions are faster than natural', lc.report.medTransition < ln.report.medTransition,
    `${lc.report.medTransition} ms vs ${ln.report.medTransition} ms`);
  check('legato: corrected still separates from natural', lc.report.score > ln.report.score + 0.25,
    `${lc.report.score.toFixed(2)} vs ${ln.report.score.toFixed(2)}`);
}

/* ---------- 5c. the false-positive case that matters most ---------- */

section('A very accurate singer must not be flagged as corrected');
{
  const good = fullAnalysis(melody(tune, PRECISE_SINGER, { gapSec: 0, noteSec: 0.5, seed: 31 }));
  console.log(`  precise singer score=${good.report.score.toFixed(3)} "${good.report.verdict.label}"`);
  for (const c of good.report.components) console.log(`      ${c.label}: ${c.score.toFixed(2)}  ${c.detail}`);
  check('accurate human is not called "strong signs"', good.report.score < 0.78, good.report.score.toFixed(2));
  check('accurate human still scores above a loose take', good.report.score > nat.report.score - 0.1,
    `${good.report.score.toFixed(2)} vs natural ${nat.report.score.toFixed(2)}`);
}

/* ---------- 5d. no spurious excursions on real-shaped audio ---------- */

section('Contour is free of spurious jumps');
for (const [name, style] of [['natural', NATURAL], ['corrected', CORRECTED]]) {
  const { midi } = fullAnalysis(melody(tune, style, { gapSec: 0.05, noteSec: 0.55, seed: 11 }));
  let worst = 0;
  let bad = 0;
  for (let i = 1; i < midi.length; i++) {
    if (!isFinite(midi[i]) || !isFinite(midi[i - 1])) continue;
    const jump = Math.abs(midi[i] - midi[i - 1]);
    if (jump > worst) worst = jump;
    if (jump > 1.5) bad++;
  }
  check(`${name}: no frame-to-frame jump over 1.5 semitones`, bad === 0,
    `${bad} jumps, largest ${worst.toFixed(2)} st`);
  const voiced = Array.from(midi).filter(isFinite).length;
  check(`${name}: most of the take is still voiced`, voiced > midi.length * 0.85,
    `${((voiced / midi.length) * 100).toFixed(1)}% voiced`);
}

/* ---------- 6. pitch tracks the written melody ---------- */

section('Note identification');
{
  const mel = melody([60, 62, 64, 65, 67], CORRECTED, { seed: 5 });
  const { notes } = fullAnalysis(mel);
  const got = notes.filter((n) => n.durationMs > 200).map((n) => n.midi);
  const want = [60, 62, 64, 65, 67];
  check('reads back the written notes', want.every((w) => got.includes(w)),
    `got [${got.join(', ')}] want [${want.join(', ')}]`);
}

/* ---------- 7. performance ---------- */

section('Performance');
{
  const seconds = 240;
  const rate = WORK_RATE;
  const sig = renderContour((t) => 180 + 60 * Math.sin(t * 2), () => 1, seconds, rate);
  const t0 = performance.now();
  const res = trackPitch(sig, rate);
  const ms = performance.now() - t0;
  check('4-minute stem analyses in under 6 s', ms < 6000,
    `${(ms / 1000).toFixed(2)} s for ${res.f0.length} frames`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
