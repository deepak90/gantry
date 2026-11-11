/**
 * The cost line on Remy's change card: it says what the cost was and what it becomes, and keeps saying so after the
 * change is applied, when the task itself already has the new amount.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { CostChanges, RentalChanges } from '../../src/assistant/plan-cards';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPERATIONS = [{ op: 'set_cost', task: 1, amount: 105_000 }] as never;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
});

function show(task: { name: string; budgetMinor: number }) {
  const project = { taskStore: { getById: () => task } } as never;
  const draw = () => act(() => root!.render(<CostChanges operations={OPERATIONS} project={project} currency="USD" />));
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  draw();
  return { text: () => host!.textContent?.trim(), draw };
}

describe('the cost line on a change', () => {
  it('still says what it was after the change is applied', () => {
    const task = { name: 'Order light fixtures', budgetMinor: 3_500_000 };
    const card = show(task);
    expect(card.text()).toBe('Order light fixtures: $35,000 → $105,000');
    task.budgetMinor = 10_500_000;
    card.draw();
    expect(card.text()).toBe('Order light fixtures: $35,000 → $105,000');
  });

  it('shows no change of amount when it first appears with the amount already in place', () => {
    expect(show({ name: 'Order light fixtures', budgetMinor: 10_500_000 }).text()).toBe('Order light fixtures: $105,000');
  });
});

describe('the rental line on a change', () => {
  it('compares the whole rental, before and after, and keeps doing so once it is applied', () => {
    const booking = { billable_start: '2026-11-25', billable_end: '2026-12-24', rental_rate_minor: 60_000 };
    const operations = [{ op: 'set_rental', task: 1, first_day: '2026-11-30', last_day: '2026-12-18' }] as never;
    const draw = () => act(() => root!.render(<RentalChanges operations={operations} bookingOn={(() => booking) as never} currency="USD" />));
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    draw();
    expect(host.textContent?.trim()).toBe('19 days on rent, $17,400 → $11,400: saves $6,000');
    Object.assign(booking, { billable_start: '2026-11-30', billable_end: '2026-12-19' });
    draw();
    expect(host.textContent?.trim()).toBe('19 days on rent, $17,400 → $11,400: saves $6,000');
  });
});
