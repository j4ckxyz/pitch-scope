/* app.js: file loading, playback, interaction, and the report panel. */

import { PitchPlot, TRACK_COLORS } from './plot.js';
import { midiToName, centsOffGrid } from './music.js';

const $ = (id) => document.getElementById(id);

let language = localStorage.getItem('pitchScopeLanguage') === 'en' ? 'en' : 'zh';

const UI_TEXT = {
  zh: {
    title: 'Pitch Scope：人声音高分析', languageButton: 'English', languageLabel: '切换语言', viewMode: '视图模式', loopGroup: 'AB循环', pitchLock: '锁定音高范围', pitchLocked: '音高范围已锁定', mixerTitle: '播放混音', leftTrack: '左声道音轨', leftVolume: '左声道音量', leftDelay: '左声道对齐偏移', rightTrack: '右声道音轨', rightVolume: '右声道音量', rightDelay: '右声道对齐偏移', align: '自动对齐两条音轨', fitButton: '还原', open: '打开人声', compare: '添加对比音轨', advanced: '高级',
    emptyTitle: '拖入人声音轨以查看音准', emptyDescription: '人声唱出的每个音符都会显示在半音网格上。静音部分会留白。如果曲线几乎贴着网格线，这段录音可能经过了修音。', chooseFile: '选择音频文件',
    isolated: '请使用<strong>独立人声</strong>：人声音轨、清唱或独奏轨道。完整混音会优先识别最响的乐器，而不是歌手。', demo: '手边没有音轨？<button class="linkish" id="btnDemo">加载示例对比</button>查看同一句自然演唱与强制修音的差异。', privacy: '音频仅在当前浏览器中分析，不会上传。',
    pitch: '音高', deviation: '偏差（音分）', notes: '音符块', toleranceBand: '音准范围', sidebarEmpty: '加载人声后可查看音准报告。', settings: '分析设置', tolerance: '音准容差', minNote: '计入的最短音符', silence: '静音阈值', range: '人声范围', settingsNote: '修改后会重新分析已加载的音轨。',
    disclaimer: '这些是统计指标，不是结论。精准音准可能来自修音、优秀歌手或拼接录音。分数较高时请结合试听判断。', help: '键盘快捷键', close: '关闭', graph: '如何阅读曲线', graphPitch: '在<strong>音高</strong>视图中，每条水平线代表一个半音。自然人声通常会在网格线周围摆动、滑入音符并产生颤音；修音会让曲线贴近网格。', graphDeviation: '<strong>偏差（音分）</strong>视图会减去最近音符，让整段演唱落在同一音阶上。修音录音会贴近零线，未经处理的录音则会在 ±50 音分范围内变化。',
    ranges: { full: '完整范围（C2–C6）', low: '低音／男低音', mid: '中音／男高音至女低音', high: '高音／女高音' },
    helpKeys: { open: '打开人声音轨', compare: '添加对比音轨', play: '播放／暂停', time: '按时间平移（<kbd>⇧</kbd>加大步长）', pitch: '上下移动音高范围', zoom: '放大／缩小时间', fit: '还原默认视图', ctrlPitch: '缩小／放大音高范围', ctrlTime: '扩大／缩小时间范围', ctrlFit: '还原默认视图', loop: '设置循环起点和终点；AB 循环开始播放', leftKey: '左键', left: '拖动视图；短按定位播放条', middleKey: '中键', middle: '拖出矩形区域并放大到该区域', deviation: '切换音高／音分偏差视图', notes: '显示音符块', tolerance: '显示音准范围', tracks: '显示／隐藏音轨 1 或 2', advanced: '高级控制', help: '打开本说明' },
  },
  en: {
    title: 'Pitch Scope: pitch-correction inspector for vocal stems', languageButton: '中文', languageLabel: 'Switch language', viewMode: 'View mode', loopGroup: 'AB loop', pitchLock: 'Lock pitch range', pitchLocked: 'Pitch range is locked', mixerTitle: 'Playback mixer', leftTrack: 'Left channel track', leftVolume: 'Left channel volume', leftDelay: 'Left alignment offset', rightTrack: 'Right channel track', rightVolume: 'Right channel volume', rightDelay: 'Right alignment offset', align: 'Auto-align two tracks', fitButton: 'Reset', open: 'Open vocal', compare: 'Add comparison', advanced: 'Advanced',
    emptyTitle: 'Drop a vocal stem to see its tuning', emptyDescription: 'Every note the voice sings is plotted against the semitone grid. Silence is left blank. If the line sits dead on the gridlines, the take has probably been tuned.', chooseFile: 'Choose an audio file',
    isolated: 'Use an <strong>isolated vocal</strong>: a stem, an acapella, or a soloed track. A full mix will read the loudest instrument, not the singer.', demo: 'No stem to hand? <button class="linkish" id="btnDemo">Load an example pair</button> with the same phrase sung naturally and hard-tuned.', privacy: 'Audio is analysed in this browser. Nothing is uploaded.',
    pitch: 'Pitch', deviation: 'Cents off', notes: 'Note blocks', toleranceBand: 'In-tune band', sidebarEmpty: 'Load a vocal to see its tuning report.', settings: 'Analysis settings', tolerance: 'In-tune tolerance', minNote: 'Shortest note counted', silence: 'Silence threshold', range: 'Voice range', settingsNote: 'Changing these re-analyses the loaded tracks.',
    disclaimer: 'These are statistical indicators, not proof. Tight tuning can mean pitch correction, an exceptional singer, or a comped take. Treat a high score as a reason to listen closely, not as a verdict.', help: 'Keyboard shortcuts', close: 'Close', graph: 'Reading the graph', graphPitch: 'In <strong>Pitch</strong> view each horizontal line is a semitone. A voice normally weaves around those lines, scooping into notes, drifting, and adding vibrato. Pitch correction pulls the line flat onto the grid.', graphDeviation: '<strong>Cents off</strong> view subtracts the nearest note, so the whole performance collapses onto one scale. A corrected take hugs the zero line; an untreated one wanders across the full ±50 range.',
    ranges: { full: 'Full voice (C2–C6)', low: 'Low / bass–baritone', mid: 'Mid / tenor–alto', high: 'High / soprano' },
    helpKeys: { open: 'Open a vocal track', compare: 'Add a comparison track', play: 'Play / pause', time: 'Scroll through time (<kbd>⇧</kbd> for a bigger step)', pitch: 'Move the pitch range', zoom: 'Zoom in / out', fit: 'Fit the whole track', ctrlPitch: 'Zoom the pitch range in / out', ctrlTime: 'Expand / shrink the time range', ctrlFit: 'Reset the view', loop: 'Set the loop start and end, then play the AB loop', leftKey: 'Left button', left: 'Drag to pan; click to move the playhead', middleKey: 'Middle button', middle: 'Drag a rectangle to zoom into that area', deviation: 'Switch pitch / cents-off view', notes: 'Show note blocks', tolerance: 'Show the in-tune band', tracks: 'Show / hide track 1 or 2', advanced: 'Advanced controls', help: 'This list' },
  },
};

