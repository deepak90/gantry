/**
 * The dev server's PayPal routes (apps/web/paypal-dev.ts), in what only they do: the mock batch that goes through after
 * a moment at PayPal's US Payouts API rate, and paying on PayPal's own pages (one order, a purchase unit per firm). What
 * the route shares with the hosted site's function (the request, the claim, PayPal's batch read back, each firm's own
 * account) is tested with that code, in supabase/functions/test/progress-payouts.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { firmAccounts, sandboxAccounts } from '../../../../supabase/functions/_shared/accounts.ts';
import { mockPayouts, orderBody, orderStatusOf, rehearsedStatus, type BatchRequest } from '../../paypal-dev';

const HARBOR = '00000000-0000-4000-8000-000000000002';
const APPROVAL = '00000000-0000-4000-8000-0000000007aa';

describe('the mock batch', () => {
  it('mocks a batch that goes through after a moment, with PayPal’s published fees', () => {
    let now = 1_000_000;
    const mock = mockPayouts(() => now);
    const request: BatchRequest = {
      batchId: 'PG-46-abc',
      currency: 'USD',
      subject: 'You have a progress payment',
      message: '',
      items: [
        { itemId: 'PG-46-abc-1', firm: 'Granite Ridge Concrete', amountMinor: 3_132_000, note: 'Footings' },
        { itemId: 'PG-46-abc-2', firm: 'Pinecrest Sitework', amountMinor: 648_000, note: 'Footings' },
      ],
      projectId: HARBOR,
      gateId: 25,
      approvalId: APPROVAL,
    };
    expect(mock.create(request)).toEqual({ batchId: 'MOCK-PG-46-abc', status: 'PENDING', feeMinor: null, items: [] });
    expect(mock.get('MOCK-PG-46-abc')).toMatchObject({ status: 'PROCESSING', feeMinor: null, items: [{ status: 'PENDING', feeMinor: null }, { status: 'PENDING', feeMinor: null }] });
    now += 3_000;
    expect(mock.get('MOCK-PG-46-abc')).toMatchObject({ status: 'SUCCESS', feeMinor: 50, items: [{ status: 'SUCCESS', feeMinor: 25 }, { status: 'SUCCESS', feeMinor: 25 }] });
    expect(mock.get('MOCK-unknown')).toBeNull();
  });
});

describe('paying on PayPal’s own pages', () => {
  const request: BatchRequest = {
    batchId: 'PG-25-abc',
    currency: 'USD',
    subject: 'Progress payment: Footings',
    message: 'Work completed to date',
    projectId: HARBOR,
    gateId: 25,
    approvalId: APPROVAL,
    items: [
      { itemId: 'PG-25-abc-1', firm: 'Granite Ridge Concrete', amountMinor: 3_132_000, note: 'Progress payment, Footings: 100% complete' },
      { itemId: 'PG-25-abc-2', firm: 'Pinecrest Sitework', amountMinor: 648_000, note: 'Progress payment, Footings: 100% complete' },
    ],
  };
  const accounts = sandboxAccounts({ PAYPAL_SANDBOX_GRANITE_EMAIL: 'granite@personal.example.com', PAYPAL_SANDBOX_PINECREST_EMAIL: ' pinecrest@personal.example.com ' });

  it('makes one order with a purchase unit per firm, naming the firm for PayPal’s cart and paying its own account', () => {
    const firms = firmAccounts(['Granite Ridge Concrete', 'Pinecrest Sitework'], accounts);
    if (!firms.ok) throw new Error(firms.error);
    const order = orderBody(request, firms.accounts);
    expect(order.intent).toBe('CAPTURE');
    expect(order.purchase_units.map((unit) => [unit.reference_id, unit.amount.value, unit.payee.email_address])).toEqual([
      ['PG-25-abc-1', '31320.00', 'granite@personal.example.com'],
      ['PG-25-abc-2', '6480.00', 'pinecrest@personal.example.com'],
    ]);
    expect(order.purchase_units[0]!.items[0]!.name).toBe('Granite Ridge Concrete · Progress payment: Footings');
    expect(order.purchase_units[0]!.amount.breakdown.item_total.value).toBe('31320.00');
  });

  it('reads PayPal’s captures in the words the payment window follows, with each firm’s fee', () => {
    const captured = orderStatusOf({
      id: '6K808861Y8673845L',
      status: 'COMPLETED',
      purchase_units: [
        { reference_id: 'PG-25-abc-2', payments: { captures: [{ id: '4SJ46038G96577946', status: 'COMPLETED', seller_receivable_breakdown: { paypal_fee: { currency_code: 'USD', value: '226.64' } } }] } },
        { reference_id: 'PG-25-abc-1', payments: { captures: [{ id: '64V756290E9784518', status: 'COMPLETED', seller_receivable_breakdown: { paypal_fee: { currency_code: 'USD', value: '1093.56' } } }] } },
      ],
    });
    expect(captured).toEqual({
      batchId: '6K808861Y8673845L',
      status: 'SUCCESS',
      feeMinor: 132_020,
      items: [
        { itemId: 'PG-25-abc-2', status: 'SUCCESS', transactionId: '4SJ46038G96577946', feeMinor: 22_664, error: null },
        { itemId: 'PG-25-abc-1', status: 'SUCCESS', transactionId: '64V756290E9784518', feeMinor: 109_356, error: null },
      ],
    });
  });

  it('keeps an approved order unpaid until it is captured, and names a declined capture', () => {
    expect(orderStatusOf({ id: 'A', status: 'APPROVED', purchase_units: [{ reference_id: 'x-1' }] }).status).toBe('APPROVED');
    const declined = orderStatusOf({ id: 'A', status: 'PARTIALLY_COMPLETED', purchase_units: [{ reference_id: 'x-1', payments: { captures: [{ id: 'C', status: 'DECLINED' }] } }] });
    expect(declined.status).toBe('PARTIALLY_COMPLETED');
    expect(declined.items[0]).toMatchObject({ status: 'FAILED', error: 'PayPal: declined' });
  });

  it('marks a rehearsal so it can’t be mistaken for money PayPal moved', () => {
    const rehearsed = rehearsedStatus({ id: 'A', status: 'APPROVED', purchase_units: [{ reference_id: 'x-1', amount: { currency_code: 'USD', value: '31320.00' } }] });
    expect(rehearsed.items[0]).toEqual({ itemId: 'x-1', status: 'SUCCESS', transactionId: 'REHEARSAL-1', feeMinor: 109_356, error: null });
  });
});
