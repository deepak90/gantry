/**
 * The money tab's view of the workflow for one task: the rental, the fix and its PayPal payment.
 */
import { describe, expect, it } from 'vitest';
import { taskPaymentFacts } from '../../src/inspector/task/payments';
import { workflowSnapshot } from '../changelog/helpers';

describe('taskPaymentFacts', () => {
  it('reads the rental and the PayPal payment of the booked task', () => {
    const facts = taskPaymentFacts(workflowSnapshot(), 22);
    expect(facts?.rental).toEqual({ supplier: 'Northgate Equipment Rental', rateMinor: 60_000, from: 'Mon, Dec 7, 2026', until: 'Thu, Dec 17, 2026', idleDaysBooked: 4 });
    expect(facts?.payment).toEqual({
      status: 'succeeded',
      label: 'Paid',
      tone: 'ok',
      amountMinor: 360_000,
      feeMinor: 25,
      recipient: 'payouts@northgate.example',
      reference: 'BATCH-7XK2',
      message: null,
    });
  });

  it('says nothing for a task the workflow does not concern, or before the workflow loads', () => {
    expect(taskPaymentFacts(workflowSnapshot(), 23)).toBeNull();
    expect(taskPaymentFacts(null, 22)).toBeNull();
  });

  it('a rental nobody has paid has no payment', () => {
    const snapshot = { ...workflowSnapshot(), proposals: [], versions: [], approvals: [], payments: [], publications: [] };
    const facts = taskPaymentFacts(snapshot, 22);
    expect(facts?.rental.supplier).toBe('Northgate Equipment Rental');
    expect(facts?.payment).toBeNull();
  });

  it('a failed payment reads as failed with PayPal’s reason', () => {
    const snapshot = workflowSnapshot();
    snapshot.payments = snapshot.payments.map((payment) => ({ ...payment, status: 'failed' as const, message: 'Receiver is unregistered' }));
    expect(taskPaymentFacts(snapshot, 22)?.payment).toMatchObject({ label: 'Payment failed', tone: 'alert', message: 'Receiver is unregistered' });
  });
});