function text(key) {
  return UI_TEXT[language][key];
}

function updatePitchLockButton() {
  const button = $('btnPitchLock');
  if (!button) return;
  button.setAttribute('aria-pressed', String(state.pitchLocked));
  button.setAttribute('aria-label', state.pitchLocked ? text('pitchLocked') : text('pitchLock'));
  button.title = state.pitchLocked ? text('pitchLocked') : text('pitchLock');
}

function allowPitchAdjustment() {
  if (!state.pitchLocked) return true;
  const message = language === 'zh'
    ? '当前音高范围已锁定。点击“确定”取消锁定并继续调整，点击“取消”保持锁定。'
    : 'The pitch range is locked. Choose OK to unlock and adjust, or Cancel to keep it locked.';
  if (window.confirm(message)) {
    state.pitchLocked = false;
    updatePitchLockButton();
    schedulePersistSession();
    return true;
  }
  return false;
}

function applyLanguage(next = language) {
  language = next;
  localStorage.setItem('pitchScopeLanguage', language);
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.title = text('title');
  const set = (id, key, html = false) => {
    const node = $(id);
    if (!node) return;
    if (html) node.innerHTML = text(key);
    else if (node.querySelector('kbd')) node.childNodes[0].textContent = text(key);
    else node.textContent = text(key);
  };
  set('btnOpenA', 'open'); set('btnOpenB', 'compare'); set('btnAdvanced', 'advanced'); set('btnLanguage', 'languageButton');
  set('emptyTitle', 'emptyTitle'); set('emptyDescription', 'emptyDescription'); set('btnOpenEmpty', 'chooseFile'); set('emptyNoteIsolated', 'isolated', true); set('emptyNoteDemo', 'demo', true); set('emptyNotePrivacy', 'privacy');
  set('modePitchText', 'pitch'); set('modeDeviationText', 'deviation'); set('chkNotesText', 'notes'); set('chkToleranceText', 'toleranceBand'); set('sidebarEmptyText', 'sidebarEmpty'); set('settingsTitle', 'settings'); set('settingToleranceText', 'tolerance'); set('settingMinNoteText', 'minNote'); set('settingSilenceText', 'silence'); set('settingRangeText', 'range'); set('settingsNote', 'settingsNote'); set('disclaimerText', 'disclaimer'); set('helpTitle', 'help'); set('btnCloseHelp', 'close'); set('helpGraphTitle', 'graph'); set('helpGraphPitch', 'graphPitch', true); set('helpGraphDeviation', 'graphDeviation', true);
  set('mixerTitle', 'mixerTitle'); set('mixerLeftLabel', 'leftTrack'); set('mixerLeftVolumeLabel', 'leftVolume'); set('mixerLeftDelayLabel', 'leftDelay'); set('mixerRightLabel', 'rightTrack'); set('mixerRightVolumeLabel', 'rightVolume'); set('mixerRightDelayLabel', 'rightDelay'); set('btnAlignTracks', 'align'); set('fitText', 'fitButton');
  for (const node of document.querySelectorAll('[data-help-key]')) { const key = node.dataset.helpKey; if (text('helpKeys')[key]) node.innerHTML = text('helpKeys')[key]; }
  for (const option of document.querySelectorAll('[data-range-key]')) option.textContent = text('ranges')[option.dataset.rangeKey];
  if ($('btnDemo')) $('btnDemo').onclick = loadDemoPair;
  $('viewModeGroup').setAttribute('aria-label', text('viewMode'));
  $('loopGroup').setAttribute('aria-label', text('loopGroup'));
  $('btnLanguage').setAttribute('aria-label', text('languageLabel'));
  const aria = language === 'zh'
    ? ['缩小时间', '放大时间', '缩小音高范围', '放大音高范围', '还原默认视图', '清除AB循环']
    : ['Zoom out in time', 'Zoom in in time', 'Zoom out pitch range', 'Zoom in pitch range', 'Reset view', 'Clear AB loop'];
  ['btnZoomOut', 'btnZoomIn', 'btnPitchZoomOut', 'btnPitchZoomIn', 'btnFit', 'btnClearLoop'].forEach((id, i) => $(id).setAttribute('aria-label', aria[i]));
  $('btnHelp').setAttribute('aria-label', text('help'));
  $('btnCloseHelp').setAttribute('aria-label', text('close'));
  updatePitchLockButton();
  renderChips(); renderReports(); renderMixer(); updateLoopUI(); updateTransport(); draw();
}

