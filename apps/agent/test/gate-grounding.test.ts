import { describe, expect, it } from 'vitest';
import type { AgentMessageRow } from '@collab/shared';
import { FakeDb } from '../src/dev/fake';
import { groundCard, ungroundedAmounts } from '../src/agent/grounding';
import { ProactiveGate } from '../src/agent/proactive';
import { findIssues } from '../src/plan/detectors';
import { planFromRows } from '../src/plan/rows';
import type { PlanMember } from '../src/plan/snapshot';
import { EMPTY_WORKFLOW } from '../src/workflow/state';

const db = new FakeDb();
const plan = planFromRows(db.plan);
// One role for everyone: both seed people see costs. Sam and Kim are teammates who cannot.
const [priya, chris] = plan.members as [PlanMember, PlanMember];
const sam: PlanMember = { ...priya, userId: 'sam', name: 'Sam Ortiz', role: 'pm', canViewCosts: false, approvalLimitMinor: 0 };
const kim: PlanMember = { ...sam, userId: 'kim', name: 'Kim Lee' };

describe('proactive gate', () => {
  it('waits for a second person and someone who sees costs, raises once, ignores later triggers; snooze holds for 30 minutes', () => {
    let now = 0;
    const gate = new ProactiveGate(() => now);
    expect(gate.decide({ kind: 'person_joined', member: priya, present: [priya] }, plan, EMPTY_WORKFLOW, [priya]).wake).toBe(false);
    // Two teammates who cannot see costs: nobody there could approve a fix, so no opening yet.
    expect(gate.decide({ kind: 'person_joined', member: kim, present: [sam, kim] }, plan, EMPTY_WORKFLOW, [sam, kim])).toMatchObject({ wake: false, reason: 'waiting for a second person, and someone who sees costs' });
    expect(gate.decide({ kind: 'person_joined', member: sam, present: [chris, sam] }, plan, EMPTY_WORKFLOW, [chris, sam]).wake).toBe(true);
    const first = gate.decide({ kind: 'meeting_started', present: [priya, chris] }, plan, EMPTY_WORKFLOW, [priya, chris]);
    expect(first.wake).toBe(true);
    gate.markRaised(first.issue!.id);
    expect(gate.decide({ kind: 'plan_changed', revision: 1 }, plan, EMPTY_WORKFLOW, [priya, chris]).wake).toBe(false);

    const fresh = new ProactiveGate(() => now);
    fresh.snooze(first.issue!.id);
    expect(fresh.decide({ kind: 'meeting_started', present: [priya, chris] }, plan, EMPTY_WORKFLOW, [priya, chris]).wake).toBe(false);
    now += 31 * 60_000;
    expect(fresh.decide({ kind: 'meeting_started', present: [priya, chris] }, plan, EMPTY_WORKFLOW, [priya, chris]).wake).toBe(true);
  });

  it('sleeps with nobody present', () => {
    const gate = new ProactiveGate();
    expect(gate.decide({ kind: 'meeting_started', present: [] }, plan, EMPTY_WORKFLOW, []).wake).toBe(false);
  });

  it('with raising off, waits to be asked: no opening, no plan-change turn', () => {
    const gate = new ProactiveGate(Date.now, { raiseIssues: false });
    expect(gate.decide({ kind: 'meeting_started', present: [priya, chris] }, plan, EMPTY_WORKFLOW, [priya, chris]).wake).toBe(false);
    expect(gate.decide({ kind: 'person_joined', member: chris, present: [priya, chris] }, plan, EMPTY_WORKFLOW, [priya, chris]).wake).toBe(false);
    expect(gate.decide({ kind: 'plan_changed', revision: 2 }, plan, EMPTY_WORKFLOW, [priya, chris]).wake).toBe(false);
  });
});

describe('gate memory from the thread', () => {
  const issue = findIssues(plan)[0]!;
  const row = (overrides: Partial<AgentMessageRow>): AgentMessageRow => ({
    id: crypto.randomUUID(),
    project_id: plan.projectId,
    turn_id: null,
    role: 'assistant',
    author_id: null,
    channel: 'app',
    text: '',
    cards: [],
    action: null,
    created_at: new Date().toISOString(),
    ...overrides,
  });

  it('counts an issue as raised only while the thread holds its card', () => {
    const gate = new ProactiveGate();
    gate.syncFrom([row({ cards: [{ id: 'toolu_1', component: 'show_issue_card', props: { issue_id: issue.id } }] })]);
    expect(gate.decide({ kind: 'meeting_started', present: [priya, chris] }, plan, EMPTY_WORKFLOW, [priya, chris]).wake).toBe(false);
    gate.syncFrom([]);
    expect(gate.decide({ kind: 'meeting_started', present: [priya, chris] }, plan, EMPTY_WORKFLOW, [priya, chris]).wake).toBe(true);
  });

  it('honors a "Not now" in the thread for 30 minutes only', () => {
    const notNow = (minutesAgo: number) =>
      row({ role: 'person', author_id: chris.userId, channel: 'text', text: 'Not now', action: { kind: 'not_now', issue_id: issue.id }, created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() });
    const gate = new ProactiveGate();
    gate.syncFrom([notNow(5)]);
    expect(gate.decide({ kind: 'meeting_started', present: [priya, chris] }, plan, EMPTY_WORKFLOW, [priya, chris]).wake).toBe(false);
    gate.syncFrom([notNow(31)]);
    expect(gate.decide({ kind: 'meeting_started', present: [priya, chris] }, plan, EMPTY_WORKFLOW, [priya, chris]).wake).toBe(true);
  });
});

describe('grounding', () => {
  const issue = findIssues(plan)[0]!;
  const ctx = { issues: new Map([[issue.id, issue]]), knownMinor: new Set<number>([480000, 500000]) };
  const card = {
    issue_id: issue.id,
    headline: 'The crane sits idle',
    detail: 'A day either side keeps cover and comes to $4,800',
    severity: 'high',
    money: { label: 'Idle rental', amount: '2400.00' },
    timeline: null,
    facts: [],
    remedy: null,
    actions: [],
  };

  it('passes a card whose numbers came from the tools', () => {
    expect(groundCard('show_issue_card', card, ctx)).toEqual([]);
  });

  it('holds back made-up amounts and an unknown issue', () => {
    expect(groundCard('show_issue_card', { ...card, money: { label: 'Idle rental', amount: '1600.00' } }, ctx).join()).toMatch(/1600.00 is not an amount/);
    expect(groundCard('show_issue_card', { ...card, detail: 'Saves $1,750' }, ctx).join()).toMatch(/\$1750.00/);
    expect(groundCard('show_issue_card', { ...card, issue_id: 'made-up' }, ctx).join()).toMatch(/was not returned/);
    expect(groundCard('show_choices', { question: 'Which?', choices: [{ label: 'Saves $1,234', reply: 'That one' }, { label: 'Keep it', reply: 'Keep it' }] }, ctx).join()).toMatch(/1234.00/);
  });

  it('finds ungrounded amounts in free text, but zero needs no source', () => {
    expect(ungroundedAmounts('We pay $2,400 and $0 so far, not $77', new Set([240000]))).toEqual([7700]);
  });
});
