/**
 * The payment window's steps follow PayPal's own statuses and nothing else: sent once PayPal took the batch, PayPal
 * processing while the batch is PENDING or PROCESSING, paid once the batch and every firm's payment are SUCCESS. A
 * refusal stops the step it happened at. Each firm's payment goes by its own item status.
 */
import { describe, expect, it } from 'vitest';
import type { BatchStatus } from '../../src/gantt/pay-gate-payment';
import { payoutItems, payoutPhase, payoutSteps } from '../../src/payments/pay-progress';
import { checkoutFeeMinor } from '../../src/payments/payout-sheet';

const sent = [
  { firm: 'Granite Ridge Concrete', amountMinor: 3_132_000 },
  { firm: 'Pinecrest Sitework', amountMinor: 648_000 },
];

const batch = (status: string, items: [string, string | null][] = []): BatchStatus => ({
  batchId: '9ZEGND46JF5W6',
  status,
  feeMinor: status === 'SUCCESS' ? 50 : null,
  items: items.map(([itemStatus, tx], index) => ({ itemId: `PG-25-x-${index + 1}`, status: itemStatus, transactionId: tx, error: null })),
});

const states = (steps: ReturnType<typeof payoutSteps>) => steps.map((step) => `${step.key}:${step.state}`);

describe('the payout’s steps', () => {
  it('waits to be sent, then is on its way while the page sends it', () => {
    expect(states(payoutSteps({ sending: false, batchId: null, status: null, error: null, sent }))).toEqual(['sent:todo', 'processing:todo', 'paid:todo']);
    const sending = payoutSteps({ sending: true, batchId: null, status: null, error: null, sent });
    expect(states(sending)).toEqual(['sent:active', 'processing:todo', 'paid:todo']);
    expect(payoutPhase(sending, true)).toBe('sending');
  });

  it('is sent once PayPal took the batch, and processing while PayPal says PENDING or PROCESSING', () => {
    for (const status of ['PENDING', 'PROCESSING']) {
      const steps = payoutSteps({ sending: false, batchId: '9ZEGND46JF5W6', status: batch(status, [['PENDING', null], ['PENDING', null]]), error: null, sent });
      expect(states(steps)).toEqual(['sent:done', 'processing:active', 'paid:todo']);
      expect(steps.map((step) => step.label)).toEqual(['Submitted to PayPal', 'Processing', 'Paid']);
      expect(steps[0]!.detail).toBe('Batch accepted');
      expect(steps[1]!.detail).toBe('PayPal status: Pending');
      expect(payoutPhase(steps, true)).toBe('processing');
    }
  });

  it('is paid only when the batch and every firm’s payment are SUCCESS', () => {
    const half = payoutSteps({ sending: false, batchId: 'B', status: batch('SUCCESS', [['SUCCESS', 'TX1'], ['PENDING', null]]), error: null, sent });
    expect(states(half)).toEqual(['sent:done', 'processing:active', 'paid:todo']);
    const paid = payoutSteps({ sending: false, batchId: 'B', status: batch('SUCCESS', [['SUCCESS', 'TX1'], ['SUCCESS', 'TX2']]), error: null, sent });
    expect(states(paid)).toEqual(['sent:done', 'processing:done', 'paid:done']);
    // Counted from the payments themselves, with the plural that fits.
    expect(paid[2]!.detail).toBe('2 of 2 payments completed');
    expect(payoutPhase(paid, true)).toBe('paid');
    const one = payoutSteps({ sending: false, batchId: 'B', status: batch('SUCCESS', [['SUCCESS', 'TX1']]), error: null, sent: sent.slice(0, 1) });
    expect(one[2]!.detail).toBe('1 of 1 payment completed');
  });

  it('stops where PayPal refused, or where nothing reached it', () => {
    const refused = payoutSteps({ sending: false, batchId: 'B', status: batch('SUCCESS', [['SUCCESS', 'TX1'], ['UNCLAIMED', null]]), error: null, sent });
    expect(states(refused)).toEqual(['sent:done', 'processing:failed', 'paid:failed']);
    expect(refused[2]!.detail).toBe('1 of 2 payments completed');
    expect(payoutPhase(refused, true)).toBe('failed');
    const unsent = payoutSteps({ sending: false, batchId: null, status: null, error: 'The approval is requested, not approved', sent });
    expect(states(unsent)).toEqual(['sent:failed', 'processing:todo', 'paid:todo']);
    expect(unsent[0]!.detail).toBe('The approval is requested, not approved');
  });

  it('shows each firm’s payment by its own status, with PayPal’s transaction once paid', () => {
    expect(payoutItems({ status: null, sent }).map((item) => item.tone)).toEqual(['sending', 'sending']);
    const items = payoutItems({ status: batch('SUCCESS', [['SUCCESS', 'TX1'], ['PENDING', null]]), sent });
    expect(items.map((item) => [item.firm, item.tone, item.word, item.transactionId])).toEqual([
      ['Granite Ridge Concrete', 'paid', 'Paid', 'TX1'],
      ['Pinecrest Sitework', 'pending', 'Pending', null],
    ]);
  });
});

describe('a payment made on PayPal’s own pages', () => {
  it('says it was approved at PayPal, not submitted as a batch', () => {
    const [approved] = payoutSteps({ sending: false, batchId: '6K808861Y8673845L', status: null, error: null, sent: [{ firm: 'Granite Ridge Concrete', amountMinor: 3_132_000 }], checkout: true });
    expect(approved).toMatchObject({ key: 'sent', label: 'Approved at PayPal', state: 'done', detail: 'Approved in PayPal’s window' });
  });
});

describe('PayPal’s checkout fee', () => {
  it('matches what PayPal charged on the real sandbox payments', () => {
    expect(checkoutFeeMinor(100)).toBe(52);
    expect(checkoutFeeMinor(3_132_000)).toBe(109_356);
    expect(checkoutFeeMinor(648_000)).toBe(22_664);
  });
});
