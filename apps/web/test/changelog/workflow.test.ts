import { describe, expect, it } from 'vitest';
import { describeEntry, newestFirst, type ChangelogEntry } from '../../src/changelog/model';
import { workflowEntries, type WorkflowContext } from '../../src/changelog/workflow';
import { CHRIS, IDS, PEOPLE, PRIYA, workflowSnapshot } from './helpers';

const context = (canViewCosts: boolean, shown: string[] = []): WorkflowContext => ({
  canViewCosts,
  currency: 'USD',
  resourceName: (id) => (id === 4 ? 'Crane' : null),
  shownPublications: new Set(shown),
});

function oldestFirst(entries: ChangelogEntry[]): ChangelogEntry[] {
  return [...entries].sort(newestFirst).reverse();
}

const sentences = (entries: ChangelogEntry[]) => oldestFirst(entries).map((entry) => describeEntry(entry, PEOPLE));

describe('the fix and its payment as changelog entries', () => {
  it('tells the whole story to someone who may see costs', () => {
    const entries = workflowEntries(workflowSnapshot(), context(true));
    expect(sentences(entries)).toEqual([
      'Chris proposed a fix for the Crane rental',
      'Fix version 1 checked against the plan: saves $1,800.00, handover date kept',
      'Priya approved the schedule change',
      'Chris changed the fix (version 2)',
      'Priya’s approval of the schedule change no longer counts',
      'Fix version 2 checked against the plan: saves $2,400.00, handover date kept',
      'Priya approved the schedule change',
      'Chris approved paying $3,600.00 to Northgate Equipment Rental',
      'Chris applied the approved fix to the plan',
      'Chris sent $3,600.00 to Northgate Equipment Rental with PayPal',
      'PayPal confirmed $3,600.00 paid to Northgate Equipment Rental (PayPal fee $0.25)',
      'Priya recorded that Northgate Equipment Rental confirmed the new dates',
    ]);
  });

  it('payments are PayPal entries, and the fix entries open the booked task', () => {
    const entries = workflowEntries(workflowSnapshot(), context(true));
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    expect(byId.get(`wf-pay-${IDS.payment}`)).toMatchObject({ kind: 'payment', tone: 'paypal', icon: 'fa-brands fa-paypal', actor: { type: 'member', userId: CHRIS }, note: 'Paid' });
    expect(byId.get(`wf-pay-${IDS.payment}-paid`)).toMatchObject({ kind: 'payment', tone: 'paypal', actor: { type: 'paypal' } });
    expect(byId.get(`wf-approval-${IDS.approvalPayment}`)).toMatchObject({ kind: 'payment', tone: 'ok' });
    expect(byId.get(`wf-approval-${IDS.approvalSchedule}`)).toMatchObject({ kind: 'fix', actor: { type: 'member', userId: PRIYA }, note: 'For version 2 of the fix' });
    expect(entries.every((entry) => entry.taskId === 22)).toBe(true);

    // Expanding the payment shows the facts PayPal reported.
    expect(byId.get(`wf-pay-${IDS.payment}-paid`)!.actions[0]!.propertyUpdates).toEqual([
      { property: 'Amount', after: '$3,600.00' },
      { property: 'PayPal fee', after: '$0.25' },
      { property: 'PayPal reference', after: 'BATCH-7XK2' },
    ]);
    // A correction lists what changed, from and to.
    expect(byId.get(`wf-review-${IDS.review}`)).toMatchObject({ note: 'The steel arrives a day earlier' });
    expect(byId.get(`wf-review-${IDS.review}`)!.actions[0]!.propertyUpdates).toEqual([{ property: 'Off rent', before: 'Mon, Dec 21, 2026', after: 'Sat, Dec 19, 2026' }]);
  });

  it('shows no amounts to someone who may not see costs', () => {
    const snapshot = workflowSnapshot();
    // Reasons are typed by people and may name amounts.
    snapshot.reviews[0] = { ...snapshot.reviews[0]!, payload: { ...snapshot.reviews[0]!.payload, reason: 'Northgate confirmed a $300 transport charge' } };
    snapshot.approvals[0] = { ...snapshot.approvals[0]!, invalidated_reason: 'Superseded by version 2: Northgate agreed 900 USD' };
    const entries = workflowEntries(snapshot, context(false));
    expect(entries.find((entry) => entry.id === `wf-review-${IDS.review}`)!.note).toBe('Northgate confirmed a ••• transport charge');
    expect(entries.find((entry) => entry.id.endsWith('-void'))!.note).toBe('Superseded by version 2: Northgate agreed •••');
    expect(workflowEntries(snapshot, context(true)).find((entry) => entry.id === `wf-review-${IDS.review}`)!.note).toBe('Northgate confirmed a $300 transport charge');
    expect(JSON.stringify(entries)).not.toMatch(/\$\s?\d|\d\s?USD/);
    const text = sentences(entries);
    expect(text).toContain('Chris approved the payment to Northgate Equipment Rental');
    expect(text).toContain('Chris sent the payment to Northgate Equipment Rental with PayPal');
    expect(text).toContain('PayPal confirmed the payment to Northgate Equipment Rental');
    expect(text).toContain('Fix version 2 checked against the plan: handover date kept');
    const check = entries.find((entry) => entry.id === `wf-check-${IDS.version2}`)!;
    expect(check.actions[0]!.propertyUpdates).toContainEqual({ property: 'Saving', after: '•••' });
  });

  it('leaves the publication to the revision that carried it out, once that revision is listed', () => {
    const shown = workflowEntries(workflowSnapshot(), context(true, [IDS.publication]));
    expect(shown.some((entry) => entry.id === `wf-pub-${IDS.publication}`)).toBe(false);
    const notShown = workflowEntries(workflowSnapshot(), context(true));
    expect(notShown.some((entry) => entry.id === `wf-pub-${IDS.publication}`)).toBe(true);
  });

  it('a payment on its way, a failed one, and a dropped fix', () => {
    const snapshot = workflowSnapshot();
    snapshot.payments[0] = { ...snapshot.payments[0]!, status: 'pending', fee_minor: null };
    let entries = workflowEntries(snapshot, context(true));
    expect(entries.find((entry) => entry.id === `wf-pay-${IDS.payment}`)!.note).toBe('PayPal is processing the payment');
    expect(entries.some((entry) => entry.id.endsWith('-paid'))).toBe(false);

    snapshot.payments[0] = { ...snapshot.payments[0]!, status: 'failed', message: 'RECEIVER_UNREGISTERED' };
    snapshot.proposals[0] = { ...snapshot.proposals[0]!, state: 'cancelled' };
    entries = workflowEntries(snapshot, context(true));
    const failed = entries.find((entry) => entry.id === `wf-pay-${IDS.payment}-failed`)!;
    expect(describeEntry(failed, PEOPLE)).toBe('PayPal could not make the payment to Northgate Equipment Rental');
    expect(failed).toMatchObject({ tone: 'error', note: 'RECEIVER_UNREGISTERED' });
    expect(describeEntry(entries.find((entry) => entry.id.endsWith('-dropped'))!, PEOPLE)).toBe('The fix for the Crane rental was dropped');
  });

  it('an evaluation, approval or payment of the same row keeps its id, so it is never listed twice', () => {
    const first = workflowEntries(workflowSnapshot(), context(true)).map((entry) => entry.id);
    const second = workflowEntries(workflowSnapshot(), context(true)).map((entry) => entry.id);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });
});
