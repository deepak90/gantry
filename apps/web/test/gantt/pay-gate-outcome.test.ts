/**
 * What PayPal's answer means for each firm in a payment: paid only when every firm was, still working while any firm
 * has no answer, and, when PayPal splits it, which firm was paid so that nobody is paid twice.
 */
import { describe, expect, it } from 'vitest';
import { batchOutcome, type BatchStatus } from '../../src/gantt/pay-gate-payment';

const FIRMS = ['Granite Ridge Concrete', 'Pinecrest Sitework'];
const item = (n: number, status: string, error: string | null = null) => ({ itemId: `PG-25-abc-${n}`, status, transactionId: status === 'SUCCESS' ? `T${n}` : null, error });
const batch = (status: string, ...items: BatchStatus['items']): BatchStatus => ({ batchId: 'B', status, feeMinor: null, items });

describe('what PayPal’s answer means for the payment', () => {
  it('is paid only when PayPal says so and every firm was paid', () => {
    expect(batchOutcome(batch('SUCCESS', item(1, 'SUCCESS'), item(2, 'SUCCESS')), FIRMS)).toEqual({ kind: 'paid' });
  });

  it('keeps working while any firm has no answer yet, even if another was already refused', () => {
    expect(batchOutcome(batch('PROCESSING'), FIRMS)).toEqual({ kind: 'working' });
    expect(batchOutcome(batch('SUCCESS', item(1, 'SUCCESS'), item(2, 'PENDING')), FIRMS)).toEqual({ kind: 'working' });
    expect(batchOutcome(batch('PROCESSING', item(1, 'FAILED'), item(2, 'PENDING')), FIRMS)).toEqual({ kind: 'working' });
  });

  it('says who was paid and who wasn’t when PayPal pays one firm and refuses the other', () => {
    const outcome = batchOutcome(batch('PARTIALLY_COMPLETED', item(1, 'SUCCESS'), item(2, 'FAILED', 'PayPal: declined')), FIRMS);
    expect(outcome).toMatchObject({ kind: 'failed', paid: ['Granite Ridge Concrete'] });
    if (outcome.kind !== 'failed') throw new Error('expected a refusal');
    expect(outcome.error).toContain('Granite Ridge Concrete was paid');
    expect(outcome.error).toContain('Pinecrest Sitework: failed at PayPal');
    expect(outcome.error).toContain('PayPal: declined');
    expect(outcome.error).toContain('only what is left');
  });

  it('finds each firm by its own item, in whatever order PayPal lists them', () => {
    expect(batchOutcome(batch('PARTIALLY_COMPLETED', item(2, 'SUCCESS'), item(1, 'FAILED')), FIRMS)).toMatchObject({ kind: 'failed', paid: ['Pinecrest Sitework'] });
  });

  it('names no one as paid when every firm was refused', () => {
    expect(batchOutcome(batch('PARTIALLY_COMPLETED', item(1, 'FAILED'), item(2, 'UNCLAIMED')), FIRMS)).toMatchObject({ kind: 'failed', paid: [] });
  });

  it('fails a batch PayPal turned down, and still counts a firm it had already paid', () => {
    expect(batchOutcome(batch('DENIED'), FIRMS)).toEqual({ kind: 'failed', paid: [], error: 'PayPal denied the batch.' });
    expect(batchOutcome(batch('CANCELED', item(1, 'SUCCESS'), item(2, 'PENDING')), FIRMS)).toMatchObject({ kind: 'failed', paid: ['Granite Ridge Concrete'] });
  });
});
