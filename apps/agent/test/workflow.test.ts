import { describe, expect, it } from 'vitest';
import { FakeBrowser, FakeDb, FakeTransport } from '../src/dev/fake';
import { planFromRows } from '../src/plan/rows';
import { describeChange, diffWorkflow } from '../src/workflow/progress';
import { fixStatus, groupApprovals, latestProposal } from '../src/workflow/state';
import { ProposeFixArgs, ReviseFixArgs, type ApprovalRow } from '@collab/shared';
import { SEED_IDS } from '@collab/shared/seed';

async function withProposal() {
  const db = new FakeDb();
  const transport = new FakeTransport();
  transport.connect(db.projectId, { onPresence() {}, onWorkflowChange() {}, onRevision() {}, onAgentMessage() {} });
  const browser = new FakeBrowser(db, transport);
  const plan = planFromRows(db.plan);
  const check = { booking_id: plan.bookings[0]!.id, inputs: { new_start: '2026-12-11', new_end: '2026-12-18' } };
  const id = await db.insertCommand({ project_id: db.projectId, type: 'propose_fix', args: ProposeFixArgs.parse({ booking_id: check.booking_id, inputs: check.inputs, reason: 'x' }), requested_by: SEED_IDS.pmUser, required_revision: 0 });
  await browser.runCommand(id);
  return { db, browser, plan };
}

describe('the approval chain', () => {
  it('has the app’s five steps: one approval by anyone who sees costs, then the plan, PayPal, the receipt', async () => {
    const { db, browser, plan } = await withProposal();
    let status = fixStatus(plan, db.workflow, latestProposal(db.workflow)!)!;
    expect(status.chain.map((step) => step.label)).toEqual(['Fix proposed', 'Fix approved', 'Plan updated', 'Paid with PayPal', 'Receipt filed']);
    expect(status.chain.map((step) => `${step.key}:${step.status}`)).toEqual(['proposed:done', 'approved:current', 'in_plan:todo', 'paid:todo', 'receipt:todo']);
    expect(status.chain[1]).toMatchObject({ who: 'Chris or Deepak', note: 'One click approves the new dates and the $4,200.00 payment together' });
    expect(status.next).toBe('Chris or Deepak approves the fix with one click: the new dates and the payment together.');
    expect(status).toMatchObject({ approvers: ['Chris Hale', 'Deepak Jayaram'], approved: null, dates_approved_only: null, booked_rental_minor: 660000, supplier_payment_minor: 420000, saving_minor: 240000 });
    // The payment never comes before the dates (the SQL order still holds, inside the one click).
    expect(() => browser.approve('cm', 'payment')).toThrow(/dates are approved first/);

    browser.approveFix('cm');
    status = fixStatus(plan, db.workflow, latestProposal(db.workflow)!)!;
    expect(status.approved).toMatchObject({ by: 'Deepak Jayaram', amount_minor: 420000 });
    expect(status.chain[1]).toMatchObject({ key: 'approved', status: 'done', who: 'Deepak Jayaram', note: 'The new dates and $4,200.00 to Northgate Equipment Rental, in one approval' });
    expect(status.next).toBe('The change is being applied to everyone’s plan.');
    browser.publish('cm');
    status = fixStatus(plan, db.workflow, latestProposal(db.workflow)!)!;
    expect(status.next).toBe('Chris or Deepak sends the payment to Northgate Equipment Rental with PayPal.');
    // Anyone who sees costs pays, not only the person who approved.
    browser.pay('pm');
    status = fixStatus(plan, db.workflow, latestProposal(db.workflow)!)!;
    expect(status.chain.every((step) => step.status === 'done')).toBe(true);
    expect(status.chain[3]).toMatchObject({ key: 'paid', who: 'Chris Hale', note: 'PayPal fee $0.25' });
    expect(status.payment).toMatchObject({ status: 'succeeded', fee_minor: 25 });
    expect(status.receipt?.name).toMatch(/receipt/i);
    expect(JSON.stringify(status)).not.toMatch(/project manager|cost manager|final say|dates first/i);
  });

  it('says so when only the dates are approved, and when the payment is above everyone’s limit', async () => {
    const { db, browser, plan } = await withProposal();
    browser.approve('pm', 'schedule');
    const status = fixStatus(plan, db.workflow, latestProposal(db.workflow)!)!;
    expect(status).toMatchObject({ approved: null, dates_approved_only: { by: 'Chris Hale' } });
    expect(status.chain[1]).toMatchObject({ status: 'current', note: 'Dates approved by Chris Hale; the payment still needs approving' });
    expect(status.next).toBe('Chris approved the new dates; the payment still needs approving (Chris or Deepak).');

    for (const member of db.plan.members) member.approval_limit_minor = 100_000;
    const limited = planFromRows(db.plan);
    const over = fixStatus(limited, db.workflow, latestProposal(db.workflow)!)!;
    expect(over.approvers).toEqual([]);
    expect(over.next).toBe('The payment is above everyone’s approval limit: someone with a higher limit has to approve the fix.');
    expect(() => browser.approveFix('cm')).toThrow(/exceeds your approval limit/);
  });

  it('never counts a member who cannot see costs as an approver or a payer', async () => {
    const { db, browser } = await withProposal();
    const sam = db.addMember({ display_name: 'Sam Ortiz' });
    const plan = planFromRows(db.plan);
    const status = fixStatus(plan, db.workflow, latestProposal(db.workflow)!)!;
    expect(status.approvers).toEqual(['Chris Hale', 'Deepak Jayaram']);
    // approve_fix is one transaction: the refused payment leaves no dates approval behind.
    expect(() => browser.approveFix(sam)).toThrow(/only a member who can see costs/);
    expect(db.workflow.approvals).toEqual([]);
  });
});

