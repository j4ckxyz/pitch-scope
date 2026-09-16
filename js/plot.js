/* plot.js: piano-roll pitch plot on a canvas.
 *
 * Two modes:
 *   'pitch'     y = absolute pitch, with a semitone grid. Correction shows up as
 *               a trace that hugs the gridlines.
 *   'deviation' y = cents from the nearest semitone. Correction shows up as a
 *               trace flattened onto the zero line.
 */

import { midiToName, centsOffGrid } from './music.js';

export const TRACK_COLORS = [
  { line: '#4a90d9', fill: 'rgba(74,144,217,0.22)', name: 'Blue' },
  { line: '#d98f4a', fill: 'rgba(217,143,74,0.22)', name: 'Amber' },
];

const THEME = {
  bg: '#16181d',
  gridLine: '#232831',
  gridLineOctave: '#333b47',
  gridLabel: '#79818f',
  gridLabelOctave: '#aab2bf',
  axis: '#2c323c',
  text: '#d6dae1',
  muted: '#8b93a1',
  playhead: '#e8e3d6',
  centreLine: '#3d4652',
  tolerance: 'rgba(120,150,130,0.10)',
};

const PAD = { left: 52, right: 14, top: 12, bottom: 26 };

export class PitchPlot {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tracks = []; // { result, color, visible, label }
    this.mode = 'pitch';
    this.showNotes = true;
    this.showTolerance = true;
    this.toleranceCents = 10;
    this.view = { t0: 0, t1: 10, midiLo: 48, midiHi: 72 };
    this.playhead = null;
    this.hover = null;
    this._dpr = 1;
  }

  setTracks(tracks) {
    this.tracks = tracks;
    this.autoRange();
  }

  /** Fit the view to everything currently visible. */
  autoRange() {
    const vis = this.tracks.filter((t) => t.visible && t.result);
    if (!vis.length) {
      this.view = { t0: 0, t1: 10, midiLo: 48, midiHi: 72 };
      return;
    }
    let dur = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of vis) {
      dur = Math.max(dur, t.result.duration);
      for (const m of t.result.midi) {
        if (!isFinite(m)) continue;
        if (m < lo) lo = m;
        if (m > hi) hi = m;
      }
    }
    if (!isFinite(lo)) {
      lo = 48;
      hi = 72;
    }
    // Whole semitones with a little air, and never so zoomed that labels collide.
    const pad = Math.max(1.5, (hi - lo) * 0.12);
    this.view = {
      t0: 0,
      t1: dur || 10,
      midiLo: Math.floor(lo - pad),
      midiHi: Math.ceil(hi + pad),
    };
    this.fullDuration = dur;
  }

  zoomTime(factor, anchorRatio = 0.5) {
    const { t0, t1 } = this.view;
    const span = t1 - t0;
    const anchor = t0 + span * anchorRatio;
    const newSpan = Math.max(0.15, Math.min(span * factor, (this.fullDuration || span) * 1.5));
    this.view.t0 = anchor - newSpan * anchorRatio;
    this.view.t1 = anchor + newSpan * (1 - anchorRatio);
    this.clampTime();
  }

  panTime(fraction) {
    const span = this.view.t1 - this.view.t0;
    this.view.t0 += span * fraction;
    this.view.t1 += span * fraction;
    this.clampTime();
  }

  clampTime() {
    const max = this.fullDuration || this.view.t1;
    const span = this.view.t1 - this.view.t0;
    if (span >= max) {
      this.view.t0 = 0;
      this.view.t1 = max;
      return;
    }
    if (this.view.t0 < 0) {
      this.view.t0 = 0;
      this.view.t1 = span;
    }
    if (this.view.t1 > max) {
      this.view.t1 = max;
      this.view.t0 = max - span;
    }
  }

  zoomPitch(factor) {
    if (this.mode !== 'pitch') return;
    const { midiLo, midiHi } = this.view;
    const mid = (midiLo + midiHi) / 2;
    const half = Math.max(1.5, ((midiHi - midiLo) / 2) * factor);
    this.view.midiLo = mid - half;
    this.view.midiHi = mid + half;
  }

  panPitch(semitones) {
    if (this.mode !== 'pitch') return;
    this.view.midiLo += semitones;
    this.view.midiHi += semitones;
  }

  /* ---------- geometry ---------- */

  get plotRect() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return {
      x: PAD.left,
      y: PAD.top,
      w: Math.max(10, w - PAD.left - PAD.right),
      h: Math.max(10, h - PAD.top - PAD.bottom),
    };
  }

  timeToX(t) {
    const r = this.plotRect;
    return r.x + ((t - this.view.t0) / (this.view.t1 - this.view.t0)) * r.w;
  }

  xToTime(x) {
    const r = this.plotRect;
    return this.view.t0 + ((x - r.x) / r.w) * (this.view.t1 - this.view.t0);
  }

  valueToY(v) {
    const r = this.plotRect;
    if (this.mode === 'deviation') {
      return r.y + ((50 - v) / 100) * r.h;
    }
    const { midiLo, midiHi } = this.view;
    return r.y + ((midiHi - v) / (midiHi - midiLo)) * r.h;
  }

  yToValue(y) {
    const r = this.plotRect;
    if (this.mode === 'deviation') return 50 - ((y - r.y) / r.h) * 100;
    const { midiLo, midiHi } = this.view;
    return midiHi - ((y - r.y) / r.h) * (midiHi - midiLo);
  }

  /* ---------- drawing ---------- */

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this._dpr = dpr;
  }

  draw() {
    this.resize();
    const ctx = this.ctx;
    const dpr = this._dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);

    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);

    const r = this.plotRect;
    ctx.save();
    if (this.mode === 'deviation') this.drawDeviationGrid();
    else this.drawPitchGrid();
    this.drawTimeAxis();

    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();

    if (this.mode === 'pitch' && this.showNotes) {
      for (const t of this.tracks) if (t.visible && t.result) this.drawNoteBlocks(t);
    }
    for (const t of this.tracks) if (t.visible && t.result) this.drawTrace(t);
    ctx.restore();

    this.drawPlayhead();
    this.drawHover();
  }

  drawPitchGrid() {
    const ctx = this.ctx;
    const r = this.plotRect;
    const { midiLo, midiHi } = this.view;
    const span = midiHi - midiLo;
    // Below ~4px per semitone the lines merge into a smear; drop to octaves.
    const pxPerSemitone = r.h / span;
    const step = pxPerSemitone < 4 ? 12 : pxPerSemitone < 9 ? 3 : 1;
    const labelEvery = pxPerSemitone < 4 ? 12 : pxPerSemitone < 14 ? 12 : pxPerSemitone < 22 ? 3 : 1;

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';

    const start = Math.ceil(midiLo);
    for (let m = start; m <= midiHi; m++) {
      const y = this.valueToY(m);
      const isC = ((m % 12) + 12) % 12 === 0;
      if (!isC && (m - start) % step !== 0) continue;

      if (this.showTolerance && pxPerSemitone >= 9) {
        // Band showing the +/- tolerance window used by the report.
        const half = this.toleranceCents / 100;
        ctx.fillStyle = THEME.tolerance;
        ctx.fillRect(r.x, this.valueToY(m + half), r.w, this.valueToY(m - half) - this.valueToY(m + half));
      }

      ctx.strokeStyle = isC ? THEME.gridLineOctave : THEME.gridLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(r.x, Math.round(y) + 0.5);
      ctx.lineTo(r.x + r.w, Math.round(y) + 0.5);
      ctx.stroke();

      if (isC || (labelEvery === 1) || (labelEvery === 3 && m % 3 === 0)) {
        ctx.fillStyle = isC ? THEME.gridLabelOctave : THEME.gridLabel;
        ctx.textAlign = 'right';
        ctx.fillText(midiToName(m), r.x - 8, y);
      }
    }
    ctx.strokeStyle = THEME.axis;
    ctx.beginPath();
    ctx.moveTo(r.x + 0.5, r.y);
    ctx.lineTo(r.x + 0.5, r.y + r.h);
    ctx.stroke();
  }

  drawDeviationGrid() {
    const ctx = this.ctx;
    const r = this.plotRect;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';

    if (this.showTolerance) {
      ctx.fillStyle = THEME.tolerance;
      ctx.fillRect(r.x, this.valueToY(this.toleranceCents), r.w,
        this.valueToY(-this.toleranceCents) - this.valueToY(this.toleranceCents));
    }

    for (let c = -50; c <= 50; c += 10) {
      const y = this.valueToY(c);
      ctx.strokeStyle = c === 0 ? THEME.centreLine : THEME.gridLine;
      ctx.lineWidth = c === 0 ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(r.x, Math.round(y) + 0.5);
      ctx.lineTo(r.x + r.w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = c === 0 ? THEME.gridLabelOctave : THEME.gridLabel;
      ctx.fillText(c > 0 ? `+${c}` : `${c}`, r.x - 8, y);
    }
    ctx.fillStyle = THEME.muted;
    ctx.textAlign = 'left';
    ctx.save();
    ctx.translate(12, r.y + r.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('cents off', 0, 0);
    ctx.restore();
  }

  drawTimeAxis() {
    const ctx = this.ctx;
    const r = this.plotRect;
    const span = this.view.t1 - this.view.t0;
    const target = Math.max(2, Math.floor(r.w / 90));
    const step = niceStep(span / target);

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const first = Math.ceil(this.view.t0 / step) * step;
    for (let t = first; t <= this.view.t1; t += step) {
      const x = this.timeToX(t);
      ctx.strokeStyle = THEME.gridLine;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, r.y);
      ctx.lineTo(Math.round(x) + 0.5, r.y + r.h);
      ctx.stroke();
      ctx.fillStyle = THEME.gridLabel;
      ctx.fillText(formatTime(t, step), x, r.y + r.h + 6);
    }
    ctx.strokeStyle = THEME.axis;
    ctx.beginPath();
    ctx.moveTo(r.x, Math.round(r.y + r.h) + 0.5);
    ctx.lineTo(r.x + r.w, Math.round(r.y + r.h) + 0.5);
    ctx.stroke();
  }

  drawNoteBlocks(track) {
    const ctx = this.ctx;
    const { notes } = track.result;
    ctx.fillStyle = track.color.fill;
    const h = Math.max(2, Math.abs(this.valueToY(0) - this.valueToY(0.7)));
    for (const n of notes) {
      if (n.end < this.view.t0 || n.start > this.view.t1) continue;
      const x0 = this.timeToX(n.start);
      const x1 = this.timeToX(n.end);
      ctx.fillRect(x0, this.valueToY(n.midi + 0.35), Math.max(1, x1 - x0), h);
    }
  }

  drawTrace(track) {
    const ctx = this.ctx;
    const { time, midi } = track.result;
    const n = time.length;
    if (!n) return;

    const dt = time.length > 1 ? time[1] - time[0] : 0.01;
    let i0 = Math.max(0, Math.floor((this.view.t0 - time[0]) / dt) - 2);
    let i1 = Math.min(n - 1, Math.ceil((this.view.t1 - time[0]) / dt) + 2);

    ctx.strokeStyle = track.color.line;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // One path with moveTo at every unvoiced frame: the gaps are the silence,
    // and drawing them as breaks is what the tool is for.
    ctx.beginPath();
    let pen = false;
    for (let i = i0; i <= i1; i++) {
      const m = midi[i];
      if (!isFinite(m)) {
        pen = false;
        continue;
      }
      const v = this.mode === 'deviation' ? centsOffGrid(m) : m;
      const x = this.timeToX(time[i]);
      const y = this.valueToY(v);
      // In deviation mode the value wraps at +/-50; lifting the pen avoids a
      // vertical streak straight down the plot.
      if (pen && this.mode === 'deviation' && Math.abs(v - this._lastDev) > 55) pen = false;
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
      this._lastDev = v;
    }
    ctx.stroke();
  }

  drawPlayhead() {
    if (this.playhead == null) return;
    const r = this.plotRect;
    const x = this.timeToX(this.playhead);
    if (x < r.x || x > r.x + r.w) return;
    const ctx = this.ctx;
    ctx.strokeStyle = THEME.playhead;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, r.y);
    ctx.lineTo(Math.round(x) + 0.5, r.y + r.h);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawHover() {
    if (!this.hover) return;
    const r = this.plotRect;
    const { x } = this.hover;
    if (x < r.x || x > r.x + r.w) return;
    const ctx = this.ctx;
    ctx.strokeStyle = THEME.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, r.y);
    ctx.lineTo(Math.round(x) + 0.5, r.y + r.h);
    ctx.stroke();
  }

  /** Nearest voiced sample of each visible track at time t, for the readout. */
  sampleAt(t) {
    const out = [];
    for (const track of this.tracks) {
      if (!track.visible || !track.result) continue;
      const { time, midi } = track.result;
      if (!time.length) continue;
      const dt = time.length > 1 ? time[1] - time[0] : 0.01;
      const idx = Math.round((t - time[0]) / dt);
      const m = idx >= 0 && idx < midi.length ? midi[idx] : NaN;
      out.push({ track, midi: m });
    }
    return out;
  }
}

function niceStep(raw) {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (raw <= s) return s;
  return 900;
}

function formatTime(t, step) {
  const sign = t < 0 ? '-' : '';
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  if (step < 1) return `${sign}${m}:${s.toFixed(2).padStart(5, '0')}`;
  return `${sign}${m}:${String(Math.round(s)).padStart(2, '0')}`;
}
