/** 16-bit mono PCM in and out of WAV files. */
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
  let bits = 16;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bits = buf.readUInt16LE(offset + 22);
    }
    if (id === 'data') {
      if (bits !== 16) throw new Error(`${path}: ${bits}-bit, expected 16`);
      const start = offset + 8;
      const bytes = Math.min(size, buf.length - start);
      const all = new Int16Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + bytes - (bytes % 2)));
      return { sampleRate, samples: channels === 1 ? all : all.filter((_, i) => i % channels === 0) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}
