/**
 * Progress payments on Harbor Street Offices, as in the film: the footings are done, and the slab waits for their
 * payment. Remy reads what is due from the plan the way the payment card works it out (each firm's earned value less
 * the 10% kept back until handover), when it falls due and the Friday it would normally go out; and when PayPal
 * confirms the payment, the app event names who was paid and what it releases. Each firm's amount is its own
 * (Granite Ridge's is not the payout's total), and a payout over the project's threshold needs a second person.
 */
import { harborOffices, HARBOR_IDS } from '@collab/shared/seed';
import { describe, expect, it } from 'vitest';
import { paymentConfirmedFacts, progressPayments, runPaymentTool, type ProgressPaymentView } from '../src/agent/payment-tools';
import { paymentConfirmedEvent, SYSTEM_PROMPT } from '../src/agent/prompts';
import { planFromRows, type PlanRows } from '../src/plan/rows';

const DEEPAK = '00000000-0000-4000-8000-000000000012';
const CHRIS = '00000000-0000-4000-8000-000000000011';

/** Harbor's two people who see costs, as the database has them, and one of the crowd who doesn't. */
function people(): Pick<PlanRows, 'members' | 'profiles'> {
  return {
    members: [
      { user_id: DEEPAK, role: 'cm', approval_limit_minor: 25_000_000, can_view_costs: true },
      { user_id: CHRIS, role: 'pm', approval_limit_minor: 25_000_000, can_view_costs: true },
      { user_id: '00000000-0000-4000-8000-0000000000c1', role: 'pm', approval_limit_minor: 0, can_view_costs: false },
    ],
    profiles: [
      { user_id: DEEPAK, display_name: 'Deepak Jayaram' },
      { user_id: CHRIS, display_name: 'Chris Hale' },
      { user_id: '00000000-0000-4000-8000-0000000000c1', display_name: 'Marcus Webb (sim)' },
    ],
  } as Pick<PlanRows, 'members' | 'profiles'>;
}

function harbor(changes: Record<string, unknown>[] = []): PlanRows {
  return {
    project: {
      id: HARBOR_IDS.project,
      name: harborOffices.name,
      currency: 'USD',
      current_revision: 1,
      handover_task_id: harborOffices.handover_task_id,
      snapshot: harborOffices.inlineData as unknown as PlanRows['project']['snapshot'],
    },
    revisions: changes.length ? [{ revision_no: 1, changes: { tasks: { updated: changes } } }] : [],
    bookings: [],
    members: [],
    profiles: [],
  };
}

describe('progress payments', () => {
  it('are read from the plan as the payment card works them out', () => {
    const [footings, ...others] = progressPayments(planFromRows(harbor()));
    expect(others).toEqual([]);
    expect(footings).toMatchObject({ state: 'waiting', retainage_percent: 10, batch_id: null });
    expect(footings!.pays_for.length).toBeGreaterThan(0);
    expect(footings!.holds.length).toBeGreaterThan(0);
    // What is due is each firm's earned value less what is kept back, summed.
    expect(footings!.payout_total_minor).toBe(footings!.firms.reduce((sum, firm) => sum + firm.due_minor, 0));
    for (const firm of footings!.firms) expect(firm.due_minor).toBe(firm.earned_minor - firm.retained_minor - firm.paid_before_minor);
    // It falls due the day the work it waits on is done, as the payment card says; it would go out that week's Friday.
    const plan = planFromRows(harbor());
    const lastEnd = plan.dependencies.filter((link) => link.to === footings!.gate_id).map((link) => plan.tasks.find((task) => task.id === link.from)!.end).sort().at(-1)!;
    expect(footings!.due_on < lastEnd).toBe(true);
    expect(new Date(`${footings!.pay_run_on}T12:00:00Z`).getUTCDay()).toBe(5);
    expect(footings!.pay_run_on >= footings!.due_on).toBe(true);
  });

  it('are found by a firm’s name, and none for a firm with no work in one', () => {
    const plan = planFromRows(harbor());
    const firm = progressPayments(plan)[0]!.firms[0]!.firm;
    expect((runPaymentTool('get_progress_payments', { firm: firm.split(' ')[0] }, { plan }) as { payments: unknown[] }).payments).toHaveLength(1);
    expect((runPaymentTool('get_progress_payments', { firm: 'Nobody Ltd' }, { plan }) as { payments: unknown[]; note: string }).note).toContain('No progress payment');
  });

  it('name who was paid and what it releases once PayPal confirms one', () => {
    const plan = planFromRows(harbor());
    const gate = progressPayments(plan)[0]!;
    const paid = planFromRows(harbor([{ id: gate.gate_id, payGate: { pays: plan.tasks.find((task) => task.id === gate.gate_id)!.payGate!.pays, retainage: 0.1, state: 'paid', batchId: 'MOCK-PG-1', paidAt: '2026-11-10T15:00:00.000Z', amountMinor: gate.payout_total_minor, error: null } }]));
    const facts = paymentConfirmedFacts(paid, gate.gate_id)!;
    expect(facts).toMatchObject({ state: 'paid', batch_id: 'MOCK-PG-1', paid_minor: gate.payout_total_minor });
    const event = paymentConfirmedEvent({ ...facts, paid_text: '$37,800' }, '2026-11-10T15:00:05.000Z', 'voice');
    expect(event).toContain('type="payment_confirmed"');
    expect(event).toContain('channel="voice"');
    expect(event).toContain('MOCK-PG-1');
    for (const firm of facts.firms) expect(event).toContain(firm.firm);
    expect(event).toMatch(/<released>.+starting \w{3}, \w{3} \d+/);
  });
});

