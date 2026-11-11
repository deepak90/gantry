/**
 * The hosted site's limits on the assistant (GANTRY_HOSTED=1): before a turn runs the model, the live AI switch and the
 * copy's allowance are checked, and a message over 600 characters is refused; a turn they stop is one plain reply,
 * streamed and stored, with no model call. Without them, turns run as before, on the same system prompt.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { TurnResult } from '../src/agent/brain';
import { HOSTED_RULE, SYSTEM_PROMPT, systemPromptFor } from '../src/agent/prompts';
import { FakeBrowser, FakeDb, FakeTransport, presenceOf } from '../src/dev/fake';
import { describeConfig, readConfig } from '../src/env';
import { startHealthServer } from '../src/health';
import { admitFor, LIMIT_REPLY, MAX_MESSAGE_CHARS, supabaseLimits, TOO_LONG_REPLY, UNAVAILABLE_REPLY, type HostedLimits } from '../src/hosted';
import { sseEvents, streamingResponse } from '../src/llm/sse';
import { silentLogger } from '../src/log';
import { ProjectAgent } from '../src/project-agent';

/** The database's side of the limits, in memory: the switch, the allowance left, and whether it answers at all. */
function limits(state: { liveAi?: boolean; allowance?: number; down?: boolean } = {}) {
  const asked: string[] = [];
  let allowance = state.allowance ?? 40;
  const impl: HostedLimits = {
    async liveAi() {
      asked.push('liveAi');
      if (state.down) throw new Error('the database did not answer');
      return state.liveAi ?? true;
    },
    async useTurn(projectId) {
      asked.push(`useTurn ${projectId}`);
      if (allowance <= 0) return false;
      allowance -= 1;
      return true;
    },
  };
  return { impl, asked, left: () => allowance };
}

describe('the gate', () => {
  const PROJECT = '00000000-0000-4000-8000-000000010007';

  it('lets a turn run while live AI is on and the copy has turns left, spending one', async () => {
    const db = limits({ allowance: 2 });
    const admit = admitFor(PROJECT, db.impl, silentLogger);
    expect(await admit({ person: true, text: 'What sets the handover date?' })).toBeNull();
    expect(await admit({ person: false, text: null })).toBeNull();
    expect(db.left()).toBe(0);
    expect(db.asked).toEqual(['liveAi', `useTurn ${PROJECT}`, 'liveAi', `useTurn ${PROJECT}`]);
  });

  it('answers with the limit line once the allowance is spent, or while live AI is off', async () => {
    expect(await admitFor(PROJECT, limits({ allowance: 0 }).impl, silentLogger)({ person: true, text: 'Hi' })).toEqual({ reason: 'quota', say: LIMIT_REPLY });
    const off = limits({ liveAi: false });
    expect(await admitFor(PROJECT, off.impl, silentLogger)({ person: true, text: 'Hi' })).toEqual({ reason: 'off', say: LIMIT_REPLY });
    expect(off.asked).toEqual(['liveAi']);
    expect(LIMIT_REPLY).toBe("I've reached today's limit for this session. The rest of the app still works.");
  });

  it('refuses a message over 600 characters politely, before spending anything', async () => {
    const db = limits();
    const admit = admitFor(PROJECT, db.impl, silentLogger);
    expect(await admit({ person: true, text: 'x'.repeat(MAX_MESSAGE_CHARS + 1) })).toEqual({ reason: 'too_long', say: TOO_LONG_REPLY });
    expect(db.asked).toEqual([]);
    expect(await admit({ person: true, text: `  ${'x'.repeat(MAX_MESSAGE_CHARS)}  ` })).toBeNull();
  });

  it('runs nothing when the limits cannot be checked', async () => {
    expect(await admitFor(PROJECT, limits({ down: true }).impl, silentLogger)({ person: true, text: 'Hi' })).toEqual({ reason: 'unavailable', say: UNAVAILABLE_REPLY });
  });
});

