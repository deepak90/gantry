/**
 * The header's "Plan date" (src/app/PlanDate.tsx): it shows only on a build whose plan date is pinned, names the day,
 * and says why when pressed: the forecast and the odds match the film, and the times are real.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanDate, planDateWords } from '../../src/app/PlanDate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the plan date in the header', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) {
      const mounted = root;
      await act(async () => mounted.unmount());
      root = undefined;
    }
    container?.remove();
  });

  async function mount(day: string | null) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const mounted = root;
    await act(async () => mounted.render(<PlanDate day={day} />));
    return container;
  }

  it('shows nothing on the real clock', async () => {
    const shown = await mount(null);
    expect(shown.innerHTML).toBe('');
  });

  it('names the film’s day, and says why when pressed: the forecast and the odds match the film, the times are real', async () => {
    const shown = await mount('2026-11-10');
    const button = shown.querySelector<HTMLButtonElement>('[data-testid="plan-date"]')!;
    expect(button.getAttribute('aria-label')).toBe('Plan date: Tue, Nov 10, 2026');
    expect(button.textContent).toContain('Plan date: Tue, Nov 10, 2026');
    expect(button.title).toBe('This demo runs on the film’s day, so the forecast and the odds match the film. Times on messages, calls and payments are real.');
    expect(shown.querySelector('[data-testid="plan-date-card"]')).toBeNull();
    await act(async () => button.click());
    const card = shown.querySelector('[data-testid="plan-date-card"]')!;
    expect(card.textContent).toBe('Plan date: Tue, Nov 10, 2026This demo runs on the film’s day, so the forecast and the odds match the film. Times on messages, calls and payments are real.');
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('says plainly what another pinned day means', () => {
    expect(planDateWords('2026-11-03')).toBe('This build treats Tue, Nov 3, 2026 as today for the plan. Times on messages, calls and payments are real.');
  });
});
