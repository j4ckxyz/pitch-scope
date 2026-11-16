/* app.js: file loading, playback, interaction, and the report panel. */

import { PitchPlot, TRACK_COLORS } from './plot.js';
import { midiToName, centsOffGrid } from './music.js';

const $ = (id) => document.getElementById(id);

const state = {
  tracks: [], // { id, name, buffer, result, color, visible, slot }
  advanced: false,
  playing: false,
  playFrom: 0,
  playStartedAt: 0,
  loop: { a: null, b: null, enabled: false },
  settings: {
    toleranceCents: 10,
    minNoteMs: 70,
    silenceDropDb: 34,
    fMin: 65,
    fMax: 1100,
  },
};

const plot = new PitchPlot($('plot'));
let audioCtx = null;
let sourceNode = null;
let worker = null;
let jobId = 0;
const pending = new Map();

/* ---------- worker ---------- */

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const { id, type } = ev.data;
    const job = pending.get(id);
    if (!job) return;
    if (type === 'progress') {
      showProgress(ev.data.stage, ev.data.value);
    } else if (type === 'done') {
      pending.delete(id);
      hideProgress();
      job.resolve(ev.data.result);
    } else if (type === 'error') {
      pending.delete(id);
      hideProgress();
      job.reject(new Error(ev.data.message));
    }
  };
  worker.onerror = (e) => {
    hideProgress();
    for (const [, job] of pending) job.reject(new Error(e.message || 'Analysis failed'));
    pending.clear();
  };
  return worker;
}

function analyse(buffer) {
  const id = ++jobId;
  // Copy the channels: transferring would detach the AudioBuffer's own data and
  // break playback of the very track being analysed.
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c).slice());
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage(
      { id, channels, sampleRate: buffer.sampleRate, settings: { ...state.settings } },
      channels.map((c) => c.buffer),
    );
  });
}

/* ---------- loading ---------- */

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

async function loadFile(file, slot) {
  if (!file) return;
  clearError();
  showProgress('正在解码音频', 0.01);
  try {
    const arrayBuf = await file.arrayBuffer();
    const buffer = await ensureAudioCtx().decodeAudioData(arrayBuf);
    const result = await analyse(buffer);

    const existing = state.tracks.findIndex((t) => t.slot === slot);
    const track = {
      id: `${slot}-${Date.now()}`,
      name: file.name,
      buffer,
      result,
      color: TRACK_COLORS[slot],
      visible: true,
      slot,
    };
    if (existing >= 0) state.tracks[existing] = track;
    else state.tracks.push(track);
    state.tracks.sort((a, b) => a.slot - b.slot);

    stopPlayback();
    clearLoop();
    plot.setTracks(state.tracks);
    render();
  } catch (err) {
    hideProgress();
    reportError(file.name, err);
  }
}

function reportError(name, err) {
  const msg = /decode|Unable to decode/i.test(String(err && err.message))
    ? `无法解码“${name}”。请尝试 WAV、MP3、FLAC、M4A 或 OGG。`
    : `无法分析“${name}”：${err && err.message ? err.message : err}`;
  const box = $('errorBox');
  box.textContent = msg;
  box.hidden = false;
}

function clearError() {
  $('errorBox').hidden = true;
  $('errorBox').textContent = '';
}

/** Same phrase sung naturally and hard-tuned, so the difference is visible at once. */
async function loadDemoPair() {
  const files = [
    ['samples/natural-vocal.wav', 0],
    ['samples/tuned-vocal.wav', 1],
  ];
  setAdvanced(true);
  for (const [url, slot] of files) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      await loadFile(new File([blob], url.split('/').pop(), { type: 'audio/wav' }), slot);
    } catch (err) {
      reportError(url, new Error('example file not found. Serve the folder over http'));
      return;
    }
  }
}

function removeTrack(slot) {
  state.tracks = state.tracks.filter((t) => t.slot !== slot);
  if (!state.tracks.length) clearLoop();
  stopPlayback();
  plot.setTracks(state.tracks);
  render();
}