const state = {
  tracks: [], // { id, name, buffer, result, color, visible, slot }
  advanced: false,
  playing: false,
  playFrom: 0,
  playStartedAt: 0,
  loop: { a: null, b: null, enabled: false },
  mixer: { leftSlot: 0, rightSlot: 0, leftGain: 1, rightGain: 1, leftDelayMs: 0, rightDelayMs: 0 },
  pitchLocked: false,
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
let sourceNodes = [];
let mixerNodes = [];
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
    const sourceData = bytesToBase64(new Uint8Array(arrayBuf.slice(0)));
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
      sourceData,
    };
    if (existing >= 0) state.tracks[existing] = track;
    else state.tracks.push(track);
    state.tracks.sort((a, b) => a.slot - b.slot);
    if (slot === 1 && state.mixer.rightSlot === 0) state.mixer.rightSlot = 1;

    stopPlayback();
    clearLoop();
    updatePlotTracks();
    render();
    await persistSession();
  } catch (err) {
    hideProgress();
    reportError(file.name, err);
  }
}

function updatePlotTracks() {
  const previousView = { ...plot.view };
  const canRefit = !state.pitchLocked || !state.tracks.length || allowPitchAdjustment();
  plot.setTracks(state.tracks);
  if (!canRefit) plot.view = previousView;
}

