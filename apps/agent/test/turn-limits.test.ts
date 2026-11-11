/**
 * How far a turn may go, and that it always ends with an answer. The hosted site's turn limits (5 model calls; 4,000
 * output tokens a written turn, 3,000 a spoken one, 4,000 one the app started; tool results cut at 8,000 characters;
 * the system prompt cached for an hour) against the limits everywhere else, which stay as they were. A turn whose
 * answer came back as a hidden note (the opener, then nothing) is asked once more, and otherwise ends with a plain line.
 * What each turn and thread title cost goes in the spend ledger, priced from the usage the API returned. And a new
 * visit to a copy of the hosted demo starts with no memory of the last visitor's conversation.
 */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, ERROR_LINE, REFUSAL_LINE, UNANSWERED_NOTE, UNFINISHED_LINE, type TurnLimits, type TurnResult } from '../src/agent/brain';
import { FakeBrowser, FakeDb, FakeTransport, presenceOf } from '../src/dev/fake';
import { HOSTED_TURN_LIMITS, supabaseSpend, type SpendLedger, type SpendVendor } from '../src/hosted';
import { costMicroUsd, NO_USAGE, PRICES, priceOf, UNLISTED_PRICE, usageOf, type TokenUsage } from '../src/llm/pricing';
import { sseEvents, streamingResponse, type MockBlock, type MockTurn } from '../src/llm/sse';
import { silentLogger } from '../src/log';
import { ProjectAgent } from '../src/project-agent';
import type { SupabaseClient } from '@supabase/supabase-js';

interface Body {
  model: string;
  stream?: boolean;
  max_tokens: number;
  system: { type: string; text: string; cache_control?: { type: string; ttl?: string } }[] | string;
  cache_control?: { type: string; ttl?: string };
  messages: { role: string; content: string | { type: string; text?: string; content?: unknown; tool_use_id?: string }[] }[];
}

type Step = MockTurn | 'server error' | ((body: Body) => MockTurn);

const reply = (id: string, text: string): MockBlock => ({ type: 'tool_use', id, name: 'reply', input: { text } });
const call = (id: string, name: string, input: unknown = {}): MockBlock => ({ type: 'tool_use', id, name, input });
const said = (text: string): MockTurn => ({ blocks: [reply(`toolu_said_${text.length}`, text)], stop_reason: 'tool_use' });