/** Re-run analysis for every loaded track, e.g. after a settings change. */
async function reanalyseAll() {
  if (!state.tracks.length) return;
  for (const track of state.tracks) {
    try {
      track.result = await analyse(track.buffer);
    } catch (err) {
      reportError(track.name, err);
    }
  }
  plot.setTracks(state.tracks);
  render();
}

/* ---------- playback ---------- */

function playbackTrack() {
  return state.tracks.find((t) => t.visible) || state.tracks[0] || null;
}

function togglePlay() {
  if (state.playing) stopPlayback();
  else startPlayback();
}

function startPlayback(offsetOverride = null) {
  const track = playbackTrack();
  if (!track) return;
  const ctx = ensureAudioCtx();
  stopPlayback();

  const requested = offsetOverride == null ? state.playFrom : offsetOverride;
  const offset = Math.max(0, Math.min(requested, track.buffer.duration - 0.01));
  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = track.buffer;
  sourceNode.connect(ctx.destination);
  sourceNode.onended = () => {
    if (state.playing) {
      if (state.loop.enabled && state.loop.a != null && state.loop.b != null) {
        startPlayback(state.loop.a);
        return;
      }
      state.playing = false;
      state.playFrom = 0;
      plot.playhead = null;
      updateTransport();
      draw();
    }
  };
  sourceNode.start(0, offset);
  state.playing = true;
  state.playFrom = offset;
  state.playStartedAt = ctx.currentTime - offset;
  updateTransport();
  tickPlayhead();
}

function stopPlayback() {
  if (sourceNode) {
    sourceNode.onended = null;
    try { sourceNode.stop(); } catch { /* already stopped */ }
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (state.playing) state.playFrom = currentPlayTime();
  state.playing = false;
  updateTransport();
}

function currentPlayTime() {
  if (!state.playing || !audioCtx) return state.playFrom;
  return audioCtx.currentTime - state.playStartedAt;
}

function tickPlayhead() {
  if (!state.playing) return;
  const t = currentPlayTime();
  if (state.loop.enabled && state.loop.a != null && state.loop.b != null && t >= state.loop.b) {
    startPlayback(state.loop.a);
    return;
  }
  plot.playhead = t;
  // Keep the playhead in view once it leaves the right edge.
  if (t > plot.view.t1 || t < plot.view.t0) {
    const span = plot.view.t1 - plot.view.t0;
    plot.view.t0 = t - span * 0.15;
    plot.view.t1 = plot.view.t0 + span;
    plot.clampTime();
  }
  updateTimeDisplay();
  draw();
  requestAnimationFrame(tickPlayhead);
}

/* ---------- rendering ---------- */

let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    plot.toleranceCents = state.settings.toleranceCents;
    plot.loop = state.loop;
    plot.draw();
  });
}

function render() {
  renderChips();
  renderReports();
  $('empty').hidden = state.tracks.length > 0;
  $('sidebarEmpty').hidden = state.tracks.length > 0;
  $('btnPlay').disabled = !state.tracks.length;
  updateLoopUI();
  updateTimeDisplay();
  draw();
}

function renderChips() {
  const strip = $('tracksStrip');
  strip.innerHTML = '';
  for (const track of state.tracks) {
    const chip = document.createElement('div');
    chip.className = 'track-chip' + (track.visible ? '' : ' is-hidden');

    const sw = document.createElement('span');
    sw.className = 'chip-swatch';
    sw.style.background = track.color.line;

    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = track.name;
    name.title = track.name;

    const eye = document.createElement('button');
    eye.className = 'chip-btn';
    eye.textContent = track.visible ? '◉' : '○';
    eye.title = `显示或隐藏（${track.slot + 1}）`;
    eye.setAttribute('aria-label', `切换 ${track.name}`);
    eye.onclick = () => toggleTrack(track.slot);

    const close = document.createElement('button');
    close.className = 'chip-btn';
    close.textContent = '✕';
    close.title = '移除音轨';
    close.setAttribute('aria-label', `移除 ${track.name}`);
    close.onclick = () => removeTrack(track.slot);

    chip.append(sw, name, eye, close);
    strip.append(chip);
  }
}

