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
  showProgress('Decoding audio', 0.01);
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
    plot.setTracks(state.tracks);
    render();
  } catch (err) {
    hideProgress();
    reportError(file.name, err);
  }
}

function reportError(name, err) {
  const msg = /decode|Unable to decode/i.test(String(err && err.message))
    ? `Could not decode “${name}”. Try WAV, MP3, FLAC, M4A or OGG.`
    : `Could not analyse “${name}”: ${err && err.message ? err.message : err}`;
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

function startPlayback() {
  const track = playbackTrack();
  if (!track) return;
  const ctx = ensureAudioCtx();
  stopPlayback();

  const offset = Math.max(0, Math.min(state.playFrom, track.buffer.duration - 0.01));
  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = track.buffer;
  sourceNode.connect(ctx.destination);
  sourceNode.onended = () => {
    if (state.playing) {
      state.playing = false;
      state.playFrom = 0;
      plot.playhead = null;
      updateTransport();
      draw();
    }
  };
  sourceNode.start(0, offset);
  state.playing = true;
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
    plot.draw();
  });
}

function render() {
  renderChips();
  renderReports();
  $('empty').hidden = state.tracks.length > 0;
  $('sidebarEmpty').hidden = state.tracks.length > 0;
  $('btnPlay').disabled = !state.tracks.length;
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
    eye.title = `Show or hide (${track.slot + 1})`;
    eye.setAttribute('aria-label', `Toggle ${track.name}`);
    eye.onclick = () => toggleTrack(track.slot);

    const close = document.createElement('button');
    close.className = 'chip-btn';
    close.textContent = '✕';
    close.title = 'Remove track';
    close.setAttribute('aria-label', `Remove ${track.name}`);
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
    el('span', 'score-label', '/ 100 correction likelihood'),
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
    addFact(facts, 'Sustained notes', `${report.sustainedNotes}`);
    addFact(facts, 'Notes found', `${notes.length}`);
    addFact(facts, 'Tuning reference', `A${tuning.a4.toFixed(1)} Hz`);
    addFact(facts, 'Grid offset', `${signed(tuning.appliedCents, 1)}¢`);
    addFact(facts, 'Length', formatClock(duration));
    body.append(facts);

    const hist = el('div', 'hist-block');
    hist.append(el('div', 'hist-title', 'Distance from the nearest note'));
    const canvas = document.createElement('canvas');
    canvas.className = 'hist';
    hist.append(canvas);
    const axis = el('div', 'hist-axis');
    axis.append(el('span', '', '−50¢'), el('span', '', 'in tune'), el('span', '', '+50¢'));
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
      row.append(sw, el('span', 'readout-cents', 'silent'));
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
  $('btnFit').onclick = () => { plot.autoRange(); draw(); };

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
      const span = plot.view.t1 - plot.view.t0;
      const dt = (dx / plot.plotRect.w) * span;
      plot.view.t0 = dragging.t0 - dt;
      plot.view.t1 = dragging.t1 - dt;
      plot.clampTime();

      if (plot.mode === 'pitch') {
        const dy = e.clientY - dragging.y;
        const semis = (dy / plot.plotRect.h) * (dragging.midiHi - dragging.midiLo);
        plot.view.midiLo = dragging.midiLo + semis;
        plot.view.midiHi = dragging.midiHi + semis;
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
    canvas.setPointerCapture(e.pointerId);
    dragging = {
      x: e.clientX, y: e.clientY,
      t0: plot.view.t0, t1: plot.view.t1,
      midiLo: plot.view.midiLo, midiHi: plot.view.midiHi,
      moved: false,
      downAt: performance.now(),
    };
    wrap.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (e) => {
    if (dragging && (Math.abs(e.clientX - dragging.x) > 3 || Math.abs(e.clientY - dragging.y) > 3)) {
      dragging.moved = true;
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    const wasDrag = dragging && dragging.moved;
    dragging = null;
    wrap.classList.remove('dragging');
    // A click that didn't drag is a seek.
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
    if (e.shiftKey) {
      plot.panTime((e.deltaY > 0 ? 0.08 : -0.08));
    } else if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      plot.zoomTime(e.deltaY > 0 ? 1.12 : 1 / 1.12, ratio);
    } else {
      plot.panTime(e.deltaX > 0 ? 0.05 : -0.05);
    }
    draw();
  }, { passive: false });
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