function reportError(name, err) {
  const msg = /decode|Unable to decode/i.test(String(err && err.message))
    ? (language === 'zh' ? `无法解码“${name}”。请尝试 WAV、MP3、FLAC、M4A 或 OGG。` : `Could not decode “${name}”. Try WAV, MP3, FLAC, M4A or OGG.`)
    : (language === 'zh' ? `无法分析“${name}”：${err && err.message ? err.message : err}` : `Could not analyse “${name}”: ${err && err.message ? err.message : err}`);
  const box = $('errorBox');
  box.textContent = msg;
  box.hidden = false;
}

function clearError() {
  $('errorBox').hidden = true;
  $('errorBox').textContent = '';
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function serializeResult(result) {
  return {
    ...result,
    time: Array.from(result.time),
    midi: Array.from(result.midi),
    rms: Array.from(result.rms),
    aperiodicity: Array.from(result.aperiodicity),
    report: { ...result.report, histogram: Array.from(result.report.histogram) },
  };
}

function deserializeResult(result) {
  return {
    ...result,
    time: Float64Array.from(result.time),
    midi: Float64Array.from(result.midi),
    rms: Float64Array.from(result.rms),
    aperiodicity: Float64Array.from(result.aperiodicity),
    report: { ...result.report, histogram: Float64Array.from(result.report.histogram) },
  };
}

async function persistSession() {
  const tracks = state.tracks.map((track) => ({
    name: track.name,
    slot: track.slot,
    visible: track.visible,
    sourceData: track.sourceData,
    result: serializeResult(track.result),
  }));
  try {
    await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks, mixer: state.mixer, pitchLocked: state.pitchLocked }),
    });
  } catch {
    // A different static server, such as npx serve, has no session endpoint.
  }
}

let persistTimer = null;
function schedulePersistSession() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistSession();
  }, 250);
}

async function restoreSession() {
  try {
    const response = await fetch('/api/session');
    if (!response.ok) return;
    const saved = await response.json();
    if (!Array.isArray(saved.tracks) || !saved.tracks.length) return;
    if (saved.mixer) state.mixer = { ...state.mixer, ...saved.mixer };
    state.pitchLocked = saved.pitchLocked === true;
    for (const savedTrack of saved.tracks) {
      const bytes = base64ToBytes(savedTrack.sourceData);
      const buffer = await ensureAudioCtx().decodeAudioData(bytes.buffer.slice(0));
      state.tracks.push({
        id: `${savedTrack.slot}-${Date.now()}-${Math.random()}`,
        name: savedTrack.name,
        buffer,
        result: deserializeResult(savedTrack.result),
        color: TRACK_COLORS[savedTrack.slot],
        visible: savedTrack.visible !== false,
        slot: savedTrack.slot,
        sourceData: savedTrack.sourceData,
      });
    }
    state.tracks.sort((a, b) => a.slot - b.slot);
    updatePlotTracks();
    render();
  } catch {
    // Empty session or a static server without persistence is a valid state.
  }
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
  updatePlotTracks();
  render();
  persistSession();
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
  updatePlotTracks();
  render();
  persistSession();
}

/* ---------- playback ---------- */

function playbackTrack() {
  return state.tracks.find((t) => t.slot === state.mixer.leftSlot)
    || state.tracks.find((t) => t.visible)
    || state.tracks[0]
    || null;
}

function mixerTrack(slot) {
  return state.tracks.find((t) => t.slot === slot) || null;
}

function playbackDuration() {
  const channels = [
    [mixerTrack(state.mixer.leftSlot), state.mixer.leftDelayMs],
    [mixerTrack(state.mixer.rightSlot), state.mixer.rightDelayMs],
  ];
  let duration = 0;
  for (const [track, delayMs] of channels) {
    if (track) duration = Math.max(duration, track.buffer.duration + delayMs / 1000);
  }
  return Math.max(0, duration);
}

function restartPlaybackAtCurrentTime() {
  if (state.playing) startPlayback(currentPlayTime());
  else updateTimeDisplay();
  draw();
}

function setMixerTrack(channel, value) {
  state.mixer[`${channel}Slot`] = Number(value);
  restartPlaybackAtCurrentTime();
  renderMixer();
  schedulePersistSession();
}