function renderReports() {
  const host = $('reports');
  host.innerHTML = '';
  for (const track of state.tracks) {
    if (!track.result) continue;
    host.append(buildReport(track));
  }
}

function buildReport(track) {
  const { report, tuning, notes, duration } = track.result;
  const root = el('div', 'report');

  const head = el('div', 'report-head');
  const sw = el('span', 'chip-swatch');
  sw.style.background = track.color.line;
  const title = el('span', 'report-title', track.name);
  title.title = track.name;
  head.append(sw, title);

  const body = el('div', 'report-body');

  const verdict = el('div', `verdict tone-${report.verdict.tone}`, report.verdict.label);
  const vtext = el('p', 'verdict-text', report.verdict.text);

  const scoreLine = el('div', 'score-line');
  scoreLine.append(
    el('span', 'score-value', Math.round(report.score * 100)),
    el('span', 'score-label', '/ 100 修音可能性'),
  );

  const meter = el('div', 'meter');
  const fill = el('div', 'meter-fill');
  fill.style.width = `${Math.max(2, report.score * 100)}%`;
  fill.style.background = toneColor(report.verdict.tone);
  meter.append(fill);

  body.append(verdict, vtext, scoreLine, meter);

  if (state.advanced) {
    const comps = el('div', 'components');
    for (const c of report.components) {
      const wrap = el('div');
      const label = el('div', 'component-label');
      label.append(el('b', '', c.label), el('span', '', `${Math.round(c.score * 100)}`));
      const bar = el('div', 'component-bar');
      const bf = el('div', 'component-fill');
      bf.style.width = `${Math.max(1, c.score * 100)}%`;
      bf.style.background = track.color.line;
      bar.append(bf);
      wrap.append(label, bar, el('div', 'component-detail', c.detail));
      comps.append(wrap);
    }
    body.append(comps);

    const facts = el('dl', 'facts');
    addFact(facts, '持续音符', `${report.sustainedNotes}`);
    addFact(facts, '检测音符', `${notes.length}`);
    addFact(facts, '调音参考', `A${tuning.a4.toFixed(1)} Hz`);
    addFact(facts, '网格偏差', `${signed(tuning.appliedCents, 1)}¢`);
    addFact(facts, '时长', formatClock(duration));
    body.append(facts);

    const hist = el('div', 'hist-block');
    hist.append(el('div', 'hist-title', '与最近音符的距离'));
    const canvas = document.createElement('canvas');
    canvas.className = 'hist';
    hist.append(canvas);
    const axis = el('div', 'hist-axis');
    axis.append(el('span', '', '−50¢'), el('span', '', '音准'), el('span', '', '+50¢'));
    hist.append(axis);
    body.append(hist);
    // Size is only known once it is in the document.
    requestAnimationFrame(() => drawHistogram(canvas, report.histogram, track.color.line));
  }

  root.append(head, body);
  return root;
}

function addFact(dl, term, value) {
  dl.append(el('dt', '', term), el('dd', '', value));
}

function drawHistogram(canvas, hist, color) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  let max = 0;
  for (const v of hist) if (v > max) max = v;
  if (!max) return;

  // Tolerance window, so the bar chart is read against the same ruler as the score.
  const tol = state.settings.toleranceCents;
  ctx.fillStyle = 'rgba(120,150,130,0.14)';
  ctx.fillRect(((50 - tol) / 100) * w, 0, ((2 * tol) / 100) * w, h);

  const bw = w / hist.length;
  ctx.fillStyle = color;
  for (let i = 0; i < hist.length; i++) {
    const bh = (hist[i] / max) * (h - 3);
    ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 0.6), bh);
  }

  ctx.strokeStyle = 'rgba(214,218,225,0.35)';
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.stroke();
}

