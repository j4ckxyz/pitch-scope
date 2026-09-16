/* worker.js: runs the analysis off the main thread so the UI stays responsive. */

import { resampleMono, trackPitch, cleanContour, WORK_RATE } from './dsp.js';
import { hzToMidi, estimateTuning, segmentNotes, analyseCorrection } from './music.js';

self.onmessage = (ev) => {
  const { id, channels, sampleRate, settings = {} } = ev.data;
  try {
    post({ id, type: 'progress', stage: 'Preparing audio', value: 0.02 });
    const mono = resampleMono(channels, sampleRate, WORK_RATE);

    const raw = trackPitch(mono, WORK_RATE, {
      fMin: settings.fMin,
      fMax: settings.fMax,
      silenceDropDb: settings.silenceDropDb,
      maxAperiodicity: settings.maxAperiodicity,
      onProgress: (v) => post({ id, type: 'progress', stage: 'Tracking pitch', value: 0.05 + v * 0.85 }),
    });

    post({ id, type: 'progress', stage: 'Reading notes', value: 0.92 });
    const f0 = cleanContour(raw.f0);
    const midiRaw = Float64Array.from(f0, (hz) => (isFinite(hz) ? hzToMidi(hz) : NaN));

    // Correct for the track's own tuning reference before any grid statistics,
    // or a session cut at A=442 reads as uniformly sharp.
    const tuning = estimateTuning(midiRaw);
    const offset = settings.manualTuningCents ?? tuning.centsOffset;
    const midi = Float64Array.from(midiRaw, (m) => (isFinite(m) ? m - offset / 100 : NaN));

    const notes = segmentNotes(raw.time, midi, {
      minMs: settings.minNoteMs ?? 70,
    });
    const report = analyseCorrection(raw.time, midi, notes);

    post(
      {
        id,
        type: 'done',
        result: {
          time: raw.time,
          midi,
          rms: raw.rms,
          aperiodicity: raw.aperiodicity,
          hopMs: raw.hopMs,
          duration: mono.length / WORK_RATE,
          tuning: { ...tuning, appliedCents: offset },
          notes,
          report,
        },
      },
      [raw.time.buffer, midi.buffer, raw.rms.buffer, raw.aperiodicity.buffer],
    );
  } catch (err) {
    post({ id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
};

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}