function setMixerVolume(channel, value) {
  const gain = Number(value) / 100;
  state.mixer[`${channel}Gain`] = gain;
  const channelIndex = channel === 'left' ? 0 : 1;
  for (const node of mixerNodes) if (node.channel === channelIndex) node.gain.gain.value = gain;
  renderMixer();
  schedulePersistSession();
}

function setMixerDelay(channel, value) {
  state.mixer[`${channel}DelayMs`] = Number(value);
  restartPlaybackAtCurrentTime();
  renderMixer();
  schedulePersistSession();
}

function autoAlignTracks() {
  const left = mixerTrack(state.mixer.leftSlot);
  const right = mixerTrack(state.mixer.rightSlot);
  if (!left || !right || left === right) return;
  const a = left.buffer.getChannelData(0);
  const b = right.buffer.getChannelData(0);
  const sampleRate = left.buffer.sampleRate;
  const lagLimit = Math.round(sampleRate * 5);
  const lagStep = Math.max(1, Math.round(sampleRate * 0.01));
  const sampleStep = Math.max(1, Math.round(sampleRate * 0.02));
  const window = Math.min(a.length, b.length, Math.round(sampleRate * 20));
  let bestLag = 0;
  let bestScore = -Infinity;

  for (let lag = -lagLimit; lag <= lagLimit; lag += lagStep) {
    const startA = Math.max(0, lag);
    const startB = Math.max(0, -lag);
    const count = Math.min(window - startA, b.length - startB);
    if (count < sampleRate) continue;
    let sumA = 0;
    let sumB = 0;
    let sumAA = 0;
    let sumBB = 0;
    let sumAB = 0;
    for (let offset = 0; offset < count; offset += sampleStep) {
      const av = a[startA + offset];
      const bv = b[startB + offset];
      sumA += av;
      sumB += bv;
      sumAA += av * av;
      sumBB += bv * bv;
      sumAB += av * bv;
    }
    const n = Math.max(1, Math.floor(count / sampleStep));
    const covariance = sumAB - (sumA * sumB) / n;
    const variance = Math.sqrt((sumAA - (sumA * sumA) / n) * (sumBB - (sumB * sumB) / n));
    const score = variance > 0 ? covariance / variance : -Infinity;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  state.mixer.rightDelayMs = Math.round((-bestLag * 1000) / sampleRate / 10) * 10;
  renderMixer();
  restartPlaybackAtCurrentTime();
  schedulePersistSession();
}

function togglePlay() {
  if (state.playing) stopPlayback();
  else startPlayback();
}

function startPlayback(offsetOverride = null) {
  if (!playbackTrack()) return;
  const ctx = ensureAudioCtx();
  stopPlayback();

  const requested = offsetOverride == null ? state.playFrom : offsetOverride;
  const offset = Math.max(0, Math.min(requested, Math.max(0, playbackDuration() - 0.01)));
  const channels = [
    [mixerTrack(state.mixer.leftSlot), state.mixer.leftGain, state.mixer.leftDelayMs, -1],
    [mixerTrack(state.mixer.rightSlot), state.mixer.rightGain, state.mixer.rightDelayMs, 1],
  ];
  for (const [channel, [track, gainValue, delayMs, panValue]] of channels.entries()) {
    if (!track) continue;
    const delay = delayMs / 1000;
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    source.buffer = track.buffer;
    gain.gain.value = gainValue;
    pan.pan.value = panValue;
    source.connect(gain).connect(pan).connect(ctx.destination);
    const when = ctx.currentTime + Math.max(0, delay);
    const bufferOffset = Math.max(0, offset - Math.min(0, delay));
    if (bufferOffset < track.buffer.duration) {
      source.start(when, bufferOffset);
      sourceNodes.push(source);
      mixerNodes.push({ channel, gain, pan });
    }
  }
  if (!sourceNodes.length) return;
  state.playing = true;
  state.playFrom = offset;
  state.playStartedAt = ctx.currentTime - offset;
  updateTransport();
  tickPlayhead();
}

function stopPlayback() {
  for (const source of sourceNodes) {
    try { source.stop(); } catch { /* already stopped */ }
    source.disconnect();
  }
  sourceNodes = [];
  mixerNodes = [];
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
  renderMixer();
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
    eye.title = language === 'zh' ? `显示或隐藏（${track.slot + 1}）` : `Show or hide (${track.slot + 1})`;
    eye.setAttribute('aria-label', language === 'zh' ? `切换 ${track.name}` : `Toggle ${track.name}`);
    eye.onclick = () => toggleTrack(track.slot);

    const close = document.createElement('button');
    close.className = 'chip-btn';
    close.textContent = '✕';
    close.title = language === 'zh' ? '移除音轨' : 'Remove track';
    close.setAttribute('aria-label', language === 'zh' ? `移除 ${track.name}` : `Remove ${track.name}`);
    close.onclick = () => removeTrack(track.slot);

    chip.append(sw, name, eye, close);
    strip.append(chip);
  }
}

