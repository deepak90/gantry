/**
 * The watch list on the server: the plan as the rules read it (the seed's idle crane shows up from its
 * booking, with no amounts in what every member reads), which runs open and close, when daily rules
 * are due, and the whole loop in the agent: a rule that asks the assistant opens a private conversation
 * for its author, says what it found, and the assistant looks into it there; a situation that comes
 * back within ten minutes opens a run but no second conversation; a saved rule is checked at once.
 */
import { describe, expect, it } from 'vitest';
import { evaluateWatch, type WatchAlert, type WatchRuleRow, type WatchRunRow } from '@collab/shared';
import { SEED_IDS } from '@collab/shared/seed';
import { WatchRunner } from '../src/agent/watch';
import { FakeDb, FakeTransport } from '../src/dev/fake';
import { makeClient } from '../src/llm/client';
import { silentLogger } from '../src/log';
import { planFromRows } from '../src/plan/rows';
import { diffRuns, dueDailyRules, watchPlanFrom } from '../src/plan/watch';
import { ProjectAgent } from '../src/project-agent';

const at = '2026-10-25T00:00:00.000Z';
const planOf = (db: FakeDb) => planFromRows(db.plan);

function rule(overrides: Partial<WatchRuleRow> = {}): WatchRuleRow {
  return {
    id: '00000000-0000-4000-8000-00000000e001',
    project_id: SEED_IDS.project,
    name: 'Idle crane',
    scope: { kind: 'plan' },
    condition: { kind: 'idle_rental' },
    trigger: { kind: 'change' },
    action: { kind: 'alert' },
    enabled: true,
    created_by: null,
    thread_id: null,
    created_at: at,
    updated_at: at,
    ...overrides,
  };
}

function run(overrides: Partial<WatchRunRow>): WatchRunRow {
  return {
    id: '00000000-0000-4000-8000-00000000f001',
    project_id: SEED_IDS.project,
    rule_id: '00000000-0000-4000-8000-00000000e001',
    situation: 'x',
    fingerprint: 'x',
    severity: 'medium',
    title: '',
    detail: '',
    task_ids: [],
    revision: 0,
    thread_id: null,
    fired_at: at,
    resolved_at: null,
    ...overrides,
  };
}

const alert = (ruleId: string, situation: string): WatchAlert => ({ ruleId, ruleName: 'r', condition: 'idle_rental', situation, fingerprint: `${situation}:1`, severity: 'high', title: situation, detail: '', taskIds: [] });

describe('the plan as the rules read it', () => {
  it('shows the seed crane paid while idle before its task, without amounts for everyone', () => {
    const db = new FakeDb();
    const plan = planOf(db);
    const booking = plan.bookings[0]!;
    const view = watchPlanFrom(plan, '2026-10-25');
    const rented = view.tasks.find((task) => task.id === booking.taskId)!;
    expect(rented.idle).toMatchObject({ equipment: 'Crane' });
    expect(rented.idle!.days).toBeGreaterThan(0);
    expect(rented.idle!.costMinor).toBe(rented.idle!.days * booking.rentalRateMinor);
    expect(view.tasks.filter((task) => task.idle)).toHaveLength(1);
    // Slack comes from the agent's own backward pass: leaves have it, groups do not.
    expect(view.tasks.filter((task) => task.isLeaf).every((task) => task.slackDays !== null)).toBe(true);
    const [found] = evaluateWatch([rule()], view, { canViewCosts: false, currency: 'USD' });
    expect(found!.title).toMatch(new RegExp(`^Crane booked ${rented.idle!.days} days with no work planned on .+$`));
    expect(found!.title).not.toMatch(/\$/);
    expect(found!.situation).toBe(`${rule().id}:${rented.id}`);
  });
});

