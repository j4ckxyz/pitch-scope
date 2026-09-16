/* Regenerates the screenshots used in the README.
 * Usage: node test/screenshots.js          (needs the dev server on :8173)
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = 'http://localhost:8173';
const outDir = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9377',
  `--user-data-dir=/tmp/pitchscope-shots-${Date.now()}`,
  '--window-size=1400,880', '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    target = (await fetch('http://localhost:9377/json/list').then((r) => r.json()))
      .find((t) => t.type === 'page');
  } catch { /* not up yet */ }
}
if (!target) throw new Error('Chrome did not start. Is `npm start` running?');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const waiting = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  waiting.set(++id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(outDir, { recursive: true });
  const p = join(outDir, `${name}.png`);
  writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log(`${p}  ${(Buffer.from(r.data, 'base64').length / 1024).toFixed(0)} KB`);
};

const load = (file, slot) => ev(`
  const res = await fetch('/samples/${file}');
  await window.__pitchScope.loadFile(
    new File([await res.blob()], '${file}', { type: 'audio/wav' }), ${slot});
  return true;
`);

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1400, height: 880, deviceScaleFactor: 2, mobile: false,
});
await send('Page.navigate', { url: ORIGIN + '/index.html' });
await sleep(1500);

await shot('empty');

// Click the real control: setting the class alone leaves the app state off, so
// the reports would render without their indicator breakdown.
await ev('document.getElementById("btnAdvanced").click(); return true;');
await load('natural-vocal.wav', 0);
await load('tuned-vocal.wav', 1);
await sleep(600);
await ev('window.__pitchScope.plot.autoRange(); window.__pitchScope.plot.draw(); return true;');
await sleep(300);
await shot('compare');

await ev(`
  const p = window.__pitchScope.plot;
  p.mode = 'deviation';
  document.getElementById('modePitch').classList.remove('is-on');
  document.getElementById('modeDeviation').classList.add('is-on');
  p.draw();
  return true;
`);
await sleep(300);
await shot('cents-off');

ws.close();
chrome.kill();
