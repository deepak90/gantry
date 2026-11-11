import { describe, expect, it } from 'vitest';
import { HopFeeder, HumGate, type HumGateEvent } from '../src/hum-gate.ts';

const RATE = 16000;
let seed = 1;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

/** Concatenated pieces of 16 kHz audio: silence (quiet noise), hums (low harmonics only) and open speech (broadband). */
function audio(pieces: Array<{ kind: 'quiet' | 'hum' | 'open'; ms: number; db?: number }>): Int16Array {
  const out: number[] = [];
  for (const piece of pieces) {
    const n = Math.round((piece.ms / 1000) * RATE);
    const amp = 32768 * 10 ** ((piece.db ?? -20) / 20) * Math.SQRT2;
    for (let i = 0; i < n; i++) {
      const t = out.length / RATE;
      if (piece.kind === 'quiet') out.push(random() * 16);
      else if (piece.kind === 'hum') out.push(amp * (0.8 * Math.sin(2 * Math.PI * 180 * t) + 0.3 * Math.sin(2 * Math.PI * 360 * t) + 0.1 * Math.sin(2 * Math.PI * 540 * t)));
      else out.push(amp * 0.6 * (0.6 * Math.sin(2 * Math.PI * 140 * t) + random()));
    }
  }
  return Int16Array.from(out, (v) => Math.max(-32768, Math.min(32767, Math.round(v))));
}

function run(samples: Int16Array, chunk = 160): HumGateEvent[] {
  const feeder = new HopFeeder(new HumGate());
  const events: HumGateEvent[] = [];
  for (let i = 0; i < samples.length; i += chunk) events.push(...feeder.push(samples.subarray(i, Math.min(samples.length, i + chunk))));
  return events;
}

describe('HumGate', () => {
  it('lets a closed-mouth hum through', () => {
    const events = run(audio([{ kind: 'quiet', ms: 300 }, { kind: 'hum', ms: 450 }, { kind: 'quiet', ms: 400 }]));
    expect(events.map((e) => e.type)).toEqual(['onset', 'end']);
    const end = events.find((e) => e.type === 'end');
    expect(end).toMatchObject({ decided: null, open: 0 });
  });

  it('stops Remy on open-mouth speech within a few frames', () => {
    const events = run(audio([{ kind: 'quiet', ms: 300 }, { kind: 'open', ms: 400 }, { kind: 'quiet', ms: 400 }]));
    const barge = events.find((e) => e.type === 'barge');
    expect(barge).toMatchObject({ reason: 'open' });
    expect(barge && 'msAfterOnset' in barge ? barge.msAfterOnset : Infinity).toBeLessThanOrEqual(60);
  });

  it('treats anything longer than 700 ms as speech', () => {
    const events = run(audio([{ kind: 'quiet', ms: 300 }, { kind: 'hum', ms: 1000 }, { kind: 'quiet', ms: 400 }]));
    const barge = events.find((e) => e.type === 'barge');
    expect(barge).toMatchObject({ reason: 'long' });
    // 700 ms of sound, the onset hop included
    const ms = barge && 'msAfterOnset' in barge ? barge.msAfterOnset : 0;
    expect(ms).toBeGreaterThanOrEqual(680);
    expect(ms).toBeLessThanOrEqual(720);
  });

  it('ignores a quiet room', () => {
    expect(run(audio([{ kind: 'quiet', ms: 2000 }]))).toEqual([]);
  });

  it('decides the same whatever size the frames come in', () => {
    const samples = audio([{ kind: 'quiet', ms: 200 }, { kind: 'hum', ms: 300 }, { kind: 'quiet', ms: 300 }, { kind: 'open', ms: 300 }, { kind: 'quiet', ms: 300 }]);
    expect(run(samples, 237)).toEqual(run(samples, 160));
  });

  it('reports a sound in progress', () => {
    const gate = new HumGate();
    const feeder = new HopFeeder(gate);
    feeder.push(audio([{ kind: 'quiet', ms: 100 }, { kind: 'open', ms: 100 }]));
    expect(gate.active).toBe(true);
    feeder.push(audio([{ kind: 'quiet', ms: 300 }]));
    expect(gate.active).toBe(false);
  });
});