describe('approvals as people made them', () => {
  const row = (scope: 'schedule' | 'payment', approver: string, at: string, version = 'v1') =>
    ({ id: `${scope}-${approver}-${at}`, proposal_version_id: version, approver_id: approver, scope, amount_minor: scope === 'payment' ? 420000 : null, created_at: at }) as ApprovalRow;

  it('groups the dates and the payment by one person at one moment into one approval of the fix', () => {
    const at = '2026-10-26T10:00:00.000Z';
    expect(groupApprovals([row('payment', 'c', at), row('schedule', 'c', at)]).map((group) => [group.what, group.approverId, group.amountMinor])).toEqual([['fix', 'c', 420000]]);
    // Two people, or the same person much later, or another version: separate approvals.
    expect(groupApprovals([row('schedule', 'p', at), row('payment', 'c', at)]).map((group) => group.what)).toEqual(['dates', 'payment']);
    expect(groupApprovals([row('schedule', 'c', at), row('payment', 'c', '2026-10-26T10:30:00.000Z')]).map((group) => group.what)).toEqual(['dates', 'payment']);
    expect(groupApprovals([row('schedule', 'c', at), row('payment', 'c', at, 'v2')]).map((group) => group.what)).toEqual(['dates', 'payment']);
  });
});

describe('progress between two reads', () => {
  it('reports people’s steps and leaves out the agent’s own bookkeeping', async () => {
    const { db, browser, plan } = await withProposal();
    const before = structuredClone(db.workflow);
    browser.approveFix('pm');
    expect(diffWorkflow(plan, before, db.workflow).map((change) => describeChange(change))).toEqual(['Chris Hale approved the fix: $4,200.00 to Northgate Equipment Rental (version 1).']);

    // A correction the agent asked for (created_via agent) resets the approval without a progress event.
    const beforeRevise = structuredClone(db.workflow);
    const version = db.workflow.versions.at(-1)!;
    const id = await db.insertCommand({ project_id: db.projectId, type: 'revise_fix', args: ReviseFixArgs.parse({ version_id: version.id, changes: { new_end: '2026-12-19' }, reason: 'Deepak wants a spare day on the crane rental' }), requested_by: SEED_IDS.cmUser, required_revision: 0 });
    await browser.runCommand(id);
    expect(diffWorkflow(plan, beforeRevise, db.workflow)).toEqual([]);
    // The status reports the one approval that stopped counting, not two.
    expect(fixStatus(plan, db.workflow, latestProposal(db.workflow)!)!.reset_approvals).toEqual([{ what: 'the fix', by: 'Chris Hale', reason: 'Superseded by version 2: Deepak wants a spare day on the crane rental' }]);
    expect(fixStatus(plan, db.workflow, latestProposal(db.workflow)!)!.chain[1]!.status).toBe('reset');

    const beforeEnd = structuredClone(db.workflow);
    browser.approveFix('pm');
    browser.publish('pm');
    browser.pay('cm');
    expect(diffWorkflow(plan, beforeEnd, db.workflow).map((change) => change.type)).toEqual(['approved', 'published', 'payment_settled', 'receipt_filed']);
  });

  it('narrates one "Approve the fix" as one event, and leaves the amounts out when the audience may not see them', async () => {
    const { db, browser, plan } = await withProposal();
    const before = structuredClone(db.workflow);
    browser.approveFix('cm');
    const changes = diffWorkflow(plan, before, db.workflow);
    expect(changes).toEqual([{ type: 'approved', what: 'fix', by: 'Deepak Jayaram', versionNo: 1, amountMinor: 420000, supplier: 'Northgate Equipment Rental' }]);
    expect(describeChange(changes[0]!)).toBe('Deepak Jayaram approved the fix: $4,200.00 to Northgate Equipment Rental (version 1).');
    expect(describeChange(changes[0]!, { money: false })).toBe('Deepak Jayaram approved the fix: the new dates and the payment (version 1).');

    const beforePay = structuredClone(db.workflow);
    browser.publish('cm');
    browser.pay('cm');
    const lines = diffWorkflow(plan, beforePay, db.workflow).map((change) => describeChange(change, { money: false }));
    expect(lines).toEqual(["The change is in everyone's plan (change #1).", 'PayPal confirmed the payment.', 'The receipt was filed: PayPal receipt FAKE-ITEM.pdf.']);
    expect(lines.join(' ')).not.toMatch(/\$\s?\d/);
  });

  it('keeps a dates-only approval apart from a later payment approval', async () => {
    const { db, browser, plan } = await withProposal();
    const before = structuredClone(db.workflow);
    browser.approve('pm', 'schedule');
    expect(diffWorkflow(plan, before, db.workflow).map((change) => describeChange(change))).toEqual(['Chris Hale approved the new dates (version 1); the payment still needs approving.']);
    const middle = structuredClone(db.workflow);
    browser.approve('cm', 'payment');
    expect(diffWorkflow(plan, middle, db.workflow).map((change) => describeChange(change))).toEqual(['Deepak Jayaram approved the payment of $4,200.00 to Northgate Equipment Rental (version 1): the fix is approved.']);
  });

  it('names the approval a person’s correction reset, once', async () => {
    const { db, browser, plan } = await withProposal();
    browser.approveFix('cm');
    const before = structuredClone(db.workflow);
    const version = db.workflow.versions.at(-1)!;
    const id = await db.insertCommand({ project_id: db.projectId, type: 'revise_fix', args: ReviseFixArgs.parse({ version_id: version.id, changes: { new_end: '2026-12-19' }, reason: 'a spare day on the rental' }), requested_by: SEED_IDS.pmUser, required_revision: 0 });
    await browser.runCommand(id);
    // As if Chris had changed it in the app himself.
    db.workflow.versions.at(-1)!.created_via = 'human';
    expect(diffWorkflow(plan, before, db.workflow).map((change) => describeChange(change))).toEqual(['Chris Hale changed the fix: version 2 (a spare day on the rental). Approval reset: Deepak Jayaram (the fix).']);
  });

  it('reports a decline', async () => {
    const { db, browser, plan } = await withProposal();
    const before = structuredClone(db.workflow);
    browser.decline();
    expect(diffWorkflow(plan, before, db.workflow)).toEqual([{ type: 'cancelled', reason: null }]);
  });
});