function renderMixer() {
  const block = $('mixerBlock');
  if (!block) return;
  block.hidden = state.tracks.length === 0;
  const options = state.tracks.map((track) => ({ value: String(track.slot), label: track.name }));
  const availableSlots = state.tracks.map((track) => track.slot);
  if (availableSlots.length && !availableSlots.includes(state.mixer.leftSlot)) state.mixer.leftSlot = availableSlots[0];
  if (availableSlots.length && !availableSlots.includes(state.mixer.rightSlot)) state.mixer.rightSlot = availableSlots[Math.min(1, availableSlots.length - 1)];
  for (const [id, selected] of [['mixerLeftTrack', state.mixer.leftSlot], ['mixerRightTrack', state.mixer.rightSlot]]) {
    const select = $(id);
    const previous = String(selected);
    select.innerHTML = '';
    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      select.append(node);
    }
    if (options.length) select.value = options.some((option) => option.value === previous) ? previous : options[0].value;
    select.disabled = options.length === 0;
  }
  $('mixerLeftVolume').value = Math.round(state.mixer.leftGain * 100);
  $('mixerRightVolume').value = Math.round(state.mixer.rightGain * 100);
  $('mixerLeftDelay').value = state.mixer.leftDelayMs;
  $('mixerRightDelay').value = state.mixer.rightDelayMs;
  $('mixerLeftVolumeOut').textContent = `${Math.round(state.mixer.leftGain * 100)}%`;
  $('mixerRightVolumeOut').textContent = `${Math.round(state.mixer.rightGain * 100)}%`;
  $('mixerLeftDelayOut').textContent = `${state.mixer.leftDelayMs} ms`;
  $('mixerRightDelayOut').textContent = `${state.mixer.rightDelayMs} ms`;
  $('btnAlignTracks').disabled = state.tracks.length < 2;
}

function renderReports() {
  const host = $('reports');
  host.innerHTML = '';
  for (const track of state.tracks) {
    if (!track.result) continue;
    host.append(buildReport(track));
  }
}

function localizedVerdict(report) {
  if (language === 'zh') return report.verdict;
  const labels = { unknown: 'Not enough material', high: 'Strong signs of pitch correction', mid: 'Some signs of pitch correction', low: 'Little sign of pitch correction', none: 'No sign of pitch correction' };
  const texts = { unknown: 'Too few sustained notes to say anything useful. Try a longer passage.', high: 'Pitch sits on the grid more precisely, and more consistently, than an unprocessed voice normally does.', mid: 'Tuning is tighter than typical, but a very accurate singer can look like this. Compare against another take before drawing conclusions.', low: 'Pitch moves the way an unprocessed voice usually moves. Light, transparent correction would not necessarily show up here.', none: 'Natural drift, scooping and vibrato are all present.' };
  return { label: labels[report.verdict.tone], text: texts[report.verdict.tone] };
}

function localizedComponent(component) {
  if (language === 'zh') return component;
  const labels = { accuracy: 'Note centres on grid', steadiness: 'Pitch held still within notes', snap: 'Note-to-note transition speed', quantisation: 'Time parked on exact pitches' };
  const detail = component.key === 'accuracy'
    ? `${component.detail.replace(' 音分：音符中心离散度', '')} cents spread across note centres`
    : component.key === 'steadiness'
      ? `${component.detail.replace(' 音分：音符内部典型变化', '')} cents typical movement inside a note`
      : component.key === 'snap'
        ? component.detail === '音符变化不足，无法判断' ? 'not enough note changes to judge' : component.detail.replace(' 毫秒：最快半音过渡时间', ' ms to move a semitone at the fastest point')
        : component.detail.replace('% 的演唱帧在 10 音分以内', '% of sung frames within 10 cents');
  return { label: labels[component.key], detail };
}

