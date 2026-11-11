/**
 * The callers' clips: `<id>.wav` from the first directory that has it, else made with
 * gpt-4o-mini-tts (the click and silence before the first word trimmed) and saved in the cache directory.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readWav, trimClip, writeWav } from './audio.ts';
import { CAST, LINES } from './script.ts';

export interface Clip {
  id: string;
  sampleRate: number;
  samples: Int16Array;
  source: 'found' | 'made';
  /** seconds of audio generated for it (for the spend estimate) */
  madeSeconds: number;
}

export async function loadClips(ids: readonly string[], searchDirs: readonly string[], cacheDir: string): Promise<Map<string, Clip>> {
  mkdirSync(cacheDir, { recursive: true });
  const clips = new Map<string, Clip>();
  for (const id of ids) {
    const found = [...searchDirs, cacheDir].map((dir) => join(dir, `${id}.wav`)).find((path) => existsSync(path));
    if (found) {
      const wav = readWav(found);
      clips.set(id, { id, ...wav, source: 'found', madeSeconds: 0 });
      continue;
    }
    const made = await makeClip(id);
    writeWav(join(cacheDir, `${id}.wav`), made.samples, made.sampleRate);
    clips.set(id, { id, ...made, source: 'made', madeSeconds: made.rawSeconds });
  }
  return clips;
}

async function makeClip(id: string): Promise<{ sampleRate: number; samples: Int16Array; rawSeconds: number }> {
  const line = LINES[id];
  if (!line) throw new Error(`no line ${id}`);
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error(`clip ${id} is missing and OPENAI_API_KEY is not set to make it`);
  const cast = CAST[line.who];
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: cast.voice, input: line.say, instructions: line.instructions ?? cast.instructions, response_format: 'pcm' }),
  });
  if (!res.ok) throw new Error(`speech for ${id}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const raw = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length - (bytes.length % 2)));
  return { sampleRate: 24000, samples: trimClip(raw, 24000), rawSeconds: raw.length / 24000 };
}
