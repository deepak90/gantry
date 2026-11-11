/**
 * What the model writes to itself beside a tool call ("Crew names need to be bare names; redraw.", "They asked for
 * exactly the end date; draft as asked.", which a live call once heard) is not an answer: it is not streamed (so nobody
 * hears it on a call) and not kept in the message. What people hear and read comes through reply; an answer written as
 * plain words with no tool beside it still reaches them, once the step is done.
 */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { FakeBrowser, FakeDb, FakeTransport, presenceOf } from '../src/dev/fake';
import { sseEvents, streamingResponse, type MockBlock, type MockTurn } from '../src/llm/sse';
import { silentLogger } from '../src/log';
import { ProjectAgent } from '../src/project-agent';
import type { TurnResult } from '../src/agent/brain';

const count = (id: string, calendar: string): MockBlock => ({
  type: 'tool_use',
  id,
  name: 'count_working_days',
  input: { op: 'working_days_between', from: '2026-11-02', to: '2026-11-06', calendar },
});
const REFUSED = count('toolu_refused', 'Nobody Such');
const FINE = count('toolu_fine', 'standard');
const reply = (text: string): MockBlock => ({ type: 'tool_use', id: 'toolu_reply', name: 'reply', input: { text } });

function scripted(turns: MockTurn[]): Anthropic {
  let seq = 0;
  const respond = async (_url: unknown, init?: { body?: unknown }) => {
    const { model } = JSON.parse(String(init?.body ?? '{}')) as { model: string };
    const turn = turns[seq++] ?? { blocks: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' as const };
    return streamingResponse(sseEvents(turn, model, `msg_${seq}`), 0);
  };
  return new Anthropic({ apiKey: 'no-network', fetch: respond as unknown as typeof fetch, maxRetries: 0 });
}

async function run(turns: MockTurn[]) {
  const db = new FakeDb();
  const transport = new FakeTransport();
  const browser = new FakeBrowser(db, transport, { commandDelayMs: 5 });
  const results: TurnResult[] = [];
  const agent = new ProjectAgent({
    projectId: db.projectId,
    store: db,
    transport,
    client: scripted(turns),
    models: { analysis: 'claude-opus-5-5', chat: 'claude-sonnet-5-5' },
    log: silentLogger,
    debounce: { presence: 0, workflow: 5, plan: 5 },
    openingDelayMs: 0,
    raiseIssues: false,
    onTurn: (result) => results.push(result),
  });
  await agent.start();
  transport.presence(db.projectId, presenceOf('pm'));
  await agent.idle();
  browser.say('pm', 'How many working days is that?', 'text');
  await agent.idle();
  await agent.stop();
  const pieces = transport.sent.flatMap((event) => (event.type === 'text_delta' ? [event.text] : []));
  return { say: results.at(-1)!.say, streamed: pieces.join('') };
}

describe('words around a refused tool', () => {
  it('drops the note written before the retry', async () => {
    const { say, streamed } = await run([
      { blocks: [REFUSED], stop_reason: 'tool_use' },
      { blocks: [{ type: 'text', text: 'Crew names need to be bare names; redraw.' }, FINE], stop_reason: 'tool_use' },
      { blocks: [reply('Five working days.')], stop_reason: 'tool_use' },
    ]);
    expect(say).toBe('Five working days.');
    expect(streamed).toContain('Five working days.');
    expect(streamed).not.toContain('redraw');
  });

  it('drops a note written later in the same turn, before another tool', async () => {
    const { say, streamed } = await run([
      { blocks: [REFUSED], stop_reason: 'tool_use' },
      { blocks: [FINE], stop_reason: 'tool_use' },
      { blocks: [{ type: 'text', text: 'That worked, on to the next check.' }, FINE], stop_reason: 'tool_use' },
      { blocks: [reply('Five working days.')], stop_reason: 'tool_use' },
    ]);
    expect(say).toBe('Five working days.');
    expect(streamed).not.toContain('next check');
  });

  it('keeps an answer written after a refusal when nothing is retried', async () => {
    const { say, streamed } = await run([
      { blocks: [REFUSED], stop_reason: 'tool_use' },
      { blocks: [{ type: 'text', text: 'I could not find that calendar.' }], stop_reason: 'end_turn' },
    ]);
    expect(say).toBe('I could not find that calendar.');
    expect(streamed).toContain('I could not find that calendar.');
  });

  it('drops words beside a tool even when nothing refused it: they are the model’s own note', async () => {
    const { say, streamed } = await run([
      { blocks: [{ type: 'text', text: 'They asked for exactly the end date; draft as asked.' }, FINE], stop_reason: 'tool_use' },
      { blocks: [reply('Five working days.')], stop_reason: 'tool_use' },
    ]);
    expect(say).toBe('Five working days.');
    expect(streamed).not.toContain('draft as asked');
  });

  it('says words written alone, with no tool beside them', async () => {
    const { say, streamed } = await run([{ blocks: [{ type: 'text', text: 'Five working days.' }], stop_reason: 'end_turn' }]);
    expect(say).toBe('Five working days.');
    expect(streamed).toContain('Five working days.');
  });
});
