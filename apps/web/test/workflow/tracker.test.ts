/**
 * The pill beside a task bar, and what is behind it: where a rental's payment stands, read from the dates and the
 * payment, with nothing shown for a rental nobody has touched.
 */
import { describe, expect, it } from 'vitest';
import { renderTracker, stepOnBar, trackerBadge } from '../../src/gantt/look';
import { buildTracker } from '../../src/workflow/decorations';
import { rentalStanding } from '../../src/workflow/rental';
import { snapshotAt, type Stage } from './tracker-fixtures';

const cost = { canViewCosts: true, currency: 'USD' as const, receiptFiled: false };

function standingAt(stage: Stage, dates: { start?: string; end?: string } = {}) {
  const snapshot = snapshotAt(stage);
  const booking = { ...snapshot.bookings[0]!, quoted_start: '2026-12-07', quoted_end: '2026-12-18', billable_start: dates.start ?? '2026-12-10', billable_end: dates.end ?? '2026-12-19' };
  return rentalStanding(snapshot, booking);
}

describe('where a rental stands', () => {
  it('measures the dates against the quote, by the calendar day', () => {
    expect(standingAt('cancelled')).toMatchObject({ days: 9, costMinor: 540_000, quotedCostMinor: 660_000, savedMinor: 120_000, changed: true });
    expect(standingAt('cancelled', { start: '2026-12-07', end: '2026-12-18' })).toMatchObject({ days: 11, savedMinor: 0, changed: false });
  });

  it.each<[Stage, string]>([
    ['pending', 'paying'],
    ['authorized', 'unpaid'],
    ['unknown', 'paying'],
    ['succeeded', 'paid'],
    ['paypal-failed', 'failed'],
    ['published', 'unpaid'],
  ])('at %s is %s', (stage, pay) => {
    expect(standingAt(stage).pay).toBe(pay);
  });
});

describe('buildTracker', () => {
  it('says nothing about a rental nobody has touched', () => {
    expect(buildTracker(standingAt('cancelled', { start: '2026-12-07', end: '2026-12-18' }), cost)).toBeNull();
  });

  it.each<[Stage, string, string]>([
    ['published', 'Pending payment', 'warn'],
    ['pending', 'Processing', 'busy'],
    ['succeeded', 'Paid', 'ok'],
    ['paypal-failed', 'Payment failed', 'alert'],
  ])('at %s the bar says %s', (stage, status, tone) => {
    const tracker = buildTracker(standingAt(stage), cost)!;
    expect(stepOnBar(tracker)?.status).toBe(status);
    expect(tracker.tone).toBe(tone);
    expect(renderTracker(tracker)).not.toBeNull();
    expect(trackerBadge(tracker).text).toContain(status);
  });

  it('is paying only while the money is with PayPal', () => {
    expect(buildTracker(standingAt('pending'), cost)!.paying).toBe(true);
    expect(buildTracker(standingAt('succeeded'), cost)).toMatchObject({ paying: false, complete: true });
  });

  it('shows the amount to cost viewers only: what was paid, or what the dates come to', () => {
    expect(buildTracker(standingAt('published'), cost)!.amountMinor).toBe(540_000);
    expect(buildTracker(standingAt('succeeded'), cost)!.amountMinor).toBe(360_000);
    expect(buildTracker(standingAt('published'), { ...cost, canViewCosts: false })!.amountMinor).toBeNull();
  });

  it('marks the payment for PayPal blue and nothing else', () => {
    expect(buildTracker(standingAt('published'), cost)!.steps.filter((step) => step.paypal).map((step) => step.key)).toEqual(['paid']);
  });

  it('says the receipt is filed once it is', () => {
    expect(buildTracker(standingAt('succeeded'), { ...cost, receiptFiled: true })!.steps.at(-1)).toMatchObject({ state: 'done', status: 'Filed' });
  });
});
