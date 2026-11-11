/**
 * The plan's date on the server (GANTRY_PLAN_DATE): the hosted service reads the plan on the film's day, Tue, Nov 10,
 * 2026, as the site does. The configuration reads it (and fly.toml sets it), the system prompt names it, the app
 * events the model reads carry it with the real time of day, and the watch rules and the watch-list tool count from
 * it, while a daily rule still runs at its time on the real clock.
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { evaluateWatch, type WatchRuleRow } from '@collab/shared';
import { addDays, SEED_IDS } from '@collab/shared/seed';
import { describe, expect, it } from 'vitest';
import { HOSTED_RULE, planDateRule, SYSTEM_PROMPT, systemPromptFor } from '../src/agent/prompts';
import { runDataTool, type ToolContext } from '../src/agent/tools';
import { WatchRunner } from '../src/agent/watch';
import { FakeDb, FakeTransport, presenceOf } from '../src/dev/fake';
import { describeConfig, readConfig } from '../src/env';
import { sseEvents, streamingResponse } from '../src/llm/sse';
import { silentLogger } from '../src/log';
import { planFromRows } from '../src/plan/rows';
import { planDay, planStamp } from '../src/plan/today';
import { watchPlanFrom } from '../src/plan/watch';
import { ProjectAgent } from '../src/project-agent';

/** A visit a month after the film: Wed, Dec 9, 2026, 3:42 PM in New York. */
const VISIT = new Date('2026-12-09T20:42:10.500Z');

const at = '2026-10-25T00:00:00.000Z';
function rule(overrides: Partial<WatchRuleRow> = {}): WatchRuleRow {
  return {
    id: '00000000-0000-4000-8000-00000000e001',
    project_id: SEED_IDS.project,
    name: 'Starting soon',
    scope: { kind: 'plan' },
    condition: { kind: 'starts_soon', days: 20 },
    trigger: { kind: 'daily', at: '07:00' },
    action: { kind: 'alert' },
    enabled: true,
    created_by: null,
    thread_id: null,
    created_at: at,
    updated_at: at,
    ...overrides,
  };
}

/** A day on which the seed plan has unstarted work starting within 20 days, and one long after its last start. */
function daysOf(db: FakeDb): { before: string; after: string } {
  const starts = planFromRows(db.plan)
    .tasks.filter((task) => task.isLeaf && task.percentDone === 0)
    .map((task) => task.start)
    .sort();
  return { before: addDays(starts[0]!, -5), after: addDays(starts.at(-1)!, 30) };
}

describe('the configuration', () => {
  it('reads GANTRY_PLAN_DATE as a day, says so, and refuses anything else', () => {
    expect(readConfig({} as NodeJS.ProcessEnv).planDate).toBeNull();
    expect(readConfig({ GANTRY_PLAN_DATE: ' ' } as NodeJS.ProcessEnv).planDate).toBeNull();
    expect(readConfig({ GANTRY_PLAN_DATE: ' 2026-11-10 ' } as NodeJS.ProcessEnv).planDate).toBe('2026-11-10');
    for (const value of ['Nov 10', '2026-02-30', '2026-1-5', 'today']) expect(() => readConfig({ GANTRY_PLAN_DATE: value } as NodeJS.ProcessEnv), value).toThrow(/GANTRY_PLAN_DATE/);
    expect(describeConfig(readConfig({ GANTRY_PLAN_DATE: '2026-11-10' } as NodeJS.ProcessEnv))).toContain('plan date 2026-11-10');
    expect(describeConfig(readConfig({} as NodeJS.ProcessEnv))).not.toContain('plan date');
  });

  it('pins the hosted service to the film’s day in fly.toml, beside GANTRY_HOSTED', () => {
    const toml = readFileSync(new URL('../fly.toml', import.meta.url), 'utf8');
    const env = toml.slice(toml.indexOf('[env]'), toml.indexOf('\n[', toml.indexOf('[env]') + 1));
    expect(env).toContain('GANTRY_HOSTED = "1"');
    expect(env).toContain('GANTRY_PLAN_DATE = "2026-11-10"');
  });
});