describe('the limits in the database', () => {
  function client(state: { flags?: { key: string; enabled: boolean }[]; quota?: boolean; broken?: string }) {
    const calls: unknown[] = [];
    const fake = {
      from(table: string) {
        let key: unknown;
        const query = {
          select: () => query,
          eq: (_column: string, value: unknown) => {
            key = value;
            return query;
          },
          maybeSingle: async () =>
            state.broken === table ? { data: null, error: { message: 'relation does not exist' } } : { data: (state.flags ?? []).find((flag) => flag.key === key) ?? null, error: null },
        };
        return query;
      },
      async rpc(name: string, args: unknown) {
        calls.push({ name, args });
        return state.broken === name ? { data: null, error: { message: 'function does not exist' } } : { data: state.quota ?? true, error: null };
      },
    };
    return { client: fake as unknown as SupabaseClient, calls };
  }

  it('reads the live AI switch, off unless it says on', async () => {
    expect(await supabaseLimits(client({ flags: [{ key: 'live_ai', enabled: true }, { key: 'live_calls', enabled: false }] }).client).liveAi()).toBe(true);
    expect(await supabaseLimits(client({ flags: [{ key: 'live_ai', enabled: false }] }).client).liveAi()).toBe(false);
    expect(await supabaseLimits(client({ flags: [{ key: 'live_calls', enabled: true }] }).client).liveAi()).toBe(false);
  });

  it('spends a turn through use_quota', async () => {
    const { client: db, calls } = client({ quota: false });
    expect(await supabaseLimits(db).useTurn('p-1')).toBe(false);
    expect(calls).toEqual([{ name: 'use_quota', args: { p_kind: 'ai_turn', p_project: 'p-1' } }]);
  });

  it('throws when the switch or the quota function is missing', async () => {
    await expect(supabaseLimits(client({ broken: 'app_flags' }).client).liveAi()).rejects.toThrow(/app_flags/);
    await expect(supabaseLimits(client({ broken: 'use_quota' }).client).useTurn('p-1')).rejects.toThrow(/use_quota/);
  });
});

/** Claude, scripted: every request answers with one reply; it counts the requests and keeps their system prompts. */
function claude() {
  const systems: string[] = [];
  const respond = async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model: string; system?: { text: string }[] };
    systems.push(body.system?.[0]?.text ?? '');
    return streamingResponse(sseEvents({ blocks: [{ type: 'tool_use', id: `toolu_${systems.length}`, name: 'reply', input: { text: 'Twelve working days.' } }], stop_reason: 'tool_use' }, body.model, `msg_${systems.length}`), 0);
  };
  return { client: new Anthropic({ apiKey: 'no-network', fetch: respond as unknown as typeof fetch, maxRetries: 0 }), systems };
}

async function project(options: { hosted?: HostedLimits; titleModel?: string } = {}) {
  const db = new FakeDb();
  const transport = new FakeTransport();
  const browser = new FakeBrowser(db, transport, { commandDelayMs: 5 });
  const model = claude();
  const results: TurnResult[] = [];
  const agent = new ProjectAgent({
    projectId: db.projectId,
    store: db,
    transport,
    client: model.client,
    models: { analysis: 'claude-sonnet-5-5', chat: 'claude-sonnet-5-5' },
    titleModel: options.titleModel ?? null,
    log: silentLogger,
    debounce: { presence: 0, workflow: 5, plan: 5 },
    openingDelayMs: 0,
    raiseIssues: false,
    onTurn: (result) => results.push(result),
    ...(options.hosted ? { admit: admitFor(db.projectId, options.hosted, silentLogger), systemPrompt: systemPromptFor(true) } : {}),
  });
  await agent.start();
  transport.presence(db.projectId, presenceOf('pm', 'cm'));
  await agent.idle();
  const ask = async (text: string, channel: 'text' | 'voice' = 'text', threadId: string | null = null) => {
    browser.say('pm', text, channel, null, { thread_id: threadId });
    await agent.idle();
    return results.at(-1)!;
  };
  return { db, transport, agent, model, results, ask };
}

describe('the site’s own rule', () => {
  it('keeps the placeholder names out of her mouth and says how to get a second approver', () => {
    expect(HOSTED_RULE).toContain('never call anyone by name');
    expect(HOSTED_RULE).toContain('"you" to the person you\'re answering');
    expect(HOSTED_RULE).toContain('Open a teammate in a new tab');
    // The rule is the site's alone: local runs and the film keep calling people by name.
    expect(SYSTEM_PROMPT).not.toContain('never call anyone by name');
  });
});

