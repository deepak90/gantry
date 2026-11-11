import { describe, expect, it } from 'vitest';
import {
  batchOutcome,
  batchStatusOutcome,
  describePayPalError,
  existingBatchId,
  itemOutcome,
  mayAlreadyExist,
  ONHOLD_MESSAGE,
  statusOfItem,
  UNCLAIMED_MESSAGE,
} from '../_shared/outcomes.ts';
import { AUTH_ID, SANDBOX_BATCH_EXISTS, batchBody } from './fakes.ts';

describe('statusOfItem', () => {
  it('SUCCESS settles the payout', () => {
    expect(statusOfItem('SUCCESS')).toBe('succeeded');
  });

  it.each(['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'CANCELED', 'DENIED'])('%s fails it', (status) => {
    expect(statusOfItem(status)).toBe('failed');
  });

  it.each(['PENDING', 'UNCLAIMED', 'ONHOLD', 'NEW', 'SOMETHING_NEW', '', undefined, null, 42])(
    '%s keeps it pending',
    (status) => {
      expect(statusOfItem(status)).toBe('pending');
    },
  );
});

describe('itemOutcome', () => {
  const item = (fields: Record<string, unknown>) => ({
    payout_item_id: 'ITEM-1',
    payout_batch_id: 'BATCH-1',
    payout_item: { amount: { value: '1200.00', currency: 'USD' }, sender_item_id: AUTH_ID },
    payout_item_fee: { value: '0.25', currency: 'USD' },
    ...fields,
  });

  it('a success carries the ids and the fee in minor units', () => {
    expect(itemOutcome(item({ transaction_status: 'SUCCESS' }))).toEqual({
      status: 'succeeded',
      batchId: 'BATCH-1',
      itemId: 'ITEM-1',
      feeMinor: 25,
      message: null,
    });
  });

  it('a failure carries PayPal errors.message', () => {
    const outcome = itemOutcome(
      item({ transaction_status: 'FAILED', errors: { name: 'RECEIVER_UNREGISTERED', message: 'Receiver is unregistered' } }),
    );
    expect(outcome).toMatchObject({ status: 'failed', message: 'Receiver is unregistered' });
  });

  it('a failure without errors still explains itself', () => {
    expect(itemOutcome(item({ transaction_status: 'RETURNED' })).message).toBe('PayPal reports the payout as RETURNED.');
    expect(itemOutcome(item({ transaction_status: 'BLOCKED', errors: { name: 'RISK_DECLINE' } })).message).toBe('RISK_DECLINE');
  });

  it('explains unclaimed and held payouts while they stay pending', () => {
    expect(itemOutcome(item({ transaction_status: 'UNCLAIMED' }))).toMatchObject({ status: 'pending', message: UNCLAIMED_MESSAGE });
    expect(UNCLAIMED_MESSAGE).toContain('no confirmed PayPal account');
    expect(UNCLAIMED_MESSAGE).toContain('30 days');
    expect(itemOutcome(item({ transaction_status: 'ONHOLD' }))).toMatchObject({ status: 'pending', message: ONHOLD_MESSAGE });
    expect(itemOutcome(item({ transaction_status: 'PENDING' }))).toMatchObject({ status: 'pending', message: null });
  });

  it('falls back to the given status when the item has none (webhook event types)', () => {
    expect(itemOutcome(item({}), 'SUCCESS').status).toBe('succeeded');
    expect(itemOutcome(item({ transaction_status: 'FAILED' }), 'SUCCESS').status).toBe('failed');
  });

  it('drops a fee in another currency or with a third decimal', () => {
    expect(itemOutcome(item({ transaction_status: 'SUCCESS', payout_item_fee: { value: '0.25', currency: 'EUR' } })).feeMinor).toBeNull();
    expect(itemOutcome(item({ transaction_status: 'SUCCESS', payout_item_fee: { value: '0.255', currency: 'USD' } })).feeMinor).toBeNull();
  });

  it('tolerates junk', () => {
    expect(itemOutcome(null)).toEqual({ status: 'pending', batchId: null, itemId: null, feeMinor: null, message: null });
  });
});

