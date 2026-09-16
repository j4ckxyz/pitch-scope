/* Browser integration test: drives real Chrome over CDP.
 *
 * Usage: node test/browser.test.js [--keep] [--shots <dir>]
 * Requires the dev server on :8173 (npm start).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ORIGIN = 'http://localhost:8173';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotsDir = argValue('--shots') || '/tmp/pitchscope-shots';
const keep = process.argv.includes('--keep');

let failures = 0;
let checks = 0;

function check(name, cond, extra = '') {
  checks++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  (' + extra + ')' : ''}`);
  if (!cond) failures++;
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

/* ---------- minimal CDP client ---------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    this.consoleErrors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.consoleErrors.push(d.exception?.description || d.text);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  /** Evaluate in the page and return the JSON value. */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  /** Real mouse click at viewport coordinates. */
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(200);
  }

  /** Click an element by selector, using its real on-screen position. */
  async clickEl(selector) {
    const box = await this.eval(`
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    `);
    if (!box) throw new Error(`no element ${selector}`);
    await this.click(box.x, box.y);
  }

  /**
   * What the user would actually hit at this point, reported as the hit
   * element plus the ids of its ancestors. A click landing on a child of the
   * intended region still counts, but one landing on a stray overlay does not.
   */
  async elementAt(x, y) {
    return this.eval(`
      let e = document.elementFromPoint(${x}, ${y});
      if (!e) return null;
      const hit = e.id || e.className || e.tagName;
      const path = [];
      for (let n = e; n && n !== document.body; n = n.parentElement) {
        if (n.id) path.push(n.id);
      }
      return hit + (path.length ? ' [in ' + path.join(' < ') + ']' : '');
    `);
  }

  async key(key, code, keyCode, modifiers = 0) {
    for (const type of ['keyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', {
        type, key, code, modifiers,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
    }
    await sleep(120);
  }

  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(shotsDir, { recursive: true });
    const p = join(shotsDir, `${name}.png`);
    writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- boot ---------- */

async function main() {
  const userDir = `/tmp/pitchscope-chrome-${Date.now()}`;
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=9333',
    `--user-data-dir=${userDir}`,
    '--window-size=1440,900',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      const list = await fetch('http://localhost:9333/json/list').then((r) => r.json());
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('Chrome did not start');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new CDP(ws);

  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await runTests(cdp);
  } finally {
    if (!keep) {
      ws.close();
      chrome.kill();
    }
  }
}

/* ---------- the tests ---------- */

async function runTests(cdp) {
  console.log('\nPage load');
  await cdp.send('Page.navigate', { url: ORIGIN + '/index.html' });
  await sleep(1400);

  const title = await cdp.eval('return document.title');
  check('page loads', /Pitch Scope/.test(title), title);
  check('module graph evaluated', await cdp.eval('return !!window.__pitchScope'), '');
  check('empty state is visible', await cdp.eval('return !document.getElementById("empty").hidden'));

  // A hidden overlay that still has `display` set stays on top and eats every
  // click, so assert on real layout, not just the `hidden` property.
  const overlays = await cdp.eval(`
    return ['helpModal', 'progress'].map(id => {
      const e = document.getElementById(id);
      return { id, hidden: e.hidden, display: getComputedStyle(e).display };
    });
  `);
  for (const o of overlays) {
    check(`#${o.id} is not laid out while hidden`, o.display === 'none', `display: ${o.display}`);
  }
  const hitEmpty = String(await cdp.elementAt(600, 400));
  check('the empty state is what you hit before loading', /empty/.test(hitEmpty), hitEmpty);
  console.log(`  shot: ${await cdp.shot('01-empty')}`);

  console.log('\nLoad a natural vocal');
  await cdp.eval(`
    const res = await fetch('/samples/natural-vocal.wav');
    const blob = await res.blob();
    await window.__pitchScope.loadFile(new File([blob], 'natural-vocal.wav', { type: 'audio/wav' }), 0);
    return true;
  `);
  await sleep(500);

  const t1 = await cdp.eval(`
    const s = window.__pitchScope.state;
    const t = s.tracks[0];
    return {
      count: s.tracks.length,
      name: t && t.name,
      notes: t && t.result.notes.length,
      score: t && t.result.report.score,
      verdict: t && t.result.report.verdict.label,
      voiced: t ? [...t.result.midi].filter(Number.isFinite).length : 0,
      total: t ? t.result.midi.length : 0,
      a4: t && t.result.tuning.a4,
    };
  `);
  check('track loaded', t1.count === 1, t1.name);
  check('notes detected', t1.notes >= 10, `${t1.notes} notes`);
  check('silence left blank', t1.voiced > 0 && t1.voiced < t1.total * 0.92,
    `${t1.voiced}/${t1.total} frames voiced`);
  check('natural take reads as untreated', t1.score < 0.58, `${t1.score.toFixed(2)}, "${t1.verdict}"`);
  // A single stray frame draws a full-height spike across the plot, which reads
  // as a wild note the singer never sang.
  const spikes = await cdp.eval(`
    const m = window.__pitchScope.state.tracks[0].result.midi;
    let worst = 0, count = 0;
    for (let i = 1; i < m.length; i++) {
      if (!Number.isFinite(m[i]) || !Number.isFinite(m[i-1])) continue;
      const jump = Math.abs(m[i] - m[i-1]);
      if (jump > worst) worst = jump;
      if (jump > 5) count++;
    }
    return { worst, count };
  `);
  check('no wild jumps in the contour', spikes.count === 0,
    `${spikes.count} jumps > 5 semitones, largest ${spikes.worst.toFixed(1)}`);

  check('empty state hidden after load', await cdp.eval('return document.getElementById("empty").hidden'));
  const hitPlot = String(await cdp.elementAt(600, 400));
  check('the canvas is what you hit once loaded', /plot/.test(hitPlot), hitPlot);
  check('play button enabled', await cdp.eval('return !document.getElementById("btnPlay").disabled'));
  console.log(`  shot: ${await cdp.shot('02-natural')}`);

  console.log('\nAdvanced view + comparison track');
  // Click it for real: this is the path that a stuck overlay breaks.
  await cdp.clickEl('#btnAdvanced');
  check('Advanced button responds to a real click',
    await cdp.eval('return document.body.classList.contains("advanced")'));
  await cdp.clickEl('#btnAdvanced');
  check('clicking again turns it off',
    await cdp.eval('return !document.body.classList.contains("advanced")'));
  await cdp.key('x', 'KeyX', 88);
  check('"X" toggles advanced mode', await cdp.eval('return document.body.classList.contains("advanced")'));

  await cdp.eval(`
    const res = await fetch('/samples/tuned-vocal.wav');
    const blob = await res.blob();
    await window.__pitchScope.loadFile(new File([blob], 'tuned-vocal.wav', { type: 'audio/wav' }), 1);
    return true;
  `);
  await sleep(500);

  const t2 = await cdp.eval(`
    const s = window.__pitchScope.state;
    return {
      count: s.tracks.length,
      colors: s.tracks.map(t => t.color.line),
      scores: s.tracks.map(t => t.result.report.score),
      verdicts: s.tracks.map(t => t.result.report.verdict.label),
      chips: document.querySelectorAll('.track-chip').length,
      reports: document.querySelectorAll('.report').length,
      swatches: [...document.querySelectorAll('.report-head .chip-swatch')].map(e => e.style.background),
    };
  `);
  check('two tracks loaded', t2.count === 2, t2.count + '');
  check('tracks use different colours', t2.colors[0] !== t2.colors[1], t2.colors.join(' vs '));
  check('a chip per track', t2.chips === 2, t2.chips + '');
  check('a report per track', t2.reports === 2, t2.reports + '');
  check('report swatches match track colours', t2.swatches[0] !== t2.swatches[1], t2.swatches.join(' / '));
  check('tuned take scores higher than natural', t2.scores[1] > t2.scores[0] + 0.2,
    `${t2.scores[1].toFixed(2)} vs ${t2.scores[0].toFixed(2)}`);
  check('tuned take is flagged', /signs of pitch correction/.test(t2.verdicts[1]), t2.verdicts[1]);
  console.log(`  shot: ${await cdp.shot('03-compare')}`);

  console.log('\nComponent breakdown and histogram render');
  const adv = await cdp.eval(`
    const comps = [...document.querySelectorAll('.report .component-label b')].map(e => e.textContent);
    const hist = document.querySelector('canvas.hist');
    const ctx = hist && hist.getContext('2d');
    const px = ctx && ctx.getImageData(0, 0, hist.width, hist.height).data;
    let painted = 0;
    if (px) for (let i = 3; i < px.length; i += 4) if (px[i] > 0) painted++;
    return { comps: comps.length, labels: comps.slice(0, 4), histPainted: painted, histW: hist && hist.width };
  `);
  check('four indicators shown per track', adv.comps === 8, `${adv.comps} across 2 tracks`);
  check('histogram canvas has pixels', adv.histPainted > 200, `${adv.histPainted} painted`);

  console.log('\nGraph rendering');
  const drawn = await cdp.eval(`
    const c = document.getElementById('plot');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    // Count pixels close to each track colour, to prove both traces are drawn.
    const near = (r,g,b, tr,tg,tb) => Math.abs(r-tr)<40 && Math.abs(g-tg)<40 && Math.abs(b-tb)<40;
    let blue = 0, amber = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (near(d[i],d[i+1],d[i+2], 74,144,217)) blue++;
      else if (near(d[i],d[i+1],d[i+2], 217,143,74)) amber++;
    }
    return { blue, amber, w: c.width, h: c.height };
  `);
  check('canvas is sized', drawn.w > 400 && drawn.h > 200, `${drawn.w}x${drawn.h}`);
  check('blue trace drawn', drawn.blue > 300, `${drawn.blue} px`);
  check('amber trace drawn', drawn.amber > 300, `${drawn.amber} px`);

  console.log('\nNote names down the left axis');
  const axis = await cdp.eval(`
    const p = window.__pitchScope.plot;
    p.autoRange();
    const g = p.gridRows();
    const labelled = g.rows.filter(r => r.label);
    return {
      px: g.pxPerSemitone,
      total: g.rows.length,
      labelled: labelled.length,
      labels: labelled.map(r => r.label),
      lines: g.rows.filter(r => r.line).length,
    };
  `);
  check('every semitone in view is labelled at default zoom',
    axis.labelled === axis.total && axis.total > 8,
    `${axis.labelled}/${axis.total} rows at ${axis.px.toFixed(1)} px each`);
  check('every semitone in view has a gridline', axis.lines === axis.total, `${axis.lines} lines`);
  check('labels are column-aligned to one width',
    new Set(axis.labels.map((l) => l.length)).size === 1 && axis.labels[0].length === 3,
    axis.labels.slice(0, 6).join(' | '));
  check('labels run chromatically, sharps included',
    axis.labels.some((l) => l[1] === '#') && axis.labels.some((l) => l[1] === ' '),
    axis.labels.join(' '));

  // Squeezed until the text would collide, it must thin out rather than overlap.
  const thinned = await cdp.eval(`
    const p = window.__pitchScope.plot;
    const mid = (p.view.midiLo + p.view.midiHi) / 2;
    p.view.midiLo = mid - 40; p.view.midiHi = mid + 40;   // 80 semitones on screen
    const g = p.gridRows();
    const labelled = g.rows.filter(r => r.label);
    const ys = labelled.map(r => r.y).sort((a, b) => a - b);
    let minGap = Infinity;
    for (let i = 1; i < ys.length; i++) minGap = Math.min(minGap, ys[i] - ys[i - 1]);
    p.autoRange();
    return { px: g.pxPerSemitone, labelled: labelled.length, minGap, set: g.labelSet,
             sample: labelled.slice(0, 5).map(r => r.label) };
  `);
  check('labels thin out when rows get tight', thinned.labelled < axis.total * 2,
    `${thinned.labelled} labels ("${thinned.set}") at ${thinned.px.toFixed(1)} px per semitone`);
  check('remaining labels never overlap', thinned.minGap >= 12,
    `closest pair ${thinned.minGap.toFixed(1)} px apart`);
  check('thinned labels stay musical', /octave|fifth/.test(thinned.set),
    `${thinned.set}: ${thinned.sample.join(' ')}`);

  // Every zoom level from a two-octave view down to the whole piano.
  const sweep = await cdp.eval(`
    const p = window.__pitchScope.plot;
    const saved = { lo: p.view.midiLo, hi: p.view.midiHi };
    const bad = [];
    for (const span of [6, 12, 24, 36, 48, 60, 88, 120]) {
      const mid = 60;
      p.view.midiLo = mid - span / 2;
      p.view.midiHi = mid + span / 2;
      const g = p.gridRows();
      const ys = g.rows.filter(r => r.label).map(r => r.y).sort((a, b) => a - b);
      let minGap = Infinity;
      for (let i = 1; i < ys.length; i++) minGap = Math.min(minGap, ys[i] - ys[i - 1]);
      if (ys.length > 1 && minGap < 12) bad.push(span + ' semitones: ' + minGap.toFixed(1) + 'px (' + g.labelSet + ')');
      if (ys.length === 0) bad.push(span + ' semitones: no labels at all');
    }
    p.view.midiLo = saved.lo; p.view.midiHi = saved.hi;
    return bad;
  `);
  check('axis stays legible at every zoom level', sweep.length === 0, sweep.join('; '));

  console.log('\nKeyboard shortcuts');
  const before = await cdp.eval('const v = window.__pitchScope.plot.view; return { t0: v.t0, t1: v.t1 };');
  await cdp.key('+', 'Equal', 187);
  const zoomed = await cdp.eval('const v = window.__pitchScope.plot.view; return { t0: v.t0, t1: v.t1 };');
  check('"+" zooms in', (zoomed.t1 - zoomed.t0) < (before.t1 - before.t0) - 0.01,
    `${(before.t1 - before.t0).toFixed(2)}s -> ${(zoomed.t1 - zoomed.t0).toFixed(2)}s`);

  await cdp.key('ArrowRight', 'ArrowRight', 39);
  const panned = await cdp.eval('return window.__pitchScope.plot.view.t0');
  check('right arrow pans forward', panned > zoomed.t0, `t0 ${zoomed.t0.toFixed(2)} -> ${panned.toFixed(2)}`);

  await cdp.key('0', 'Digit0', 48);
  const fitted = await cdp.eval('const v = window.__pitchScope.plot.view; return v.t1 - v.t0;');
  check('"0" fits the whole track', Math.abs(fitted - (before.t1 - before.t0)) < 0.5, `${fitted.toFixed(2)}s`);

  await cdp.key('d', 'KeyD', 68);
  check('"D" switches to cents view', await cdp.eval('return window.__pitchScope.plot.mode') === 'deviation');
  console.log(`  shot: ${await cdp.shot('04-cents-view')}`);

  const devDrawn = await cdp.eval(`
    const c = document.getElementById('plot');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let blue = 0, amber = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i]-74)<40 && Math.abs(d[i+1]-144)<40 && Math.abs(d[i+2]-217)<40) blue++;
      else if (Math.abs(d[i]-217)<40 && Math.abs(d[i+1]-143)<40 && Math.abs(d[i+2]-74)<40) amber++;
    }
    return { blue, amber };
  `);
  check('both traces drawn in cents view', devDrawn.blue > 300 && devDrawn.amber > 300,
    `blue ${devDrawn.blue}, amber ${devDrawn.amber}`);

  await cdp.key('d', 'KeyD', 68);
  await cdp.key('2', 'Digit2', 50);
  check('"2" hides the second track',
    await cdp.eval('return window.__pitchScope.state.tracks[1].visible') === false);
  await cdp.key('2', 'Digit2', 50);
  check('"2" shows it again',
    await cdp.eval('return window.__pitchScope.state.tracks[1].visible') === true);

  await cdp.key('?', 'Slash', 191, 8 /* shift */);
  check('"?" opens the shortcut list',
    await cdp.eval('return !document.getElementById("helpModal").hidden'));
  console.log(`  shot: ${await cdp.shot('05-help')}`);
  await cdp.clickEl('#btnCloseHelp');
  const closed = await cdp.eval(`
    const e = document.getElementById('helpModal');
    return { hidden: e.hidden, display: getComputedStyle(e).display };
  `);
  check('the close button closes it', closed.hidden, `display: ${closed.display}`);
  check('it stops covering the page once closed', closed.display === 'none', closed.display);

  console.log('\nTransport and view buttons (real clicks)');
  await cdp.clickEl('#modeDeviation');
  check('"Cents off" button switches view',
    await cdp.eval('return window.__pitchScope.plot.mode') === 'deviation');
  await cdp.clickEl('#modePitch');
  check('"Pitch" button switches back',
    await cdp.eval('return window.__pitchScope.plot.mode') === 'pitch');

  const spanBefore = await cdp.eval('const v = window.__pitchScope.plot.view; return v.t1 - v.t0;');
  await cdp.clickEl('#btnZoomIn');
  const spanAfter = await cdp.eval('const v = window.__pitchScope.plot.view; return v.t1 - v.t0;');
  check('zoom-in button works', spanAfter < spanBefore - 0.01,
    `${spanBefore.toFixed(2)}s -> ${spanAfter.toFixed(2)}s`);
  await cdp.clickEl('#btnFit');
  check('Fit button works',
    Math.abs(await cdp.eval('const v = window.__pitchScope.plot.view; return v.t1 - v.t0;') - spanBefore) < 0.5);

  await cdp.clickEl('#chkTolerance');
  check('in-tune band checkbox toggles',
    await cdp.eval('return window.__pitchScope.plot.showTolerance') === false);
  await cdp.clickEl('#chkTolerance');

  console.log('\nClick-to-seek on the graph');
  await cdp.click(700, 400);
  const seeked = await cdp.eval('return window.__pitchScope.state.playFrom');
  check('clicking the graph moves the playhead', seeked > 0, `${seeked.toFixed(2)} s`);

  console.log('\nHover readout');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 400, buttons: 0 });
  await sleep(200);
  const readout = await cdp.eval(`
    const r = document.getElementById('readout');
    return { hidden: r.hidden, text: r.textContent };
  `);
  check('hover shows a readout', !readout.hidden, JSON.stringify(readout.text));
  check('readout names a note or silence', /[A-G]#?-?\\d|silent/.test(readout.text), readout.text);

  console.log('\nPlayback');
  await cdp.key(' ', 'Space', 32);
  await sleep(700);
  const playing = await cdp.eval(`
    const s = window.__pitchScope.state;
    return { playing: s.playing, head: window.__pitchScope.plot.playhead,
             btn: document.getElementById('btnPlay').classList.contains('is-playing'),
             clock: document.getElementById('timeDisplay').textContent };
  `);
  check('space starts playback', playing.playing, playing.clock);
  check('playhead advances', playing.head > 0, `${(playing.head || 0).toFixed(2)} s`);
  check('play button shows playing state', playing.btn);

  await cdp.key(' ', 'Space', 32);
  const paused = await cdp.eval(`
    const s = window.__pitchScope.state;
    return { playing: s.playing, from: s.playFrom };
  `);
  check('space pauses', !paused.playing);
  check('pause keeps the position', paused.from > 0, `${paused.from.toFixed(2)} s`);

  console.log('\nDrag to pan and wheel to zoom');
  await cdp.eval('window.__pitchScope.plot.autoRange(); return true;');
  const panStart = await cdp.eval('return window.__pitchScope.plot.view.t0;');
  await cdp.eval('window.__pitchScope.plot.zoomTime(0.4); return true;');
  const mid = await cdp.eval('return window.__pitchScope.plot.view.t0;');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 400, button: 'left', clickCount: 1, buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 400, button: 'left', buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 500, y: 400, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(250);
  const afterDrag = await cdp.eval('return window.__pitchScope.plot.view.t0;');
  check('dragging left scrolls forward in time', afterDrag > mid, `t0 ${mid.toFixed(2)} -> ${afterDrag.toFixed(2)}`);
  check('a drag does not seek the playhead',
    Math.abs(await cdp.eval('return window.__pitchScope.state.playFrom;') - paused.from) < 0.01);

  // Dispatched through the DOM rather than via Input.dispatchMouseEvent, which
  // hangs on mouseWheel in headless. This still runs the real listener.
  const wheel = await cdp.eval(`
    const plot = window.__pitchScope.plot;
    const before = plot.view.t1 - plot.view.t0;
    const c = document.getElementById('plot');
    // The handler updates plot.view synchronously; only the repaint is deferred.
    c.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -120, clientX: 600, clientY: 400, bubbles: true, cancelable: true,
    }));
    const zoomIn = plot.view.t1 - plot.view.t0;
    c.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 240, clientX: 600, clientY: 400, bubbles: true, cancelable: true,
    }));
    return { before, zoomIn, zoomOut: plot.view.t1 - plot.view.t0 };
  `);
  check('wheel up zooms in', wheel.zoomIn < wheel.before - 0.01,
    `${wheel.before.toFixed(2)}s -> ${wheel.zoomIn.toFixed(2)}s`);
  check('wheel down zooms out', wheel.zoomOut > wheel.zoomIn + 0.01,
    `${wheel.zoomIn.toFixed(2)}s -> ${wheel.zoomOut.toFixed(2)}s`);

  console.log('\nRemoving a track');
  await cdp.clickEl('.track-chip:nth-child(2) .chip-btn:last-child');
  const removed = await cdp.eval(`
    const s = window.__pitchScope.state;
    return { count: s.tracks.length, chips: document.querySelectorAll('.track-chip').length,
             reports: document.querySelectorAll('.report').length };
  `);
  check('the ✕ button removes a track', removed.count === 1, `${removed.count} left`);
  check('its chip goes too', removed.chips === 1, `${removed.chips}`);
  check('its report goes too', removed.reports === 1, `${removed.reports}`);

  // Put it back for the remaining tests.
  await cdp.eval(`
    const res = await fetch('/samples/tuned-vocal.wav');
    await window.__pitchScope.loadFile(new File([await res.blob()], 'tuned-vocal.wav', { type: 'audio/wav' }), 1);
    return true;
  `);
  await sleep(500);

  console.log('\nSettings re-analysis');
  await cdp.eval(`
    const el = document.getElementById('setSilence');
    el.value = '50';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await sleep(2500);
  const resettled = await cdp.eval(`
    const s = window.__pitchScope.state;
    return { db: s.settings.silenceDropDb, tracks: s.tracks.length, notes: s.tracks[0].result.notes.length };
  `);
  check('silence setting applied', resettled.db === 50, `-${resettled.db} dB`);
  check('tracks survive re-analysis', resettled.tracks === 2 && resettled.notes > 5,
    `${resettled.tracks} tracks, ${resettled.notes} notes`);

  console.log('\nDemo pair button');
  await cdp.eval(`
    window.__pitchScope.state.tracks.length = 0;
    document.getElementById('btnDemo').click();
    return true;
  `);
  await sleep(3500);
  check('demo pair loads two tracks',
    await cdp.eval('return window.__pitchScope.state.tracks.length') === 2);

  console.log('\nDegenerate input must not break anything');
  for (const [file, label] of [
    ['test/fixtures/silence.wav', 'digital silence'],
    ['test/fixtures/noise.wav', 'white noise'],
    ['test/fixtures/tiny.wav', 'a 50 ms clip'],
  ]) {
    const before = cdp.consoleErrors.length;
    const res = await cdp.eval(`
      try {
        const r = await fetch('/${file}');
        await window.__pitchScope.loadFile(new File([await r.blob()], '${file}', { type: 'audio/wav' }), 0);
      } catch (e) {
        return { threw: String(e && e.message) };
      }
      const t = window.__pitchScope.state.tracks.find(t => t.slot === 0);
      return {
        threw: null,
        notes: t ? t.result.notes.length : -1,
        verdict: t ? t.result.report.verdict.label : null,
        score: t ? t.result.report.score : null,
        canvasOk: document.getElementById('plot').width > 100,
      };
    `);
    check(`${label}: loads without throwing`, !res.threw, res.threw || '');
    check(`${label}: reports honestly rather than guessing`,
      res.verdict === 'Not enough material' || res.notes === 0 || res.score < 0.8,
      `${res.notes} notes, "${res.verdict}"`);
    check(`${label}: no new console errors`, cdp.consoleErrors.length === before,
      cdp.consoleErrors.slice(before).join(' | '));
  }

  console.log('\nA file that is not audio');
  const badFile = await cdp.eval(`
    const blob = new Blob(['this is not audio at all'], { type: 'audio/wav' });
    await window.__pitchScope.loadFile(new File([blob], 'notes.txt', { type: 'audio/wav' }), 0);
    const box = document.getElementById('errorBox');
    return {
      shown: !box.hidden,
      text: box.textContent,
      progressHidden: document.getElementById('progress').hidden,
    };
  `);
  check('a bad file shows an error', badFile.shown, badFile.text);
  check('the error names the file and suggests formats',
    /notes\.txt/.test(badFile.text) && /WAV|MP3/.test(badFile.text), badFile.text);
  check('the progress overlay is dismissed', badFile.progressHidden);

  // Back to a real track for the layout check.
  await cdp.eval(`
    const r = await fetch('/samples/natural-vocal.wav');
    await window.__pitchScope.loadFile(new File([await r.blob()], 'natural-vocal.wav', { type: 'audio/wav' }), 0);
    return true;
  `);
  await sleep(500);
  check('a good load clears the error',
    await cdp.eval('return document.getElementById("errorBox").hidden'));

  console.log('\nNarrow viewport');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 860, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(400);
  const narrow = await cdp.eval(`
    // Any element whose right edge sits past the viewport is clipped off-screen.
    const clipped = [...document.querySelectorAll('.topbar *, .transport *, .track-chip')]
      .filter(e => e.getBoundingClientRect().right > window.innerWidth + 1)
      .map(e => e.className || e.tagName);
    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      clipped: [...new Set(clipped)],
      canvasW: document.getElementById('plot').clientWidth,
    };
  `);
  check('no horizontal overflow at 860px', !narrow.overflow, `canvas ${narrow.canvasW}px`);
  check('nothing in the bars is clipped off-screen', narrow.clipped.length === 0,
    narrow.clipped.join(', '));
  console.log(`  shot: ${await cdp.shot('06-narrow')}`);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  console.log('\nConsole');
  const errs = cdp.consoleErrors.filter((e) => !/favicon|Autoplay/i.test(e));
  check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log(`\n${checks - failures}/${checks} checks passed`);
  console.log(`screenshots in ${shotsDir}`);
}

main().then(() => process.exit(failures ? 1 : 0)).catch((e) => {
  console.error('\nharness error:', e.message);
  process.exit(1);
});
