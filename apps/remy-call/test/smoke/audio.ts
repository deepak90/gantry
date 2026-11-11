/** 16-bit mono PCM helpers for the smoke test: WAV in and out, levels, and speech spans. */
import { readFileSync, writeFileSync } from 'node:fs';

export function wavBytes(samples: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function writeWav(path: string, samples: Int16Array, sampleRate: number): void {
  writeFileSync(path, wavBytes(samples, sampleRate));
}

/** The first channel of a 16-bit PCM WAV. */
export function readWav(path: string): { sampleRate: number; samples: Int16Array } {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not a WAV`);
  let offset = 12;
  let channels = 1;
  let sampleRate = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
    }
    if (id === 'data') {
      const start = offset + 8;
      const bytes = Math.min(size, buf.length - start);
      const all = new Int16Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + bytes - (bytes % 2)));
      return { sampleRate, samples: channels === 1 ? all : all.filter((_, i) => i % channels === 0) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

export const dbfs = (rms: number) => (rms > 0 ? 20 * Math.log10(rms) : -120);

export function frameDb(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += (samples[i] ?? 0) ** 2;
  return dbfs(Math.sqrt(sum / Math.max(1, samples.length)) / 32768);
}

/** Level per 10 ms. */
export function envelope(samples: Int16Array, sampleRate: number): number[] {
  const hop = Math.round(sampleRate / 100);
  const out: number[] = [];
  for (let k = 0; (k + 1) * hop <= samples.length; k++) out.push(frameDb(samples.subarray(k * hop, (k + 1) * hop)));
  return out;
}

/** Trims the click and silence before the first sustained sound, and keeps 250 ms after the last. */
export function trimClip(samples: Int16Array, sampleRate: number): Int16Array {
  const env = envelope(samples, sampleRate);
  const hop = sampleRate / 100;
  let first = 0;
  for (let k = 0; k + 8 <= env.length; k++) {
    let loud = 0;
    for (let j = k; j < k + 8; j++) if ((env[j] ?? -120) > -40) loud++;
    if (loud >= 5 && (env[k] ?? -120) > -40) {
      first = k;
      break;
    }
  }
  let last = env.length - 1;
  while (last > first && (env[last] ?? -120) < -48) last--;
  return samples.slice(Math.max(0, (first - 3) * hop), Math.min(samples.length, (last + 1) * hop + 0.25 * sampleRate));
}