describe('each firm’s own share', () => {
  const footings = () => progressPayments(planFromRows(harbor()))[0]!;

  it('gives Granite Ridge its own $31,320, not the $37,800 the payout sends to both firms', () => {
    const payment = footings();
    expect(payment.payout_total_minor).toBe(3_780_000);
    expect(payment.payout_total_text).toBe('$37,800');
    expect(payment.firm_count).toBe(2);
    const granite = payment.firms.find((firm) => firm.firm === 'Granite Ridge Concrete')!;
    expect(granite).toMatchObject({ value_minor: 3_480_000, value_text: '$34,800', retained_minor: 348_000, retained_text: '$3,480', due_minor: 3_132_000, due_text: '$31,320', percent_done: 100 });
    expect(granite.work).toEqual(['Form footings', 'Rebar, footings', 'Pour footings']);
    const pinecrest = payment.firms.find((firm) => firm.firm === 'Pinecrest Sitework')!;
    expect(pinecrest).toMatchObject({ value_minor: 720_000, due_minor: 648_000, due_text: '$6,480' });
    expect(pinecrest.work).toEqual(['Strip forms and backfill']);
  });

  it('answers a question about one firm with that firm’s amount, then the payout it goes out in', () => {
    const plan = planFromRows(harbor());
    const result = runPaymentTool('get_progress_payments', { firm: 'Granite Ridge' }, { plan }) as { asked_about: Record<string, unknown>[]; payments: ProgressPaymentView[]; note: string };
    expect(result.asked_about).toEqual([
      {
        firm: 'Granite Ridge Concrete',
        payment: 'Footings paid',
        due_minor: 3_132_000,
        due_text: '$31,320',
        work: ['Form footings', 'Rebar, footings', 'Pour footings'],
        others_in_payout: [{ firm: 'Pinecrest Sitework', due_text: '$6,480', work: ['Strip forms and backfill'] }],
        payout_total_text: '$37,800',
      },
    ]);
    expect(result.note).toMatch(/own share/);
    // Asked about no firm in particular: no asked_about, just the payments.
    expect(runPaymentTool('get_progress_payments', {}, { plan })).not.toHaveProperty('asked_about');
  });
});

describe('the two-person rule', () => {
  it('says the footings payout needs a second person, and who can sign it, from the plan’s people', () => {
    const plan = planFromRows({ ...harbor(), ...people() });
    expect(progressPayments(plan)[0]!.approval).toEqual({
      rule: 'Payouts over $25,000 need a second person who sees costs to approve them before they go out.',
      over_minor: 2_500_000,
      over_text: '$25,000',
      needs_second_person: true,
      who_can_sign: ['Deepak Jayaram', 'Chris Hale'],
      who_can_approve: ['Deepak Jayaram', 'Chris Hale'],
    });
  });

  it('never offers the person asking as their own approver, and has nobody when they are the only one who signs', () => {
    const rows = { ...harbor(), ...people() };
    const plan = planFromRows(rows);
    const deepak = plan.members.find((member) => member.name === 'Deepak Jayaram')!;
    expect(progressPayments(plan, deepak.userId)[0]!.approval.who_can_approve).toEqual(['Chris Hale']);
    const alone = planFromRows({ ...rows, members: rows.members.filter((member) => member.user_id !== CHRIS) });
    const answer = runPaymentTool('get_progress_payments', {}, { plan: alone, speaker: { userId: deepak.userId } }) as { payments: { approval: { who_can_sign: string[]; who_can_approve: string[] } }[] };
    expect(answer.payments[0]!.approval.who_can_sign).toEqual(['Deepak Jayaram']);
    expect(answer.payments[0]!.approval.who_can_approve).toEqual([]);
  });

  it('follows the project’s own threshold when it has one', () => {
    const rows = { ...harbor(), ...people() };
    const plan = planFromRows({ ...rows, project: { ...rows.project, second_approval_over_minor: 5_000_000 } });
    expect(progressPayments(plan)[0]!.approval).toMatchObject({ over_minor: 5_000_000, over_text: '$50,000', needs_second_person: false });
  });

  it('leaves out anyone who doesn’t see costs or whose approval limit is too low', () => {
    const rows = { ...harbor(), ...people() };
    const plan = planFromRows({ ...rows, members: rows.members.map((member) => (member.user_id === CHRIS ? { ...member, approval_limit_minor: 3_000_000 } : member)) });
    expect(progressPayments(plan)[0]!.approval.who_can_sign).toEqual(['Deepak Jayaram']);
  });

  it('is in Remy’s guidance: the rule from the data, a second person signs, and she never presses Send or Approve', () => {
    expect(SYSTEM_PROMPT).toContain('needs_second_person');
    expect(SYSTEM_PROMPT).toContain('who_can_sign');
    expect(SYSTEM_PROMPT).toContain('from who_can_approve (never the person asking)');
    expect(SYSTEM_PROMPT).toContain('You never press Send payout or Approve');
    expect(SYSTEM_PROMPT).toContain('Never give the payout total as one firm');
    expect(SYSTEM_PROMPT).toContain('"Slab on grade" is "the ground floor"');
  });
});
