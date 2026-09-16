/* Writes the WAV fixtures.
 * Usage: node test/make-fixtures.js [demoDir] [edgeDir]
 *
 * `samples/` holds the demo pair the app offers on its empty screen: the same
 * sung phrase once human and once hard-tuned, which is exactly the "original vs
 * re-release" comparison the tool is for.
 *
 * `test/fixtures/` holds degenerate inputs the browser suite loads to check the
 * app reports honestly instead of crashing or inventing notes.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { melody, NATURAL, CORRECTED, PRECISE_SINGER } from './synth.js';

function writeWav(path, signal, rate) {
  const n = signal.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, signal[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
  return buf.length;
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || join(here, '..', 'samples');
const edgeDir = process.argv[3] || join(here, 'fixtures');
mkdirSync(outDir, { recursive: true });
mkdirSync(edgeDir, { recursive: true });

// A phrase with rests in it, so the silence handling gets exercised.
const phrase = [
  62, 64, 65, 67, 67, 65, 64, 62,
  60, 62, 64, 65, 64, 62, 60, 59, 60,
];

const cases = [
  ['natural-vocal.wav', NATURAL, { gapSec: 0.05, noteSec: 0.55, seed: 11 }],
  ['tuned-vocal.wav', CORRECTED, { gapSec: 0.05, noteSec: 0.55, seed: 11 }],
  ['accurate-singer.wav', PRECISE_SINGER, { gapSec: 0.05, noteSec: 0.55, seed: 11 }],
];

for (const [name, style, opts] of cases) {
  const mel = melody(phrase, style, { ...opts, rate: 44100 });
  // Insert a genuine silent gap in the middle so the plot must break the line.
  const sig = mel.signal;
  const gapStart = Math.floor(sig.length * 0.45);
  const gapEnd = Math.floor(sig.length * 0.55);
  for (let i = gapStart; i < gapEnd; i++) sig[i] *= 0.00002;

  const bytes = writeWav(join(outDir, name), sig, 44100);
  console.log(`${name}  ${(mel.duration).toFixed(1)}s  ${(bytes / 1024).toFixed(0)} KB`);
}

/* Degenerate inputs. The app must report "not enough material" for each of
 * these rather than crashing or inventing notes out of noise. */
const edge = [
  ['silence.wav', new Float32Array(44100 * 2)],
  ['noise.wav', Float32Array.from({ length: 44100 * 3 }, () => (Math.random() - 0.5) * 0.6)],
  ['tiny.wav', Float32Array.from({ length: 2205 }, (_, i) => Math.sin((2 * Math.PI * 220 * i) / 44100) * 0.5)],
];
for (const [name, sig] of edge) {
  const bytes = writeWav(join(edgeDir, name), sig, 44100);
  console.log(`${name}  ${(sig.length / 44100).toFixed(2)}s  ${(bytes / 1024).toFixed(0)} KB`);
}