function buildReport(track) {
  const { report, tuning, notes, duration } = track.result;
  const verdictText = localizedVerdict(report);
  const root = el('div', 'report');

  const head = el('div', 'report-head');
  const sw = el('span', 'chip-swatch');
  sw.style.background = track.color.line;
  const title = el('span', 'report-title', track.name);
  title.title = track.name;
  head.append(sw, title);

  const body = el('div', 'report-body');

  const verdict = el('div', `verdict tone-${report.verdict.tone}`, verdictText.label);
  const vtext = el('p', 'verdict-text', verdictText.text);

  const scoreLine = el('div', 'score-line');
  scoreLine.append(
    el('span', 'score-value', Math.round(report.score * 100)),
    el('span', 'score-label', language === 'zh' ? '/ 100 修音可能性' : '/ 100 correction likelihood'),
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
      const componentText = localizedComponent(c);
      label.append(el('b', '', componentText.label), el('span', '', `${Math.round(c.score * 100)}`));
      const bar = el('div', 'component-bar');
      const bf = el('div', 'component-fill');
      bf.style.width = `${Math.max(1, c.score * 100)}%`;
      bf.style.background = track.color.line;
      bar.append(bf);
      wrap.append(label, bar, el('div', 'component-detail', componentText.detail));
      comps.append(wrap);
    }
    body.append(comps);

    const facts = el('dl', 'facts');
    const factsText = language === 'zh'
      ? ['持续音符', '检测音符', '调音参考', '网格偏差', '时长']
      : ['Sustained notes', 'Notes found', 'Tuning reference', 'Grid offset', 'Length'];
    addFact(facts, factsText[0], `${report.sustainedNotes}`);
    addFact(facts, factsText[1], `${notes.length}`);
    addFact(facts, factsText[2], `A${tuning.a4.toFixed(1)} Hz`);
    addFact(facts, factsText[3], `${signed(tuning.appliedCents, 1)}¢`);
    addFact(facts, factsText[4], formatClock(duration));
    body.append(facts);

    const hist = el('div', 'hist-block');
    hist.append(el('div', 'hist-title', language === 'zh' ? '与最近音符的距离' : 'Distance from the nearest note'));
    const canvas = document.createElement('canvas');
    canvas.className = 'hist';
    hist.append(canvas);
    const axis = el('div', 'hist-axis');
    axis.append(el('span', '', '−50¢'), el('span', '', language === 'zh' ? '音准' : 'in tune'), el('span', '', '+50¢'));
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
  btn.setAttribute('aria-label', state.playing ? (language === 'zh' ? '暂停' : 'Pause') : (language === 'zh' ? '播放' : 'Play'));
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
  $('btnLoop').textContent = state.loop.enabled ? (language === 'zh' ? '停止 AB' : 'Stop AB') : (language === 'zh' ? 'AB 循环' : 'AB loop');
  $('btnSetA').textContent = a == null ? (language === 'zh' ? '设为 A' : 'Set A') : `A ${formatClock(a)}`;
  $('btnSetB').textContent = b == null ? (language === 'zh' ? '设为 B' : 'Set B') : `B ${formatClock(b)}`;
}