describe('turns on the hosted site', () => {
  it('runs a turn within the limits, on the system prompt with the site’s rule, spending one turn', async () => {
    const db = limits({ allowance: 5 });
    const { agent, model, ask } = await project({ hosted: db.impl });
    const result = await ask('How long is the steel?');
    expect(result.say).toBe('Twelve working days.');
    expect(result.refused).toBeUndefined();
    expect(model.systems).toHaveLength(1);
    expect(model.systems[0]).toBe(SYSTEM_PROMPT + HOSTED_RULE);
    expect(db.left()).toBe(4);
    await agent.stop();
  });

  it('answers with the plain limit line, stored and streamed, and calls no model, once the copy is out of turns', async () => {
    const { agent, model, ask, db, transport } = await project({ hosted: limits({ allowance: 0 }).impl });
    const result = await ask('How long is the steel?');
    expect(result).toMatchObject({ say: LIMIT_REPLY, refused: 'quota', steps: 0, cards: [], model: 'none' });
    expect(model.systems).toEqual([]);
    const stored = db.messages.filter((row) => row.role === 'assistant');
    expect(stored.map((row) => [row.text, row.channel, row.turn_id === result.turnId])).toEqual([[LIMIT_REPLY, 'text', true]]);
    const turn = transport.sent.filter((event) => event.turn_id === result.turnId).map((event) => event.type);
    expect(turn[0]).toBe('turn_start');
    expect(turn).toContain('text_delta');
    expect(turn.at(-1)).toBe('turn_end');
    await agent.stop();
  });

  it('says the limit line on a call, where Remy speaks it', async () => {
    const { agent, model, ask, db } = await project({ hosted: limits({ liveAi: false }).impl });
    const result = await ask('Remy, how long is the steel?', 'voice');
    expect(result).toMatchObject({ say: LIMIT_REPLY, refused: 'off', channel: 'voice' });
    expect(db.messages.filter((row) => row.role === 'assistant').map((row) => row.channel)).toEqual(['voice']);
    expect(model.systems).toEqual([]);
    await agent.stop();
  });

  it('refuses a long message politely without spending a turn', async () => {
    const db = limits({ allowance: 3 });
    const { agent, model, ask } = await project({ hosted: db.impl });
    const result = await ask('Please '.repeat(100));
    expect(result).toMatchObject({ say: TOO_LONG_REPLY, refused: 'too_long' });
    expect(model.systems).toEqual([]);
    expect(db.left()).toBe(3);
    await agent.stop();
  });

  it('does not name a thread after a refused turn, which would call a model', async () => {
    const setup = await project({ hosted: limits({ allowance: 0 }).impl, titleModel: 'claude-sonnet-5-5' });
    const thread = await setup.db.createThread({ project_id: setup.db.projectId, title: 'How long is the steel', created_by: null, visibility: 'project' });
    setup.db.threads.find((row) => row.id === thread.id)!.title_source = 'auto';
    const result = await setup.ask('How long is the steel?', 'text', thread.id);
    expect(result.refused).toBe('quota');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(setup.model.systems).toEqual([]);
    expect(setup.db.threads.find((row) => row.id === thread.id)!.title_source).toBe('auto');
    await setup.agent.stop();
  });
});

describe('turns without GANTRY_HOSTED', () => {
  it('run as before: no limits asked, the system prompt as it was', async () => {
    const { agent, model, ask } = await project();
    const result = await ask('How long is the steel?');
    expect(result.say).toBe('Twelve working days.');
    expect(result.refused).toBeUndefined();
    expect(model.systems).toEqual([SYSTEM_PROMPT]);
    expect(systemPromptFor(false)).toBe(SYSTEM_PROMPT);
    const long = await ask('Please '.repeat(100));
    expect(long.refused).toBeUndefined();
    expect(model.systems).toHaveLength(2);
    await agent.stop();
  });
});

describe('configuration and the health check', () => {
  it('is hosted only with GANTRY_HOSTED=1, and says so', () => {
    expect(readConfig({} as NodeJS.ProcessEnv).hosted).toBe(false);
    expect(readConfig({ GANTRY_HOSTED: '0' } as NodeJS.ProcessEnv).hosted).toBe(false);
    const hosted = readConfig({ GANTRY_HOSTED: '1', AGENT_MODEL_ANALYSIS: 'claude-sonnet-5-5' } as NodeJS.ProcessEnv);
    expect(hosted).toMatchObject({ hosted: true, models: { analysis: 'claude-sonnet-5-5', chat: 'claude-sonnet-5-5' } });
    expect(describeConfig(hosted)).toMatch(/hosted/);
    expect(describeConfig(readConfig({} as NodeJS.ProcessEnv))).not.toMatch(/hosted/);
  });

  it('answers /healthz while running, and 503 once it failed', async () => {
    let ok = true;
    const server = startHealthServer(0, () => ({ ok, stage: ok ? 'answering' : 'failed to start' }), silentLogger);
    await new Promise((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, stage: 'answering' });
    ok = false;
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    await new Promise((resolve) => server.close(resolve));
  });
});