describe('the plan’s today', () => {
  it('is the pinned day, or the day it is now', () => {
    expect(planDay('2026-11-10', VISIT)).toBe('2026-11-10');
    expect(planDay(null, new Date(2026, 11, 9, 15, 42))).toBe('2026-12-09');
  });

  it('stamps an app event with the pinned day at the real time, or the real time', () => {
    expect(planStamp('2026-11-10', VISIT)).toBe('2026-11-10T20:42:10.500Z');
    expect(planStamp(null, VISIT)).toBe('2026-12-09T20:42:10.500Z');
  });

  it('is named in the system prompt, after the site’s rule, and nowhere when it is not pinned', () => {
    expect(planDateRule('2026-11-10')).toBe(
      '\n\nThe plan\'s date\n- For this plan, today is Tue, Nov 10, 2026: what is due, late or coming up, "today" and Friday\'s pay run all count from that day. Times on messages, plan changes and payments are real and can be later.',
    );
    expect(systemPromptFor(true, '2026-11-10')).toBe(SYSTEM_PROMPT + HOSTED_RULE + planDateRule('2026-11-10'));
    expect(systemPromptFor(false, '2026-11-10')).toBe(SYSTEM_PROMPT + planDateRule('2026-11-10'));
    expect(systemPromptFor(true)).toBe(SYSTEM_PROMPT + HOSTED_RULE);
    expect(systemPromptFor(false, null)).toBe(SYSTEM_PROMPT);
  });
});

describe('the watch list on the pinned day', () => {
  it('reads the plan on the pinned day, and runs a daily rule at its time on the real clock', async () => {
    const db = new FakeDb();
    const { before, after } = daysOf(db);
    db.watchRules.push(rule());
    const plan = planFromRows(db.plan);
    // Long after the plan's last start, on the real clock: nothing would start soon.
    let clock = new Date(`${after}T06:59:00`);
    expect(evaluateWatch(db.watchRules, watchPlanFrom(plan, planDay(null, clock)), { canViewCosts: false, currency: 'USD' })).toEqual([]);
    const runner = new WatchRunner({ projectId: db.projectId, store: db, plan: () => plan, log: silentLogger, now: () => clock, planDate: before });
    await runner.request('tick');
    expect(db.watchRuns).toHaveLength(0);
    clock = new Date(`${after}T07:01:00`);
    await runner.request('tick');
    expect(db.watchRuns.length).toBeGreaterThan(0);
    // The seed's first unstarted work starts five days after the pinned day.
    expect(db.watchRuns.map((run) => run.title)).toEqual([expect.stringMatching(/start within 20 days$/)]);
  });

  it('answers the watch-list tool on the pinned day', async () => {
    const db = new FakeDb();
    const { before, after } = daysOf(db);
    const plan = planFromRows(db.plan);
    const ctx: ToolContext = {
      plan,
      workflow: db.workflow,
      issues: new Map(),
      speaker: plan.members[0]!,
      present: plan.members,
      library: db.library,
      drafts: new Map(),
      edits: new Map(),
      history: { rows: db.plan, decisions: [] },
      watch: { rules: [rule({ trigger: { kind: 'change' } })], open: [] },
      refresh: async () => undefined,
    };
    const raised = async (planDate: string) => ((await runDataTool('get_watch_list' as never, {}, { ...ctx, planDate })) as { rules: { raises_now: unknown[] }[] }).rules[0]!.raises_now;
    expect((await raised(before)).length).toBeGreaterThan(0);
    expect(await raised(after)).toEqual([]);
  });
});

/** Claude, scripted: one reply to every request; it keeps each request's system prompt and last message. */
function claude() {
  const asked: { system: string; text: string }[] = [];
  const respond = async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model: string; system?: { text: string }[]; messages: { content: { type: string; text?: string }[] }[] };
    const last = body.messages.at(-1)?.content ?? [];
    asked.push({ system: body.system?.[0]?.text ?? '', text: last.map((block) => block.text ?? '').join('') });
    return streamingResponse(sseEvents({ blocks: [{ type: 'tool_use', id: `toolu_${asked.length}`, name: 'reply', input: { text: 'Hi all, how can I help?' } }], stop_reason: 'tool_use' }, body.model, `msg_${asked.length}`), 0);
  };
  return { client: new Anthropic({ apiKey: 'no-network', fetch: respond as unknown as typeof fetch, maxRetries: 0 }), asked };
}

describe('what the model reads on the hosted service', () => {
  it('names the plan’s day in the system prompt, and stamps Remy joining a call with it at the real time', async () => {
    const db = new FakeDb();
    const transport = new FakeTransport();
    const model = claude();
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
      now: () => VISIT,
      systemPrompt: systemPromptFor(true, '2026-11-10'),
      planDate: '2026-11-10',
    });
    await agent.start();
    // The host's tab says Remy is on its call.
    const people = presenceOf('pm', 'cm');
    const host = Object.keys(people)[0]!;
    transport.presence(db.projectId, { ...people, [host]: people[host]!.map((meta) => ({ ...(meta as object), call: { remy: true, thread: null } })) });
    await agent.idle();
    const greeting = model.asked.find((request) => request.text.includes('type="call_joined"'));
    expect(greeting?.text).toContain('at="2026-11-10T20:42:10.500Z"');
    expect(greeting?.system).toContain('For this plan, today is Tue, Nov 10, 2026');
    await agent.stop();
  });
});