describe('runs', () => {
  it('opens a run for a new situation, closes one that is gone, and leaves the rest alone', () => {
    const a = rule({ id: 'rule-a' });
    const open = [run({ id: 'run-1', rule_id: 'rule-a', situation: 'a:1' }), run({ id: 'run-2', rule_id: 'rule-a', situation: 'a:2' }), run({ id: 'run-3', rule_id: 'rule-b', situation: 'b:1' })];
    const { fire, resolve } = diffRuns([a], [alert('rule-a', 'a:1'), alert('rule-a', 'a:3'), alert('rule-a', 'a:3'), alert('rule-b', 'b:9')], open);
    expect(fire.map((item) => item.situation)).toEqual(['a:3']);
    expect(resolve.map((item) => item.id)).toEqual(['run-2']);
  });

  it('runs a daily rule once a day, after its time', () => {
    const rules = [rule({ id: 'd', trigger: { kind: 'daily', at: '07:00' } }), rule({ id: 'c' }), rule({ id: 'off', trigger: { kind: 'daily', at: '06:00' }, enabled: false })];
    expect(dueDailyRules(rules, new Date(2026, 9, 25, 6, 59), new Map())).toEqual([]);
    expect(dueDailyRules(rules, new Date(2026, 9, 25, 7, 0), new Map()).map((item) => item.id)).toEqual(['d']);
    expect(dueDailyRules(rules, new Date(2026, 9, 25, 9, 0), new Map([['d', '2026-10-25']]))).toEqual([]);
    expect(dueDailyRules(rules, new Date(2026, 9, 26, 7, 30), new Map([['d', '2026-10-25']])).map((item) => item.id)).toEqual(['d']);
  });

  it('checks daily rules at their time, not on every change, and not for a time that passed before it started', async () => {
    const db = new FakeDb();
    db.watchRules.push(rule({ id: 'soon', name: 'Starting soon', condition: { kind: 'starts_soon', days: 20 }, trigger: { kind: 'daily', at: '07:00' } }));
    let clock = new Date(2026, 9, 25, 6, 59);
    const plan = planOf(db);
    const runner = new WatchRunner({ projectId: db.projectId, store: db, plan: () => plan, log: silentLogger, now: () => clock });
    await runner.request('change');
    await runner.request('tick');
    expect(db.watchRuns).toHaveLength(0);
    clock = new Date(2026, 9, 25, 7, 1);
    await runner.request('tick');
    expect(db.watchRuns.length).toBeGreaterThan(0);
    expect(db.watchRuns.every((item) => item.revision === null && /starts (today|tomorrow|in \d+ days)/.test(item.title))).toBe(true);
    const count = db.watchRuns.length;
    await runner.request('tick');
    expect(db.watchRuns).toHaveLength(count);

    const late = new FakeDb();
    late.watchRules.push(rule({ id: 'soon', condition: { kind: 'starts_soon', days: 20 }, trigger: { kind: 'daily', at: '07:00' } }));
    clock = new Date(2026, 9, 25, 8, 0);
    const restarted = new WatchRunner({ projectId: late.projectId, store: late, plan: () => plan, log: silentLogger, now: () => clock });
    await restarted.request('tick');
    expect(late.watchRuns).toHaveLength(0);
    clock = new Date(2026, 9, 26, 7, 0);
    await restarted.request('tick');
    expect(late.watchRuns.length).toBeGreaterThan(0);
  });
});

