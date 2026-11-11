/**
 * The Anthropic client for each mode. Only `fetch` differs, so everything above it (the SDK's
 * stream parser, tools, grounding, streaming to the browsers) runs the same in every mode:
 *   live    the real API; with a recording directory, each /v1/messages response is also teed to
 *           <dir>/NNN.json while it streams (the key stays in the SDK; it is never written)
 *   replay  answers the Nth request with the Nth recorded response, streamed at a steady pace
 *   mock    the scripted stand-in (mock-model.ts)
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMode } from '../env';
import { mockFetch } from './mock-model';
import { splitSse, streamingResponse } from './sse';

interface Recording {
  seq: number;
  model: string;
  request_tail: unknown;
  status: number;
  request_id: string | null;
  ms_to_headers: number;
  ms_total: number | null;
  sse: string;
}

function recordingFetch(dir: string): typeof fetch {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let seq = 0;
  return async (input, init) => {
    const started = Date.now();
    const response = await fetch(input, init);
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('/v1/messages') || !response.body) return response;
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string; messages?: unknown[] };
    const mine = ++seq;
    const headersMs = Date.now() - started;
    const [forCaller, forDisk] = response.body.tee();
    void (async () => {
      const text = await new Response(forDisk).text();
      const record: Recording = {
        seq: mine,
        model: body.model ?? '',
        request_tail: body.messages?.at(-1) ?? null,
        status: response.status,
        request_id: response.headers.get('request-id'),
        ms_to_headers: headersMs,
        ms_total: Date.now() - started,
        sse: text,
      };
      writeFileSync(join(dir, `${String(mine).padStart(3, '0')}.json`), JSON.stringify(record, null, 1));
    })();
    return new Response(forCaller, { status: response.status, headers: response.headers });
  };
}

function replayFetch(dir: string, delayMs: number): typeof fetch {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  let next = 0;
  return async () => {
    const file = files[next++];
    if (!file) throw new Error(`Replay ran out of recorded responses in ${dir}`);
    const record = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Recording;
    if (record.status !== 200) return new Response(record.sse, { status: record.status, headers: { 'content-type': 'application/json' } });
    return streamingResponse(splitSse(record.sse), delayMs);
  };
}

export interface ClientOptions {
  /** live: record responses here; replay: read them from here. */
  recordingDir?: string | null;
  /** Pace of mock and replay streams. */
  delayMs?: number;
}

export function makeClient(mode: AgentMode, options: ClientOptions = {}): Anthropic {
  const delay = options.delayMs ?? Number(process.env.MOCK_STREAM_DELAY_MS ?? 8);
  switch (mode) {
    case 'live':
      return new Anthropic({ ...(options.recordingDir ? { fetch: recordingFetch(options.recordingDir) } : {}), maxRetries: 2, timeout: 120_000 });
    case 'replay':
      if (!options.recordingDir) throw new Error('replay needs a recording directory');
      return new Anthropic({ apiKey: 'replay-no-network', fetch: replayFetch(options.recordingDir, delay), maxRetries: 0 });
    case 'mock':
      return new Anthropic({ apiKey: 'mock-no-network', fetch: mockFetch(delay) as typeof fetch, maxRetries: 0 });
  }
}