function updateTimeDisplay() {
  const track = playbackTrack();
  const dur = track ? playbackDuration() : 0;
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
      row.append(sw, el('span', 'readout-cents', language === 'zh' ? '静音' : 'silent'));
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
  const stages = language === 'zh'
    ? { 'Preparing audio': '准备音频', 'Tracking pitch': '跟踪音高', 'Reading notes': '读取音符', '准备音频': '准备音频', '跟踪音高': '跟踪音高', '读取音符': '读取音符', 'Decoding audio': '正在解码音频' }
    : { 'Preparing audio': 'Preparing audio', 'Tracking pitch': 'Tracking pitch', 'Reading notes': 'Reading notes', '准备音频': 'Preparing audio', '跟踪音高': 'Tracking pitch', '读取音符': 'Reading notes', '正在解码音频': 'Decoding audio' };
  $('progressLabel').textContent = stages[stage] || stage;
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
  $('btnLanguage').onclick = () => applyLanguage(language === 'zh' ? 'en' : 'zh');
  $('btnPitchLock').onclick = () => {
    state.pitchLocked = !state.pitchLocked;
    updatePitchLockButton();
    schedulePersistSession();
  };
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
  $('btnPitchZoomIn').onclick = () => { if (allowPitchAdjustment()) { plot.zoomPitch(0.7); draw(); } };
  $('btnPitchZoomOut').onclick = () => { if (allowPitchAdjustment()) { plot.zoomPitch(1 / 0.7); draw(); } };
  $('btnFit').onclick = () => { if (allowPitchAdjustment()) { plot.resetView(); draw(); } };
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
  $('mixerLeftTrack').onchange = (e) => setMixerTrack('left', e.target.value);
  $('mixerRightTrack').onchange = (e) => setMixerTrack('right', e.target.value);
  $('mixerLeftVolume').oninput = (e) => setMixerVolume('left', e.target.value);
  $('mixerRightVolume').oninput = (e) => setMixerVolume('right', e.target.value);
  $('mixerLeftDelay').oninput = (e) => setMixerDelay('left', e.target.value);
  $('mixerRightDelay').oninput = (e) => setMixerDelay('right', e.target.value);
  $('btnAlignTracks').onclick = autoAlignTracks;

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
          if (Math.abs(dy) > 3 && dragging.pitchAllowed == null) dragging.pitchAllowed = allowPitchAdjustment();
          if (dragging.pitchAllowed !== false) {
            const semis = (dy / plot.plotRect.h) * (dragging.midiHi - dragging.midiLo);
            plot.view.midiLo = dragging.midiLo + semis;
            plot.view.midiHi = dragging.midiHi + semis;
          }
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
      kind: e.button === 0 ? 'pan' : 'select',
      startX: px, startY: py,
      pitchAllowed: null,
    };
    wrap.classList.add(e.button === 0 ? 'dragging' : 'selecting');
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
          if (Math.abs(y1 - y0) > 3 && allowPitchAdjustment()) {
            const v0 = plot.yToValue(y1);
            const v1 = plot.yToValue(y0);
            const padY = Math.max(0.5, (v1 - v0) * 0.05);
            plot.view.midiLo = v0 - padY;
            plot.view.midiHi = v1 + padY;
          }
        }
        plot.clampTime();
      }
      plot.selection = null;
      draw();
      return;
    }
    // Left-button click seeks; left-button drag pans the view.
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
      if (allowPitchAdjustment()) plot.zoomPitch(e.deltaY > 0 ? 1.12 : 1 / 1.12);
    } else if (e.shiftKey) {
      if (allowPitchAdjustment()) plot.panPitch(e.deltaY > 0 ? -1 : 1);
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
    if (e.metaKey || e.altKey) return;

    if (e.ctrlKey) {
      switch (e.key) {
        case 'ArrowUp': e.preventDefault(); if (allowPitchAdjustment()) plot.zoomPitch(0.7); draw(); break;
        case 'ArrowDown': e.preventDefault(); if (allowPitchAdjustment()) plot.zoomPitch(1 / 0.7); draw(); break;
        case 'ArrowLeft': e.preventDefault(); plot.zoomTime(1.12); draw(); break;
        case 'ArrowRight': e.preventDefault(); plot.zoomTime(1 / 1.12); draw(); break;
        case 'z': case 'Z': e.preventDefault(); if (allowPitchAdjustment()) plot.resetView(); draw(); break;
        default: break;
      }
      return;
    }

    const big = e.shiftKey ? 3 : 1;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft': e.preventDefault(); plot.panTime(-0.08 * big); draw(); break;
      case 'ArrowRight': e.preventDefault(); plot.panTime(0.08 * big); draw(); break;
      case 'ArrowUp': e.preventDefault(); if (allowPitchAdjustment()) plot.panPitch(big); draw(); break;
      case 'ArrowDown': e.preventDefault(); if (allowPitchAdjustment()) plot.panPitch(-big); draw(); break;
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
applyLanguage(language);
render();
restoreSession();

// Exposed for the browser-driven integration test.
window.__pitchScope = { state, plot, loadFile };