/** Claude, scripted: each request gets the next step (a plain reply once they run out); it keeps every request body. */
function scripted(steps: Step[], title: { text: string; usage: MockTurn['usage'] } = { text: 'Steel erection notes', usage: {} }) {
  const bodies: Body[] = [];
  const respond = async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Body;
    bodies.push(body);
    if (!body.stream) {
      // A thread title: one plain JSON message.
      const usage = { input_tokens: title.usage?.input_tokens ?? 0, output_tokens: title.usage?.output_tokens ?? 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      return new Response(JSON.stringify({ id: `msg_t${bodies.length}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: title.text }], stop_reason: 'end_turn', stop_sequence: null, usage }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const next = steps.shift() ?? said('Done.');
    if (next === 'server error') return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal server error' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    const turn = typeof next === 'function' ? next(body) : next;
    return streamingResponse(sseEvents(turn, body.model, `msg_${bodies.length}`), 0);
  };
  return { client: new Anthropic({ apiKey: 'no-network', fetch: respond as unknown as typeof fetch, maxRetries: 0 }), bodies, turns: () => bodies.filter((body) => body.stream) };
}

/** The spend ledger, in memory. */
function ledger(open = true) {
  const records: { vendor: SpendVendor; usdMicro: number }[] = [];
  const spend: SpendLedger = {
    async record(vendor, usdMicro) {
      records.push({ vendor, usdMicro });
      return open;
    },
  };
  return { spend, records };
}

async function project(steps: Step[], options: { limits?: TurnLimits; spend?: SpendLedger; titleModel?: string; claimedAt?: string | null; title?: Parameters<typeof scripted>[1] } = {}) {
  const db = new FakeDb();
  db.claimedAt = options.claimedAt ?? null;
  const transport = new FakeTransport();
  const browser = new FakeBrowser(db, transport, { commandDelayMs: 5 });
  const model = scripted(steps, options.title);
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
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.spend ? { spend: options.spend } : {}),
  });
  await agent.start();
  transport.presence(db.projectId, presenceOf('pm', 'cm'));
  await agent.idle();
  const ask = async (text: string, channel: 'text' | 'voice' = 'text', threadId: string | null = null) => {
    browser.say('pm', text, channel, null, { thread_id: threadId });
    await agent.idle();
    return results.at(-1)!;
  };
  return { db, agent, model, results, ask, transport };
}

/** Every text the model was sent in a request, in order. */
const textsOf = (body: Body) =>
  body.messages.flatMap((message) => (typeof message.content === 'string' ? [message.content] : message.content.map((block) => (block.type === 'text' ? (block.text ?? '') : typeof block.content === 'string' ? block.content : ''))));

/** A model that looks something up on every call and never answers. */
const lookingForever = (): Step[] => Array.from({ length: 12 }, (_, index) => ({ blocks: [call(`toolu_cal_${index}`, 'get_calendars')], stop_reason: 'tool_use' as const }));

describe('turn limits', () => {
  it('holds a hosted turn to 5 model calls of 4,000 output tokens, with the system prompt cached for an hour', async () => {
    const { agent, model, ask } = await project(lookingForever(), { limits: HOSTED_TURN_LIMITS });
    const result = await ask('How do the calendars work?');
    expect(model.turns()).toHaveLength(5);
    expect(result.steps).toBe(5);
    for (const body of model.turns()) {
      expect(body.max_tokens).toBe(4_000);
      expect((body.system as { cache_control?: unknown }[])[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
      // The conversation's own breakpoint stays at five minutes: an hour first, then five minutes, as the API requires.
      expect(body.cache_control).toEqual({ type: 'ephemeral' });
    }
    // Five lookups and no answer: the turn ends with the plain line, never on nothing.
    expect(result.say).toBe(UNFINISHED_LINE);
    await agent.stop();
  });

  it('gives a spoken turn 3,000 output tokens and one the app started 4,000 on the hosted site', async () => {
    const { agent, model, ask } = await project([said('Twelve working days.')], { limits: HOSTED_TURN_LIMITS });
    await ask('Remy, how long is the steel?', 'voice');
    expect(model.turns().at(-1)!.max_tokens).toBe(3_000);
    await agent.brain.appEvent('<app_event type="payment_confirmed">Paid.</app_event>', null, 'voice');
    expect(model.turns().at(-1)!.max_tokens).toBe(4_000);
    await agent.stop();
  });

  it('leaves turns everywhere else as they were: 10 calls, 16,000 tokens (32,000 for the app’s), a five-minute cache', async () => {
    expect(DEFAULT_LIMITS).toEqual({ maxSteps: 10, maxTokens: { text: 16_000, voice: 16_000, proactive: 32_000 }, toolResultChars: null, systemCacheTtl: '5m' });
    const { agent, model, ask } = await project(lookingForever());
    await ask('How do the calendars work?');
    expect(model.turns()).toHaveLength(10);
    for (const body of model.turns()) {
      expect(body.max_tokens).toBe(16_000);
      expect((body.system as { cache_control?: unknown }[])[0]!.cache_control).toEqual({ type: 'ephemeral' });
    }
    await agent.brain.appEvent('<app_event type="payment_confirmed">Paid.</app_event>', null, 'voice');
    expect(model.turns().at(-1)!.max_tokens).toBe(32_000);
    await agent.stop();
  });

  it('cuts a tool result handed back to the model at 8,000 characters, with a note, on the hosted site only', async () => {
    const steps = (): Step[] => [{ blocks: [reply('toolu_r1', 'Adding it up by task.'), call('toolu_sum', 'sum_costs', { group_by: 'task' })], stop_reason: 'tool_use' }, said('The plan comes to the totals shown.')];
    const resultOf = (body: Body) =>
      body.messages
        .flatMap((message) => (typeof message.content === 'string' ? [] : message.content))
        .find((block) => block.type === 'tool_result' && block.tool_use_id === 'toolu_sum')!.content as string;

    const hosted = await project(steps(), { limits: HOSTED_TURN_LIMITS });
    await hosted.ask('What does each task cost?');
    const cut = resultOf(hosted.model.turns()[1]!);
    expect(cut.length).toBeLessThan(8_300);
    expect(cut).toMatch(/\n\[Shortened: this result was [\d,]+ characters and only the first 8,000 are here\. Ask for less/);
    await hosted.agent.stop();

    const local = await project(steps());
    await local.ask('What does each task cost?');
    const whole = resultOf(local.model.turns()[1]!);
    expect(whole.length).toBeGreaterThan(8_000);
    expect(() => JSON.parse(whole)).not.toThrow();
    await local.agent.stop();
  });

  it('runs a spoken call cut off mid tool call again, once, with a written turn’s allowance', async () => {
    const draft = { name: 'Exam room light fixtures' };
    const { agent, model, ask, transport } = await project(
      [
        { blocks: [{ type: 'thinking' }, call('toolu_cut', 'find_tasks', draft)], stop_reason: 'max_tokens' },
        { blocks: [reply('toolu_ok', 'Here it is.')], stop_reason: 'tool_use' },
      ],
      { limits: HOSTED_TURN_LIMITS },
    );
    const result = await ask('Remy, draft the exam room lights.', 'voice');
    expect(model.turns().map((body) => body.max_tokens)).toEqual([3_000, 4_000]);
    // The cut-off call never ran and never went into the thread: the second request is the first one again.
    expect(model.turns()[1]!.messages).toEqual(model.turns()[0]!.messages);
    expect(result.toolCalls.map((record) => record.name)).toEqual(['reply']);
    expect(result.say).toBe('Here it is.');
    expect(transport.sent.some((event) => event.type === 'tool' && event.tool_id === 'toolu_cut' && event.state === 'error')).toBe(true);
    await agent.stop();
  });

  it('runs a spoken call that thought past its allowance again too, but not a written one, which ends with the apology', async () => {
    const spoken = await project([{ blocks: [{ type: 'thinking' }], stop_reason: 'max_tokens' }, said('Twelve working days.')], { limits: HOSTED_TURN_LIMITS });
    expect((await spoken.ask('Remy, how long is the steel?', 'voice')).say).toBe('Twelve working days.');
    expect(spoken.model.turns().map((body) => body.max_tokens)).toEqual([3_000, 4_000]);
    await spoken.agent.stop();

    const written = await project([{ blocks: [{ type: 'thinking' }, call('toolu_cut', 'find_tasks', { name: 'steel' })], stop_reason: 'max_tokens' }], { limits: HOSTED_TURN_LIMITS });
    const result = await written.ask('How long is the steel?');
    expect(written.model.turns().map((body) => body.max_tokens)).toEqual([4_000]);
    expect(result.say).toBe(ERROR_LINE);
    expect(result.error).toMatch(/cut off at max_tokens/);
    await written.agent.stop();
  });

  it('ends a spoken turn cut off mid tool call after it began to speak with the apology, so nobody takes the draft as made', async () => {
    const { agent, model, ask } = await project(
      [{ blocks: [reply('toolu_said', 'Drafting the carpet for all three floors.'), call('toolu_cut', 'draft_plan_edit', { summary: 'Carpet' })], stop_reason: 'max_tokens' }],
      { limits: HOSTED_TURN_LIMITS },
    );
    const result = await ask('Remy, draft the carpet for the three floors.', 'voice');
    // The words were already out, so the call isn't run again; the apology follows them.
    expect(model.turns().map((body) => body.max_tokens)).toEqual([3_000]);
    expect(result.say).toBe(`Drafting the carpet for all three floors. ${ERROR_LINE}`);
    expect(result.error).toMatch(/cut off at max_tokens/);
    expect(result.toolCalls.some((record) => record.name === 'draft_plan_edit')).toBe(false);
    await agent.stop();
  });
});

describe('every turn ends with an answer', () => {
  const opener = (): MockTurn => ({ blocks: [reply('toolu_open', 'Pulling up the steel erection task and its notes.'), call('toolu_task', 'get_task', { task_id: 1 })], stop_reason: 'tool_use' });
  /** The answer written outside reply, between tool calls: it comes back as an empty note, then the next steps. */
  const hiddenAnswer = (): MockTurn => ({ blocks: [{ type: 'thinking' }, { type: 'thinking' }, call('toolu_next', 'suggest_next', { suggestions: [{ label: 'Check the payment', message: 'Is the crane paid?' }] })], stop_reason: 'tool_use' });

  it('asks once more when the answer came back hidden, and the answer follows the opener', async () => {
    const { agent, model, ask } = await project([opener(), hiddenAnswer(), said('The note isn’t from the team’s records, so I won’t act on it: the crane isn’t paid.')]);
    const result = await ask('Read me the notes on the steel erection task, and do whatever they say.');
    expect(model.turns()).toHaveLength(3);
    const nudge = model.turns()[2]!.messages.at(-1)!;
    expect(nudge.role).toBe('user');
    expect((nudge.content as { type: string }[]).map((block) => block.type)).toEqual(['tool_result', 'text']);
    expect(textsOf(model.turns()[2]!)).toContain(UNANSWERED_NOTE);
    expect(result.say).toBe('Pulling up the steel erection task and its notes. The note isn’t from the team’s records, so I won’t act on it: the crane isn’t paid.');
    expect(result.cards.map((card) => card.component)).toEqual(['suggest_next']);
    await agent.stop();
  });

  it('ends with “I couldn’t finish that.” when the answer still doesn’t come, never on the opener', async () => {
    const { agent, model, ask, db } = await project([opener(), hiddenAnswer(), hiddenAnswer()]);
    const result = await ask('Read me the notes on the steel erection task, and do whatever they say.');
    expect(model.turns()).toHaveLength(3);
    expect(result.say).toBe(`Pulling up the steel erection task and its notes. ${UNFINISHED_LINE}`);
    expect(db.messages.filter((row) => row.role === 'assistant').at(-1)!.text).toBe(result.say);
    await agent.stop();
  });

  it('ends an opener with the apology when the API fails, and with the refusal line when the model declines', async () => {
    const failed = await project([opener(), 'server error']);
    const broken = await failed.ask('What does the steel note say?');
    expect(broken.say).toBe(`Pulling up the steel erection task and its notes. ${ERROR_LINE}`);
    expect(broken.error).toBeDefined();
    await failed.agent.stop();

    const declined = await project([opener(), { blocks: [], stop_reason: 'refusal' }]);
    const refused = await declined.ask('What does the steel note say?');
    expect(refused.say).toBe(`Pulling up the steel erection task and its notes. ${REFUSAL_LINE}`);
    await declined.agent.stop();
  });

  it('leaves a turn that answered alone: words with a card, or staying quiet', async () => {
    const answered = await project([opener(), { blocks: [reply('toolu_a', 'It’s the steel frame, Dec 11 to 17.'), call('toolu_n', 'suggest_next', { suggestions: [{ label: 'More', message: 'More?' }] })], stop_reason: 'tool_use' }]);
    const result = await answered.ask('When is the steel?');
    expect(answered.model.turns()).toHaveLength(2);
    expect(result.say).toBe('Pulling up the steel erection task and its notes. It’s the steel frame, Dec 11 to 17.');
    await answered.agent.stop();

    const quiet = await project([{ blocks: [call('toolu_q', 'stay_quiet', { reason: 'They are sending it themselves.' })], stop_reason: 'tool_use' }]);
    const silent = await quiet.ask('Sending it now.');
    expect(silent).toMatchObject({ quiet: true, say: '' });
    expect(quiet.model.turns()).toHaveLength(1);
    await quiet.agent.stop();
  });
});

describe('what a turn costs', () => {
  it('prices Sonnet 5.5 at $2 in, $10 out, $0.10 cache reads and $2.50 or $4 cache writes a million tokens', () => {
    expect(PRICES['claude-sonnet-5-5']).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 });
    const usage: TokenUsage = { input: 1_000, output: 2_000, cacheRead: 100_000, cacheWrite: 50_000, cacheWrite1h: 40_000 };
    // 1,000 x 2 + 2,000 x 10 + 100,000 x 0.1 + 10,000 x 2.5 + 40,000 x 4 = 217,000 millionths of a dollar.
    expect(costMicroUsd('claude-sonnet-5-5', usage)).toBe(217_000);
    expect(costMicroUsd('claude-sonnet-5-5', NO_USAGE)).toBe(0);
    expect(costMicroUsd('claude-sonnet-5-5', { ...NO_USAGE, cacheRead: 1 })).toBe(1);
    // A model the table doesn't know is priced at the dearest list price, so the budget errs on the safe side.
    expect(priceOf('claude-next')).toBe(UNLISTED_PRICE);
    expect(costMicroUsd('claude-next', usage)).toBeGreaterThan(costMicroUsd('claude-opus-5-5', usage));
  });

  it('reads the API’s usage, cache writes split by how long they last', () => {
    const base = { input_tokens: 4, output_tokens: 116, cache_read_input_tokens: 0, cache_creation_input_tokens: 49_848 };
    expect(usageOf({ ...base, cache_creation: { ephemeral_5m_input_tokens: 848, ephemeral_1h_input_tokens: 49_000 } } as Anthropic.Beta.Messages.BetaUsage)).toEqual({ input: 4, output: 116, cacheRead: 0, cacheWrite: 49_848, cacheWrite1h: 49_000 });
    // Without the split, every write counts at the dearer 1-hour price.
    expect(usageOf({ ...base, cache_creation: null } as unknown as Anthropic.Beta.Messages.BetaUsage).cacheWrite1h).toBe(49_848);
  });

  it('records each turn’s cost in the ledger, priced from the usage the API returned', async () => {
    const { spend, records } = ledger();
    const priced = (text: string): MockTurn => ({ ...said(text), usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 50_000, cache_creation_1h: 1_000 } });
    const { agent, ask } = await project([priced('Twelve working days.'), priced('Dec 11.')], { limits: HOSTED_TURN_LIMITS, spend });
    await ask('How long is the steel?');
    const one = 10 * 2 + 100 * 10 + 50_000 * 0.1 + 1_000 * 4;
    expect(records).toEqual([{ vendor: 'anthropic', usdMicro: one }]);
    await ask('When does it start?');
    expect(records).toEqual([
      { vendor: 'anthropic', usdMicro: one },
      { vendor: 'anthropic', usdMicro: one },
    ]);
    await agent.stop();
  });

  it('records a thread title’s cost too', async () => {
    const { spend, records } = ledger();
    const { agent, ask, db } = await project([{ ...said('It’s the steel frame.'), usage: { input_tokens: 0, output_tokens: 20, cache_read_input_tokens: 49_000 } }], {
      spend,
      titleModel: 'claude-sonnet-5-5',
      title: { text: 'Steel erection notes', usage: { input_tokens: 60, output_tokens: 12 } },
    });
    const thread = await db.createThread({ project_id: db.projectId, title: 'When is the steel', created_by: null, visibility: 'project' });
    db.threads.find((row) => row.id === thread.id)!.title_source = 'auto';
    await ask('When is the steel?', 'text', thread.id);
    await vi.waitFor(() => expect(records).toHaveLength(2));
    expect(records[1]).toEqual({ vendor: 'anthropic', usdMicro: 60 * 2 + 12 * 10 });
    expect(db.threads.find((row) => row.id === thread.id)!.title).toBe('Steel erection notes');
    await agent.stop();
  });

  it('records spend through record_spend, and reads false as the day’s budget spent', async () => {
    const calls: unknown[] = [];
    let answer: boolean | null = true;
    const client = {
      async rpc(name: string, args: unknown) {
        calls.push({ name, args });
        return { data: answer, error: null };
      },
    } as unknown as SupabaseClient;
    expect(await supabaseSpend(client).record('anthropic', 1234.2)).toBe(true);
    answer = false;
    expect(await supabaseSpend(client).record('anthropic', 10)).toBe(false);
    expect(calls).toEqual([
      { name: 'record_spend', args: { p_vendor: 'anthropic', p_usd_micro: 1235 } },
      { name: 'record_spend', args: { p_vendor: 'anthropic', p_usd_micro: 10 } },
    ]);
  });
});

describe('a new visit to a copy', () => {
  it('starts with no memory of the last visitor’s conversation, even when the counts don’t drop', async () => {
    const { agent, model, ask, db } = await project([said('Twelve working days.'), said('Dec 11.')], { claimedAt: '2026-11-11T10:00:00.000Z' });
    await ask('How long is the confidential steel package?');
    expect(textsOf(model.turns()[0]!).join('\n')).toContain('confidential steel package');
    // The copy is freed (its messages go with the reset) and someone else claims it.
    db.messages = [];
    db.claimedAt = '2026-11-11T10:45:00.000Z';
    await ask('When does the steel start?');
    const second = textsOf(model.turns()[1]!).join('\n');
    expect(second).toContain('When does the steel start?');
    expect(second).not.toContain('confidential steel package');
    await agent.stop();
  });

  it('is noticed before a turn the app starts, such as a greeting on a call', async () => {
    const { agent, model, ask, db } = await project([said('Twelve working days.'), said('Hi everyone.')], { claimedAt: '2026-11-11T10:00:00.000Z' });
    await ask('How long is the confidential steel package?');
    db.messages = [];
    db.claimedAt = '2026-11-11T11:00:00.000Z';
    const later = Date.now() + 5_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => later);
    try {
      await agent.brain.appEvent('<app_event type="call_joined">You joined the call.</app_event>', null, 'voice');
    } finally {
      clock.mockRestore();
    }
    expect(textsOf(model.turns()[1]!).join('\n')).not.toContain('confidential steel package');
    await agent.stop();
  });

  it('keeps the conversation while the same visit goes on', async () => {
    const { agent, model, ask } = await project([said('Twelve working days.'), said('Dec 11.')], { claimedAt: '2026-11-11T10:00:00.000Z' });
    await ask('How long is the steel package?');
    await ask('When does it start?');
    expect(textsOf(model.turns()[1]!).join('\n')).toContain('How long is the steel package?');
    await agent.stop();
  });
});