describe('batchOutcome', () => {
  it('reads the item whose sender_item_id is the authorization', () => {
    const body = batchBody({ transactionStatus: 'SUCCESS' });
    const other = { ...body.items[0], payout_item_id: 'ITEM-OTHER', transaction_status: 'FAILED', payout_item: { sender_item_id: 'someone-else' } };
    expect(batchOutcome({ ...body, items: [other, ...body.items] }, AUTH_ID)).toEqual({
      status: 'succeeded',
      batchId: 'BATCH-1',
      itemId: 'ITEM-1',
      feeMinor: 25,
      message: null,
    });
  });

  it('ignores a single item that belongs to another operation', () => {
    const body = batchBody({ transactionStatus: 'SUCCESS' });
    expect(batchOutcome(body, '00000000-0000-4000-8000-0000000000ff')).toMatchObject({ status: 'pending', itemId: null });
  });

  it('a denied or canceled batch without items fails', () => {
    for (const status of ['DENIED', 'CANCELED']) {
      const outcome = batchOutcome({ batch_header: { payout_batch_id: 'BATCH-1', batch_status: status } }, AUTH_ID);
      expect(outcome).toMatchObject({ status: 'failed', batchId: 'BATCH-1' });
      expect(outcome.message).toMatch(/PayPal (denied|canceled) the payout batch/);
    }
  });

  it('any other batch without items is pending', () => {
    for (const status of ['PENDING', 'PROCESSING', 'SUCCESS', undefined]) {
      expect(batchStatusOutcome('BATCH-1', status)).toEqual({
        status: 'pending',
        batchId: 'BATCH-1',
        itemId: null,
        feeMinor: null,
        message: null,
      });
    }
  });
});

describe('describePayPalError', () => {
  it('formats name: message and the detail issues', () => {
    expect(
      describePayPalError(422, {
        name: 'UNPROCESSABLE_ENTITY',
        message: 'The requested action could not be performed.',
        details: [
          { issue: 'INSUFFICIENT_FUNDS', description: 'Sender does not have sufficient funds.' },
          { issue: 'ANOTHER_ISSUE' },
        ],
      }),
    ).toBe(
      'UNPROCESSABLE_ENTITY: The requested action could not be performed. ' +
        '(INSUFFICIENT_FUNDS: Sender does not have sufficient funds.; ANOTHER_ISSUE)',
    );
  });

  it('reads OAuth errors and empty bodies', () => {
    expect(describePayPalError(401, { error: 'invalid_client', error_description: 'Client Authentication failed' })).toBe(
      'invalid_client: Client Authentication failed',
    );
    expect(describePayPalError(502, null)).toBe('HTTP 502');
    expect(describePayPalError(500, '<html>')).toBe('HTTP 500');
  });
});

describe('existingBatchId', () => {
  it('reads the batch the sandbox links when the sender_batch_id already exists', () => {
    expect(existingBatchId(SANDBOX_BATCH_EXISTS)).toBe('XNK4D4A55AQ5G');
  });

  it('is null without a SENDER_BATCH_ID detail or a payouts link', () => {
    expect(existingBatchId({ name: 'VALIDATION_ERROR', details: [{ field: 'items[0].receiver', link: SANDBOX_BATCH_EXISTS.details[0]!.link }] })).toBeNull();
    expect(existingBatchId({ details: [{ field: 'SENDER_BATCH_ID', link: [{ href: 'https://api.sandbox.paypal.com/v1/other/X' }] }] })).toBeNull();
    expect(existingBatchId(null)).toBeNull();
  });
});

describe('mayAlreadyExist', () => {
  it('the sandbox\'s "batch already exists" rejection means the operation exists', () => {
    expect(mayAlreadyExist(400, SANDBOX_BATCH_EXISTS)).toBe(true);
    expect(mayAlreadyExist(400, { name: 'USER_BUSINESS_ERROR', details: [{ field: 'SENDER_BATCH_ID', issue: 'x' }] })).toBe(true);
  });

  it('409 and duplicate or already-used names mean the operation may exist', () => {
    expect(mayAlreadyExist(409, null)).toBe(true);
    expect(mayAlreadyExist(400, { name: 'DUPLICATE_REQUEST_ID' })).toBe(true);
    expect(mayAlreadyExist(400, { name: 'USER_BUSINESS_ERROR', details: [{ issue: 'SENDER_BATCH_ID_ALREADY_USED' }] })).toBe(true);
  });

  it('other rejections do not', () => {
    expect(mayAlreadyExist(400, { name: 'VALIDATION_ERROR', details: [{ issue: 'INVALID_PARAMETER_VALUE' }] })).toBe(false);
    expect(mayAlreadyExist(422, { name: 'INSUFFICIENT_FUNDS' })).toBe(false);
  });
});
