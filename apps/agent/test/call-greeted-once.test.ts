/**
 * Remy greets a call once, naming the person who called her in, whichever tab hosts it: when the first person leaves
 * and the next one's tab takes over hosting the call, that is the same call, not a new one to greet (a live test heard
 * her greet again mid-conversation). A call that ends, and a new one well after, is greeted again.
 */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { FakeDb, FakeTransport, presenceOf } from '../src/dev/fake';
import { sseEvents, streamingResponse } from '../src/llm/sse';
import { silentLogger } from '../src/log';
import { CALL_GAP_MS, ProjectAgent } from '../src/project-agent';
import type { PresenceState } from '../src/realtime/presence';

function claude() {
  const asked: string[] = [];
  const respond = async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model: string; messages: { content: { type: string; text?: string }[] }[] };
    asked.push((body.messages.at(-1)?.content ?? []).map((block) => block.text ?? '').join(''));
    return streamingResponse(sseEvents({ blocks: [{ type: 'tool_use', id: `toolu_${asked.length}`, name: 'reply', input: { text: 'Hi, how can I help?' } }], stop_reason: 'tool_use' }, body.model, `msg_${asked.length}`), 0);
  };
  return { client: new Anthropic({ apiKey: 'no-network', fetch: respond as unknown as typeof fetch, maxRetries: 0 }), asked };
}

/** The people's tabs, with `host` (by index) saying Remy is on the call it hosts. */
function hosting(people: PresenceState, host: number | null): PresenceState {
  const keys = Object.keys(people);
  return Object.fromEntries(keys.map((key, index) => [key, index === host ? people[key]!.map((meta) => ({ ...(meta as object), call: { remy: true, thread: null } })) : people[key]!]));
}

describe('greeting a call', () => {
  it('greets once, naming who called her in, and not again when the host moves to the next tab', async () => {
    const db = new FakeDb();
    const transport = new FakeTransport();
    const model = claude();
    let clock = Date.parse('2026-11-11T20:00:00Z');
    const agent = new ProjectAgent({
      projectId: db.projectId,
      store: db,
      transport,
      client: model.client,
      models: { analysis: 'claude-sonnet-5-5', chat: 'claude-sonnet-5-5' },
      log: silentLogger,
      debounce: { presence: 0, workflow: 5, plan: 5 },
      openingDelayMs: 0,
      watchTickMs: 0,
      now: () => new Date(clock),
    });
    await agent.start();
    const greetings = () => model.asked.filter((text) => text.includes('type="call_joined"'));
    const both = presenceOf('pm', 'cm');
    const firstName = (Object.values(both)[0]![0] as { name: string }).name;

    // Chris calls Remy in.
    transport.presence(db.projectId, hosting(both, 0));
    await agent.idle();
    expect(greetings()).toHaveLength(1);
    expect(greetings()[0]).toContain(`On the call: ${firstName}.`);

    // Minutes later Chris leaves, and Deepak's tab takes over hosting a few seconds after.
    clock += 4 * 60_000;
    transport.presence(db.projectId, hosting(both, null));
    await agent.idle();
    clock += 5_000;
    transport.presence(db.projectId, hosting(both, 1));
    await agent.idle();
    expect(greetings()).toHaveLength(1);

    // The call ends; a new one well after is a new call.
    clock += 60_000;
    transport.presence(db.projectId, hosting(both, null));
    await agent.idle();
    clock += CALL_GAP_MS + 1_000;
    transport.presence(db.projectId, hosting(both, 0));
    await agent.idle();
    expect(greetings()).toHaveLength(2);
    await agent.stop();
  });
});