function toneColor(tone) {
  return { high: 'var(--alert)', mid: 'var(--warn)', low: 'var(--good)', none: 'var(--good)' }[tone]
    || 'var(--text-faint)';
}

function el(tag, cls = '', text = '') {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== '') n.textContent = text;
  return n;
}

/* ---------- transport / readout ---------- */

function updateTransport() {
  const btn = $('btnPlay');
  btn.classList.toggle('is-playing', state.playing);
  btn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  updateTimeDisplay();
}

function setLoopPoint(which) {
  if (!state.tracks.length) return;
  const t = Math.max(0, currentPlayTime());
  state.loop[which] = t;
  if (state.loop.a != null && state.loop.b != null && state.loop.b <= state.loop.a) {
    if (which === 'a') state.loop.b = null;
    else state.loop.a = null;
  }
  if (state.loop.a != null && state.loop.b != null) {
    state.loop.enabled = true;
    if (state.playFrom < state.loop.a || state.playFrom >= state.loop.b) state.playFrom = state.loop.a;
  }
  updateLoopUI();
  draw();
}

function clearLoop() {
  state.loop = { a: null, b: null, enabled: false };
  updateLoopUI();
  draw();
}

function updateLoopUI() {
  const hasTrack = state.tracks.length > 0;
  const a = state.loop.a;
  const b = state.loop.b;
  $('btnSetA').disabled = !hasTrack;
  $('btnSetB').disabled = !hasTrack;
  $('btnLoop').disabled = !(a != null && b != null);
  $('btnClearLoop').disabled = !(a != null || b != null);
  $('btnLoop').setAttribute('aria-pressed', String(state.loop.enabled));
  $('btnLoop').textContent = state.loop.enabled ? '停止 AB' : 'AB 循环';
  $('btnSetA').textContent = a == null ? '设为 A' : `A ${formatClock(a)}`;
  $('btnSetB').textContent = b == null ? '设为 B' : `B ${formatClock(b)}`;
}

function updateTimeDisplay() {
  const track = playbackTrack();
  const dur = track ? track.buffer.duration : 0;
  $('timeDisplay').textContent = `${formatClock(currentPlayTime())} / ${formatClock(dur)}`;
}

