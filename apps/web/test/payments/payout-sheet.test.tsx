/**
 * The payout review sheet: PayPal Payouts' steps in PayPal's words, in our own look. Under review, each firm goes
 * "to their PayPal account", PayPal's fee is its published US Payouts API rate and says so, the money comes from the
 * general contractor's PayPal balance, and the total includes the fee. Once sent, each firm's line says what PayPal
 * reports, with the transaction, and the fee is the one PayPal reports. No logo and no PayPal gold on any button.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectModel } from '@bryntum/gantt';
import { PayoutSheet, type PayoutSheetProps } from '../../src/payments/PayoutSheet';
import { balanceOwner, balanceWords, lineTone, payoutFee, paypalWord, receiptTransactionId, rentalPaymentStatus } from '../../src/payments/payout-sheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIRMS = [
  { key: 'granite', firm: 'Granite Ridge Concrete', amountMinor: 3_132_000 },
  { key: 'pinecrest', firm: 'Pinecrest Sitework', amountMinor: 648_000 },
];

describe('the payout, in PayPal’s words', () => {
  it('says PayPal’s statuses as words, and how each line stands', () => {
    expect(['SUCCESS', 'PENDING', 'PROCESSING', 'UNCLAIMED', 'ONHOLD', 'RETURNED', 'SOMETHING_NEW'].map(paypalWord)).toEqual(['Paid', 'Pending', 'Pending', 'Unclaimed', 'On hold', 'Returned', 'Something_new']);
    const line = { key: 'a', firm: 'A', amountMinor: 1 };
    expect(lineTone(line, false)).toBe('review');
    expect(lineTone(line, true)).toBe('sending');
    expect(lineTone({ ...line, unsent: true }, true)).toBe('unsent');
    expect(lineTone({ ...line, paypalStatus: 'PENDING' }, true)).toBe('pending');
    expect(lineTone({ ...line, paypalStatus: 'SUCCESS' }, true)).toBe('paid');
    expect(lineTone({ ...line, paypalStatus: 'UNCLAIMED' }, true)).toBe('held');
    expect(lineTone({ ...line, paypalStatus: 'FAILED' }, true)).toBe('failed');
  });

  it('charges the published rate until PayPal reports its fee', () => {
    expect(payoutFee(2, null)).toEqual({ minor: 50, reported: false });
    expect(payoutFee(2, 50)).toEqual({ minor: 50, reported: true });
    expect(payoutFee(1, 0)).toEqual({ minor: 0, reported: true });
  });

  it('pays from the general contractor’s PayPal balance, or yours when the plan names none', () => {
    const project = (resources: object[]) => ({ resourceStore: { allRecords: resources } }) as unknown as ProjectModel;
    const crane = { name: 'Crane', trade: 'Equipment rental', kind: 'equipment', company: 'Northgate Equipment Rental' };
    expect(balanceOwner(project([crane, { name: 'Calloway Construction', trade: 'General contractor', kind: 'labor', company: 'Calloway Construction' }]))).toBe('Calloway Construction');
    expect(balanceOwner(project([crane, { name: 'Site crew', trade: 'General contractor', kind: 'labor', company: '' }]))).toBe('Site crew');
    expect(balanceOwner(project([crane]))).toBeNull();
    expect(balanceOwner(null)).toBeNull();
    expect(balanceWords('Calloway Construction')).toBe("Calloway Construction's PayPal balance");
    expect(balanceWords('Ashford Builders')).toBe("Ashford Builders' PayPal balance");
    expect(balanceWords(null)).toBe('Your PayPal balance');
  });

  it('reads a rental payment as PayPal reported it, and its transaction from the receipt', () => {
    expect(rentalPaymentStatus(null)).toEqual({ paypalStatus: null, note: null });
    expect(rentalPaymentStatus({ status: 'authorized', message: null })).toEqual({ paypalStatus: null, note: null });
    expect(rentalPaymentStatus({ status: 'pending', message: 'The recipient email has no confirmed PayPal account.' })).toEqual({ paypalStatus: 'PENDING', note: 'The recipient email has no confirmed PayPal account.' });
    expect(rentalPaymentStatus({ status: 'succeeded', message: null }).paypalStatus).toBe('SUCCESS');
    expect(rentalPaymentStatus({ status: 'failed', message: 'Receiver is ineligible.' })).toEqual({ paypalStatus: 'FAILED', note: 'Receiver is ineligible.' });
    expect(receiptTransactionId('PayPal payout batch ID: 5UXD2E8A7EBQJ\nPayPal transaction ID: 9KL12345AB678901C\nOur payment reference: x')).toBe('9KL12345AB678901C');
    expect(receiptTransactionId('PayPal transaction ID: Not reported by PayPal')).toBeNull();
    expect(receiptTransactionId(null)).toBeNull();
  });
});

describe('PayoutSheet', () => {
  let host: HTMLDivElement;
  let root: Root;
  const sheet = () => host.querySelector<HTMLElement>('[data-testid="pay-confirm"]')!;
  const text = (selector: string) => (host.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const lines = () => [...host.querySelectorAll('[data-testid="pay-line"]')].map((line) => (line.textContent ?? '').replace(/\s+/g, ' ').trim());

  const render = async (props: Partial<PayoutSheetProps> = {}) => {
    const all: PayoutSheetProps = { lines: FIRMS, currency: 'USD', owner: null, phase: 'review', onSend: vi.fn(), onClose: vi.fn(), testId: 'pay', ...props };
    await act(async () => {
      root.render(<PayoutSheet {...all} />);
    });
    return all;
  };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('asks for a review: each firm to their PayPal account, the rate, the balance, the total, and the small print', async () => {
    const props = await render();
    expect(sheet().dataset.phase).toBe('review');
    expect(text('h4')).toBe('Review your payment details');
    expect(lines()).toEqual(['Granite Ridge Concrete$31,320.00to their PayPal account', 'Pinecrest Sitework$6,480.00to their PayPal account']);
    expect(text('[data-testid="pay-fee"]')).toBe('$0.50$0.25 per payment · PayPal US Payouts API rate');
    expect(text('[data-testid="pay-from"]')).toBe('Your PayPal balance');
    expect(text('[data-testid="pay-total"]')).toBe('$37,800.50');
    expect(text('.payout-sheet-fine')).toBe('Funded from the PayPal balance only · no fee to payees');
    // The heading has the focus, not Send payout.
    expect(document.activeElement).toBe(host.querySelector('h4'));

    const send = host.querySelector<HTMLButtonElement>('[data-testid="pay-confirmed"]')!;
    expect(send.textContent).toBe('Send payout');
    expect(send.className).toBe('button is-primary');
    await act(async () => send.click());
    expect(props.onSend).toHaveBeenCalledTimes(1);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="pay-cancel"]')!.click());
    expect(props.onClose).toHaveBeenCalledTimes(1);
    await act(async () => host.querySelector('h4')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('names the general contractor’s balance, and can’t send while another step runs', async () => {
    await render({ owner: 'Calloway Construction', disabled: true });
    expect(text('[data-testid="pay-from"]')).toBe("Calloway Construction's PayPal balance");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="pay-confirmed"]')!.disabled).toBe(true);
  });

  it('follows each payment as PayPal reports it, then shows the fee PayPal reports', async () => {
    await render({ phase: 'sending' });
    expect(text('h4')).toBe('Submitting to PayPal…');
    expect(lines()).toEqual(['Granite Ridge Concrete$31,320.00Submitting to PayPal…', 'Pinecrest Sitework$6,480.00Submitting to PayPal…']);
    expect(host.querySelector('[data-testid="pay-confirmed"]')).toBeNull();

    await render({ phase: 'sent', batchIds: ['5UXD2E8A7EBQJ'], lines: FIRMS.map((line) => ({ ...line, paypalStatus: 'PENDING' })) });
    expect(text('h4')).toBe('Submitted to PayPal Payouts');
    expect(text('[data-testid="pay-batch"]')).toBe('Batch ID 5UXD2E8A7EBQJ');
    expect(lines()).toEqual(['Granite Ridge Concrete$31,320.00PayPal: Pending', 'Pinecrest Sitework$6,480.00PayPal: Pending']);
    expect(host.querySelector('[data-testid="pay-fee"]')!.getAttribute('data-reported')).toBe('false');

    await render({
      phase: 'sent',
      batchIds: ['5UXD2E8A7EBQJ'],
      reportedFeeMinor: 50,
      lines: [
        { ...FIRMS[0]!, paypalStatus: 'SUCCESS', transactionId: '9KL12345AB678901C' },
        { ...FIRMS[1]!, paypalStatus: 'UNCLAIMED', note: 'The recipient email has no confirmed PayPal account.' },
      ],
      children: <p data-testid="extra">Receipts are on the tasks.</p>,
    });
    expect(lines()).toEqual([
      'Granite Ridge Concrete$31,320.00PayPal: Paid · Transaction ID 9KL12345AB678901C',
      'Pinecrest Sitework$6,480.00PayPal: UnclaimedThe recipient email has no confirmed PayPal account.',
    ]);
    expect(host.querySelectorAll('[data-status="paid"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-status="held"]')).toHaveLength(1);
    expect(text('[data-testid="pay-fee"]')).toBe('$0.50As reported by PayPal');
    expect(text('[data-testid="pay-total"]')).toBe('$37,800.50');
    expect(text('[data-testid="extra"]')).toBe('Receipts are on the tasks.');
    expect(host.querySelector('[data-testid="pay-close"]')?.textContent).toBe('Close');
  });

  it('carries no PayPal logo and no PayPal look on its buttons', async () => {
    await render();
    for (const button of host.querySelectorAll('button')) {
      expect(button.querySelector('img, svg')).toBeNull();
      expect(button.className).not.toMatch(/paypal/);
    }
    expect(host.querySelector('img')).toBeNull();
  });
});