describe('the watch list in the agent', () => {
  function setup() {
    const db = new FakeDb();
    const transport = new FakeTransport();
    const agent = new ProjectAgent({
      projectId: db.projectId,
      store: db,
      transport,
      client: makeClient('mock', { delayMs: 0 }),
      models: { analysis: 'claude-opus-5-5', chat: 'claude-sonnet-5-5' },
      log: silentLogger,
      debounce: { presence: 0, workflow: 5, plan: 5 },
      openingDelayMs: 0,
      watchTickMs: 0,
    });
    return { db, transport, agent };
  }

  it('reads rental dates someone changed and checks the rules again, with no change to the plan', async () => {
    const { db, transport, agent } = setup();
    db.saveWatchRule({ name: 'Idle crane', scope: { kind: 'plan' }, condition: { kind: 'idle_rental' }, action: { kind: 'ask_assistant', note: 'Suggest how to stop paying for idle days.' }, created_by: SEED_IDS.cmUser });
    await agent.start();
    await agent.idle();
    expect(db.watchRuns[0]!.resolved_at).toBeNull();

    const booking = db.plan.bookings[0]!;
    booking.billable_start = planOf(db).tasks.find((task) => task.id === booking.task_id)!.start;
    transport.workflowChanged(db.projectId, 'equipment_bookings');
    await agent.idle();
    expect(db.watchRuns[0]!.resolved_at).not.toBeNull();
  });

  it('opens a private conversation for the author of a rule that asks the assistant, once in ten minutes', async () => {
    const { db, transport, agent } = setup();
    const saved = db.saveWatchRule({ name: 'Idle crane', scope: { kind: 'plan' }, condition: { kind: 'idle_rental' }, action: { kind: 'ask_assistant', note: 'Suggest how to stop paying for idle days.' }, created_by: SEED_IDS.cmUser });
    await agent.start();
    await agent.idle();

    expect(db.watchRuns).toHaveLength(1);
    const [fired] = db.watchRuns;
    expect(fired).toMatchObject({ rule_id: saved.id, revision: 0, resolved_at: null });
    expect(fired!.title).not.toMatch(/\$/);
    expect(db.threads).toHaveLength(1);
    const [thread] = db.threads;
    expect(thread).toMatchObject({ title: 'Idle crane', created_by: SEED_IDS.cmUser, visibility: 'private', title_source: 'person' });
    expect(fired!.thread_id).toBe(thread!.id);
    const said = db.messages.filter((message) => message.thread_id === thread!.id);
    expect(said[0]!.text).toMatch(/^Your watch rule “Idle crane” spoke up: Crane booked \d+ days with no work planned on .+\. Looking into it now\.$/);
    // Only Chris (who sees costs) reads it: the assistant gives the figures and the issue with its fix offer.
    const answer = said.at(-1)!;
    expect(answer.role).toBe('assistant');
    expect(answer.text).toMatch(/\$[\d,]+/);
    expect(answer.cards.map((card) => card.component)).toEqual(['show_issue_card']);
    // It streamed on the private thread's own topic.
    expect(transport.topics.some((topic) => topic?.endsWith(`:thread:${thread!.id}`))).toBe(true);

    // The crane arrives with its work: the situation is gone, its run closes.
    const booking = db.plan.bookings[0]!;
    const original = booking.billable_start;
    const rented = planOf(db).tasks.find((task) => task.id === booking.task_id)!;
    booking.billable_start = rented.start;
    db.plan.project.current_revision = 1;
    transport.revision(db.projectId);
    await agent.idle();
    expect(db.watchRuns[0]!.resolved_at).not.toBeNull();

    // It comes back a minute later: a new run, but no second conversation within ten minutes.
    booking.billable_start = original;
    db.plan.project.current_revision = 2;
    transport.revision(db.projectId);
    await agent.idle();
    expect(db.watchRuns).toHaveLength(2);
    expect(db.watchRuns[1]).toMatchObject({ revision: 2, thread_id: null, resolved_at: null });
    expect(db.threads).toHaveLength(1);
  });

  it('still checks a saved rule when the notice about it never arrives', async () => {
    const { db, agent } = setup();
    await agent.start();
    await agent.idle();
    db.saveWatchRule({ name: 'Crane idle', scope: { kind: 'plan' }, condition: { kind: 'idle_rental' }, created_by: SEED_IDS.pmUser });
    expect(db.watchRuns).toHaveLength(0);
    await agent.watch.request('tick');
    await agent.idle();
    expect(db.watchRuns).toHaveLength(1);
  });

  it('checks a rule as soon as it is saved, and closes its runs when it is paused', async () => {
    const { db, transport, agent } = setup();
    await agent.start();
    await agent.idle();
    expect(db.watchRuns).toHaveLength(0);

    const saved = db.saveWatchRule({ name: 'Crane idle', scope: { kind: 'plan' }, condition: { kind: 'idle_rental' }, created_by: SEED_IDS.pmUser });
    transport.workflowChanged(db.projectId, 'watch_rules');
    await agent.idle();
    expect(db.watchRuns).toHaveLength(1);
    // "Show it on the watch list" opens no conversation.
    expect(db.threads).toHaveLength(0);
    // Its own writes do not set it off again.
    transport.workflowChanged(db.projectId, 'watch_runs');
    await agent.idle();
    expect(db.watchRuns).toHaveLength(1);

    db.saveWatchRule({ id: saved.id, name: 'Crane idle', scope: { kind: 'plan' }, condition: { kind: 'idle_rental' }, enabled: false });
    transport.workflowChanged(db.projectId, 'watch_rules');
    await agent.idle();
    expect(db.watchRuns.every((item) => item.resolved_at !== null)).toBe(true);
    expect(db.watchRuns).toHaveLength(1);
  });

  it('shares the conversation with the project when the rule has no author, and keeps amounts out of it', async () => {
    const { db, agent } = setup();
    // One role for everyone, but a teammate who cannot see costs is on the project.
    db.addMember({ display_name: 'Sam Ortiz' });
    db.saveWatchRule({ name: 'Idle rental', scope: { kind: 'plan' }, condition: { kind: 'idle_rental' }, action: { kind: 'ask_assistant' } });
    await agent.start();
    await agent.idle();
    const [thread] = db.threads;
    expect(thread).toMatchObject({ created_by: null, visibility: 'project' });
    const said = db.messages.filter((message) => message.thread_id === thread!.id);
    expect(said[0]!.text).toMatch(/^The watch rule “Idle rental” spoke up/);
    // Sam (no cost access) reads a thread shared with the project: the reply withholds amounts.
    expect(said.at(-1)!.text).not.toMatch(/\$\s?\d/);
  });
});