function formatClock(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function signed(v, digits) {
  if (!isFinite(v)) return '–';
  return (v >= 0 ? '+' : '') + v.toFixed(digits);
}

function updateReadout(clientX, clientY) {
  const box = $('plot').getBoundingClientRect();
  const x = clientX - box.left;
  const r = plot.plotRect;
  const out = $('readout');
  if (x < r.x || x > r.x + r.w || !state.tracks.length) {
    out.hidden = true;
    plot.hover = null;
    return;
  }
  const t = plot.xToTime(x);
  plot.hover = { x, y: clientY - box.top };

  out.innerHTML = '';
  out.append(el('div', 'readout-time', formatClock(t) + '.' + String(Math.floor((t % 1) * 100)).padStart(2, '0')));
  for (const s of plot.sampleAt(t)) {
    const row = el('div', 'readout-row');
    const sw = el('span', 'readout-swatch');
    sw.style.background = s.track.color.line;
    if (isFinite(s.midi)) {
      const cents = centsOffGrid(s.midi);
      row.append(
        sw,
        el('span', 'readout-note', midiToName(s.midi)),
        el('span', 'readout-cents', `${signed(cents, 0)}¢`),
      );
    } else {
      row.append(sw, el('span', 'readout-cents', '静音'));
    }
    out.append(row);
  }
  out.hidden = false;
}

/* ---------- interaction ---------- */

function setMode(mode) {
  plot.mode = mode;
  $('modePitch').classList.toggle('is-on', mode === 'pitch');
  $('modeDeviation').classList.toggle('is-on', mode === 'deviation');
  draw();
}

function toggleTrack(slot) {
  const track = state.tracks.find((t) => t.slot === slot);
  if (!track) return;
  track.visible = !track.visible;
  renderChips();
  draw();
}

function setAdvanced(on) {
  state.advanced = on;
  document.body.classList.toggle('advanced', on);
  $('btnAdvanced').setAttribute('aria-pressed', String(on));
  renderReports();
  draw();
}

function showProgress(stage, value) {
  $('progress').hidden = false;
  $('progressLabel').textContent = stage;
  $('progressFill').style.width = `${Math.round(value * 100)}%`;
}

function hideProgress() {
  $('progress').hidden = true;
}

function wireUp() {
  $('btnOpenA').onclick = () => $('fileA').click();
  $('btnOpenEmpty').onclick = () => $('fileA').click();
  $('btnDemo').onclick = loadDemoPair;
  $('btnOpenB').onclick = () => $('fileB').click();
  $('fileA').onchange = (e) => { loadFile(e.target.files[0], 0); e.target.value = ''; };
  $('fileB').onchange = (e) => { loadFile(e.target.files[0], 1); e.target.value = ''; };

  $('btnAdvanced').onclick = () => setAdvanced(!state.advanced);
  $('btnHelp').onclick = () => { $('helpModal').hidden = false; };
  $('btnCloseHelp').onclick = () => { $('helpModal').hidden = true; };
  $('helpModal').onclick = (e) => { if (e.target === $('helpModal')) $('helpModal').hidden = true; };

  $('btnPlay').onclick = togglePlay;
  $('modePitch').onclick = () => setMode('pitch');
  $('modeDeviation').onclick = () => setMode('deviation');
  $('chkNotes').onchange = (e) => { plot.showNotes = e.target.checked; draw(); };
  $('chkTolerance').onchange = (e) => { plot.showTolerance = e.target.checked; draw(); };

  $('btnZoomIn').onclick = () => { plot.zoomTime(0.6); draw(); };
  $('btnZoomOut').onclick = () => { plot.zoomTime(1 / 0.6); draw(); };
  $('btnPitchZoomIn').onclick = () => { plot.zoomPitch(0.7); draw(); };
  $('btnPitchZoomOut').onclick = () => { plot.zoomPitch(1 / 0.7); draw(); };
  $('btnFit').onclick = () => { plot.resetView(); draw(); };
  $('btnSetA').onclick = () => setLoopPoint('a');
  $('btnSetB').onclick = () => setLoopPoint('b');
  $('btnLoop').onclick = () => {
    if (state.loop.a != null && state.loop.b != null) {
      state.loop.enabled = !state.loop.enabled;
      if (state.loop.enabled && (state.playFrom < state.loop.a || state.playFrom >= state.loop.b)) state.playFrom = state.loop.a;
      updateLoopUI();
      draw();
    }
  };
  $('btnClearLoop').onclick = clearLoop;

  // Settings: tolerance is display-only; the rest change the analysis.
  const tol = $('setTolerance');
  tol.oninput = () => {
    state.settings.toleranceCents = +tol.value;
    $('outTolerance').textContent = `±${tol.value}¢`;
    renderReports();
    draw();
  };
  bindReanalyse($('setMinNote'), $('outMinNote'), (v) => {
    state.settings.minNoteMs = +v;
    return `${v} ms`;
  });
  bindReanalyse($('setSilence'), $('outSilence'), (v) => {
    state.settings.silenceDropDb = +v;
    return `−${v} dB`;
  });
  $('setRange').onchange = (e) => {
    const [lo, hi] = e.target.value.split(',').map(Number);
    state.settings.fMin = lo;
    state.settings.fMax = hi;
    reanalyseAll();
  };

  wirePlotPointer();
  wireDropTarget();
  wireKeyboard();

  const ro = new ResizeObserver(() => draw());
  ro.observe($('plotWrap'));
}

function bindReanalyse(input, output, apply) {
  let timer = null;
  input.oninput = () => {
    output.textContent = apply(input.value);
    clearTimeout(timer);
    // Debounce: a full re-analysis per slider pixel would be unusable.
    timer = setTimeout(reanalyseAll, 320);
  };
}

function wirePlotPointer() {
  const canvas = $('plot');
  const wrap = $('plotWrap');
  let dragging = null;

  canvas.addEventListener('pointermove', (e) => {
    if (dragging) {
      const dx = e.clientX - dragging.x;
      const dy = e.clientY - dragging.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragging.moved = true;
      if (dragging.kind === 'pan') {
        const span = plot.view.t1 - plot.view.t0;
        const dt = (dx / plot.plotRect.w) * span;
        plot.view.t0 = dragging.t0 - dt;
        plot.view.t1 = dragging.t1 - dt;
        plot.clampTime();
        if (plot.mode === 'pitch') {
          const semis = (dy / plot.plotRect.h) * (dragging.midiHi - dragging.midiLo);
          plot.view.midiLo = dragging.midiLo + semis;
          plot.view.midiHi = dragging.midiHi + semis;
        }
      } else if (dragging.kind === 'select') {
        const box = canvas.getBoundingClientRect();
        const x0 = Math.max(plot.plotRect.x, Math.min(dragging.startX, e.clientX - box.left));
        const x1 = Math.min(plot.plotRect.x + plot.plotRect.w, Math.max(dragging.startX, e.clientX - box.left));
        const y0 = Math.max(plot.plotRect.y, Math.min(dragging.startY, e.clientY - box.top));
        const y1 = Math.min(plot.plotRect.y + plot.plotRect.h, Math.max(dragging.startY, e.clientY - box.top));
        plot.selection = { x0, y0, x1, y1 };
      }
      draw();
      return;
    }
    updateReadout(e.clientX, e.clientY);
    draw();
  });

  canvas.addEventListener('pointerleave', () => {
    $('readout').hidden = true;
    plot.hover = null;
    draw();
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const box = canvas.getBoundingClientRect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    dragging = {
      x: e.clientX, y: e.clientY,
      t0: plot.view.t0, t1: plot.view.t1,
      midiLo: plot.view.midiLo, midiHi: plot.view.midiHi,
      moved: false,
      downAt: performance.now(),
      kind: e.button === 0 ? 'select' : 'pan',
      startX: px, startY: py,
    };
    wrap.classList.add(e.button === 0 ? 'selecting' : 'dragging');
  });

  canvas.addEventListener('pointerup', (e) => {
    const finished = dragging;
    const wasDrag = finished && finished.moved;
    dragging = null;
    wrap.classList.remove('dragging');
    wrap.classList.remove('selecting');
    if (finished?.kind === 'select') {
      if (wasDrag && plot.selection) {
        const box = canvas.getBoundingClientRect();
        const r = plot.plotRect;
        const x0 = Math.max(r.x, Math.min(plot.selection.x0, plot.selection.x1));
        const x1 = Math.min(r.x + r.w, Math.max(plot.selection.x0, plot.selection.x1));
        const t0 = plot.xToTime(x0);
        const t1 = plot.xToTime(x1);
        const padT = Math.max(0.02, (t1 - t0) * 0.05);
        plot.view.t0 = Math.max(0, t0 - padT);
        plot.view.t1 = Math.min(plot.fullDuration || t1, t1 + padT);
        if (plot.mode === 'pitch') {
          const y0 = Math.max(r.y, Math.min(plot.selection.y0, plot.selection.y1));
          const y1 = Math.min(r.y + r.h, Math.max(plot.selection.y0, plot.selection.y1));
          const v0 = plot.yToValue(y1);
          const v1 = plot.yToValue(y0);
          const padY = Math.max(0.5, (v1 - v0) * 0.05);
          plot.view.midiLo = v0 - padY;
          plot.view.midiHi = v1 + padY;
        }
        plot.clampTime();
      }
      plot.selection = null;
      draw();
      return;
    }
    // Middle-button click seeks; middle-button drag pans the view.
    if (!wasDrag && state.tracks.length) {
      const box = canvas.getBoundingClientRect();
      const t = plot.xToTime(e.clientX - box.left);
      state.playFrom = Math.max(0, t);
      plot.playhead = state.playFrom;
      if (state.playing) startPlayback();
      updateTimeDisplay();
      draw();
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const box = canvas.getBoundingClientRect();
    const r = plot.plotRect;
    const ratio = Math.max(0, Math.min(1, (e.clientX - box.left - r.x) / r.w));
    if (e.altKey) {
      plot.zoomPitch(e.deltaY > 0 ? 1.12 : 1 / 1.12);
    } else if (e.shiftKey) {
      plot.panPitch(e.deltaY > 0 ? -1 : 1);
    } else if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      plot.zoomTime(e.deltaY > 0 ? 1.12 : 1 / 1.12, ratio);
    } else {
      plot.panTime(e.deltaX > 0 ? 0.05 : -0.05);
    }
    draw();
  }, { passive: false });
  // Disable the browser context menu only inside this application canvas.
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function wireDropTarget() {
  const wrap = $('plotWrap');
  let depth = 0;
  wrap.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    wrap.classList.add('drop-active');
  });
  wrap.addEventListener('dragover', (e) => e.preventDefault());
  wrap.addEventListener('dragleave', () => {
    if (--depth <= 0) { depth = 0; wrap.classList.remove('drop-active'); }
  });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    wrap.classList.remove('drop-active');
    const files = [...e.dataTransfer.files].filter((f) => /audio|\.(wav|mp3|flac|m4a|aac|ogg|opus|aiff?)$/i.test(f.type + f.name));
    if (!files.length) return;
    // Dropping two at once sets up a comparison in one gesture.
    loadFile(files[0], state.tracks.some((t) => t.slot === 0) && files.length === 1 && state.advanced ? 1 : 0);
    if (files[1]) {
      setAdvanced(true);
      loadFile(files[1], 1);
    }
  });
}

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const big = e.shiftKey ? 3 : 1;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft': e.preventDefault(); plot.panTime(-0.08 * big); draw(); break;
      case 'ArrowRight': e.preventDefault(); plot.panTime(0.08 * big); draw(); break;
      case 'ArrowUp': e.preventDefault(); plot.panPitch(big); draw(); break;
      case 'ArrowDown': e.preventDefault(); plot.panPitch(-big); draw(); break;
      case '+': case '=': plot.zoomTime(0.6); draw(); break;
      case '-': case '_': plot.zoomTime(1 / 0.6); draw(); break;
      case '0': plot.autoRange(); draw(); break;
      case '1': toggleTrack(0); break;
      case '2': toggleTrack(1); break;
      default: {
        const k = e.key.toLowerCase();
        if (k === 'o') {
          e.preventDefault();
          if (e.shiftKey) { setAdvanced(true); $('fileB').click(); }
          else $('fileA').click();
        } else if (k === 'd') {
          setMode(plot.mode === 'pitch' ? 'deviation' : 'pitch');
        } else if (k === 'n') {
          $('chkNotes').checked = !$('chkNotes').checked;
          plot.showNotes = $('chkNotes').checked;
          draw();
        } else if (k === 't') {
          $('chkTolerance').checked = !$('chkTolerance').checked;
          plot.showTolerance = $('chkTolerance').checked;
          draw();
        } else if (k === 'x') {
          setAdvanced(!state.advanced);
        } else if (e.key === '?' || k === '/') {
          $('helpModal').hidden = !$('helpModal').hidden;
        } else if (e.key === 'Escape') {
          $('helpModal').hidden = true;
        }
      }
    }
  });
}

wireUp();
render();

// Exposed for the browser-driven integration test.
window.__pitchScope = { state, plot, loadFile };
