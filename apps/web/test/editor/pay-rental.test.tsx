/**
 * Paying a rental: Review payment opens the payout sheet (the firm, PayPal's fee at its published rate, the
 * general contractor's PayPal balance, the total); Send payout hands the rental to the workflow, which pays it
 * through PayPal Payouts; the sheet then follows the new payment as PayPal reported it, from pending to paid with
 * the transaction on its receipt and PayPal's fee; closed, the record reads "Sent with PayPal Payouts · batch …".
 * A step refused before anything reached PayPal goes back to the review with the reason.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EquipmentBookingRow, PaymentAuthorizationRow, ProjectDocumentRow } from '@collab/shared';
import { PayRental, type RentalPayEnv } from '../../src/editor/PayRental';
import type { WorkflowController, WorkflowViewState } from '../../src/workflow/controller';
import type { RentalStanding } from '../../src/workflow/rental';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOOKING = { id: 'b0000000-0000-4000-8000-000000000001', supplier_name: 'Northgate Equipment Rental', rental_rate_minor: 60_000 } as EquipmentBookingRow;

function paymentRow(id: string, patch: Partial<PaymentAuthorizationRow>): PaymentAuthorizationRow {
  return { id, amount_minor: 540_000, currency: 'USD', status: 'submitted', paypal_batch_id: null, paypal_item_id: null, fee_minor: null, message: null, ...patch } as PaymentAuthorizationRow;
}

const RECEIPT = {
  id: 'd0000000-0000-4000-8000-000000000001',
  kind: 'receipt',
  payment_authorization_id: 'p-new',
  text_content: 'PayPal references\nPayPal payout batch ID: 5UXD2E8A7EBQJ\nPayPal transaction ID: 9KL12345AB678901C',
} as ProjectDocumentRow;

const standing = (payment: PaymentAuthorizationRow | null): RentalStanding => ({
  booking: BOOKING,
  days: 9,
  costMinor: 540_000,
  quotedCostMinor: 660_000,
  savedMinor: 120_000,
  changed: true,
  pay: payment === null || payment.status === 'authorized' ? 'unpaid' : payment.status === 'succeeded' ? 'paid' : payment.status === 'failed' ? 'failed' : 'paying',
  payment,
});

describe('PayRental', () => {
  let host: HTMLDivElement;
  let root: Root;
  const payRentals = vi.fn(async () => undefined);
  const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const words = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

  const env = (state: Partial<WorkflowViewState> = {}, documents: ProjectDocumentRow[] = []): RentalPayEnv => ({
    controller: { payRentals } as unknown as WorkflowController,
    state: { status: 'ready', snapshot: { documents } as never, loadError: null, busy: null, failure: null, notice: null, ...state },
    currency: 'USD',
    onOpenDocument: () => undefined,
    owner: 'Calloway Construction',
  });
  const render = async (rental: RentalStanding, payEnv: RentalPayEnv) => {
    await act(async () => {
      root.render(<PayRental standing={rental} env={payEnv} />);
    });
  };

  beforeEach(() => {
    payRentals.mockClear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('reviews, sends, follows PayPal, and keeps the batch on the record', async () => {
    await render(standing(null), env());
    const review = byTestId('rental-pay')!;
    expect(words(review)).toBe('Review payment');
    expect(review.querySelector('img')).toBeNull();
    expect(host.querySelector('.paypal-button')).toBeNull();

    await act(async () => review.click());
    expect(byTestId('rental-pay-confirm')!.dataset.phase).toBe('review');
    expect(words(byTestId('rental-pay-line'))).toBe('Northgate Equipment Rental$5,400.00to their PayPal account');
    expect(words(byTestId('rental-pay-fee'))).toBe('$0.25$0.25 per payment · PayPal US Payouts API rate');
    expect(words(byTestId('rental-pay-from'))).toBe("Calloway Construction's PayPal balance");
    expect(words(byTestId('rental-pay-total'))).toBe('$5,400.25');
    // The days stay in view, for the person and for Remy reading the row.
    expect(words(host.querySelector('.review-pay'))).toBe('9 days · $5,400.00');
    expect(payRentals).not.toHaveBeenCalled();

    await act(async () => byTestId('rental-pay-confirmed')!.click());
    expect(payRentals).toHaveBeenCalledWith([BOOKING]);
    await render(standing(null), env({ busy: 'pay' }));
    expect(byTestId('rental-pay-confirm')!.dataset.phase).toBe('sending');
    expect(words(byTestId('rental-pay-line'))).toBe('Northgate Equipment Rental$5,400.00Submitting to PayPal…');

    await render(standing(paymentRow('p-new', { status: 'pending', paypal_batch_id: '5UXD2E8A7EBQJ' })), env({ busy: 'pay' }));
    expect(byTestId('rental-pay-confirm')!.dataset.phase).toBe('sent');
    expect(words(byTestId('rental-pay-batch'))).toBe('Batch ID 5UXD2E8A7EBQJ');
    expect(words(byTestId('rental-pay-line'))).toBe('Northgate Equipment Rental$5,400.00PayPal: Pending');

    await render(standing(paymentRow('p-new', { status: 'succeeded', paypal_batch_id: '5UXD2E8A7EBQJ', fee_minor: 25 })), env({}, [RECEIPT]));
    expect(words(byTestId('rental-pay-line'))).toBe('Northgate Equipment Rental$5,400.00PayPal: Paid · Transaction ID 9KL12345AB678901C');
    expect(words(byTestId('rental-pay-fee'))).toBe('$0.25As reported by PayPal');
    // Paid shows under the sheet too, with its receipt: what Remy listens for.
    expect(words(byTestId('rental-pay-paid'))).toBe('Paid $5,400.00 to Northgate Equipment Rental Receipt');

    await act(async () => byTestId('rental-pay-close')!.click());
    expect(byTestId('rental-pay-confirm')).toBeNull();
    expect(words(byTestId('rental-pay-paid'))).toBe('Paid $5,400.00 to Northgate Equipment Rental · PayPal Payouts · Batch ID 5UXD2E8A7EBQJ Receipt');
    expect(byTestId('rental-pay-paid')!.querySelector('img.paypal-mark')).not.toBeNull();
  });

  it('shows a payment that failed before, then follows only the new one', async () => {
    const failed = paymentRow('p-old', { status: 'failed', message: 'Receiver is ineligible.' });
    await render(standing(failed), env());
    expect(words(byTestId('rental-pay-failed'))).toBe('Receiver is ineligible.');
    await act(async () => byTestId('rental-pay')!.click());
    await act(async () => byTestId('rental-pay-confirmed')!.click());
    // Until the new payment is in, the old refusal is not this payout's.
    await render(standing(failed), env({ busy: 'pay' }));
    expect(words(byTestId('rental-pay-line'))).toBe('Northgate Equipment Rental$5,400.00Submitting to PayPal…');
    await render(standing(paymentRow('p-new', { status: 'pending', message: 'The recipient email has no confirmed PayPal account.', paypal_batch_id: 'B2' })), env());
    expect(words(byTestId('rental-pay-line'))).toBe('Northgate Equipment Rental$5,400.00PayPal: Pending');
    expect(byTestId('rental-pay-processing')!.dataset.held).toBe('true');
  });

  it('goes back to the review when the step is refused before anything reaches PayPal', async () => {
    await render(standing(null), env());
    await act(async () => byTestId('rental-pay')!.click());
    await act(async () => byTestId('rental-pay-confirmed')!.click());
    await render(standing(null), env({ failure: { action: 'pay', message: 'Your approval limit is lower than this payment.' } }));
    expect(byTestId('rental-pay-confirm')!.dataset.phase).toBe('review');
    expect(words(byTestId('rental-pay-error'))).toBe('Your approval limit is lower than this payment.');
    await act(async () => byTestId('rental-pay-cancel')!.click());
    expect(words(byTestId('rental-pay'))).toBe('Review payment');
  });

  it('never calls a payment refused before PayPal submitted: back to the review with the reason, said once', async () => {
    const refusal = "Northgate Equipment Rental is set up to be paid into another party's PayPal account, so the payout can't be sent.";
    await render(standing(null), env());
    await act(async () => byTestId('rental-pay')!.click());
    await act(async () => byTestId('rental-pay-confirmed')!.click());
    const refused = paymentRow('p-new', { status: 'failed', message: refusal });
    await render(standing(refused), env({ failure: { action: 'pay', message: refusal, code: 'PAYEE_REFUSED', bookingIds: [BOOKING.id] } }));
    expect(byTestId('rental-pay-confirm')!.dataset.phase).toBe('review');
    expect(host.textContent).not.toContain('Submitted to PayPal');
    expect(words(byTestId('rental-pay-error'))).toBe(refusal);
    await act(async () => byTestId('rental-pay-cancel')!.click());
    expect(words(byTestId('rental-pay-failed'))).toBe(refusal);
    expect(byTestId('rental-pay-error')).toBeNull();
    expect(words(byTestId('rental-pay'))).toBe('Review payment');
  });

  it('offers again a payment approved but never sent, and follows that same payment once it goes', async () => {
    const unsent = paymentRow('p-1', { status: 'authorized' });
    await render(standing(unsent), env({ failure: { action: 'pay', message: 'PayPal could not be reached.', code: 'PAYPAL_UNAVAILABLE', bookingIds: [BOOKING.id] } }));
    expect(host.textContent).not.toContain('Processing');
    expect(words(byTestId('rental-pay-error'))).toBe('PayPal could not be reached.');
    // Pressing again starts a new step, which clears the last one's failure.
    await render(standing(unsent), env());
    await act(async () => byTestId('rental-pay')!.click());
    await act(async () => byTestId('rental-pay-confirmed')!.click());
    await render(standing(unsent), env({ busy: 'pay' }));
    expect(words(byTestId('rental-pay-line'))).toBe('Northgate Equipment Rental$5,400.00Submitting to PayPal…');
    await render(standing(paymentRow('p-1', { status: 'pending', paypal_batch_id: 'B1' })), env());
    expect(words(byTestId('rental-pay-line'))).toBe('Northgate Equipment Rental$5,400.00PayPal: Pending');
  });

  it('keeps a refusal of another rental off this one', async () => {
    await render(standing(null), env({ failure: { action: 'pay', message: 'Not this one.', code: 'PAYEE_REFUSED', bookingIds: ['b0000000-0000-4000-8000-000000000002'] } }));
    expect(byTestId('rental-pay-error')).toBeNull();
  });
});
