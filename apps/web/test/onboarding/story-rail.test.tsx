/**
 * The counter in the header with a project's own steps, which go in order: it stands on the first step not done,
 * turns to the next as each is done (back, when one comes undone), offers Show me on the step at hand only, and
 * shows what "done" looks like once every step is.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoryRail } from '../../src/onboarding/StoryRail';
import { rentalsStory, type RentalFacts } from '../../src/onboarding/story';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const FRESH: RentalFacts = { watching: false, undecided: 0, accepted: 0, unpaid: 0, paid: 0, receipts: 0 };

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('the counter with a project’s steps', () => {
  it('turns through the steps in order, and back when one comes undone', () => {
    const onShow = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const render = (facts: Partial<RentalFacts>) => act(() => root!.render(<StoryRail story={rentalsStory({ ...FRESH, ...facts })} onShow={onShow} onHide={() => undefined} />));
    const label = () => host.querySelector('[data-testid="story-rail-button"]')!.getAttribute('aria-label');

    render({});
    expect(label()).toBe('Step 1 of 5: Set a rule on the rentals');
    render({ watching: true, undecided: 3 });
    expect(label()).toBe('Step 2 of 5: Accept a fix');
    render({ watching: true, undecided: 2, accepted: 1, unpaid: 1 });
    expect(label()).toBe('Step 3 of 5: Decide the rest');

    // Show me is for the step at hand: turned to another, there is none.
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="story-rail-button"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="story-show"]')!.click());
    expect(onShow.mock.calls[0]![0]).toMatchObject({ key: 'decide' });
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="story-rail-button"]')!.click());
    act(() => void host.querySelector<HTMLElement>('.story-drum')!.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, cancelable: true })));
    expect(host.querySelector('[data-testid="story-show"]')).toBeNull();

    // The rule taken away: back to the start.
    render({});
    expect(label()).toBe('Step 1 of 5: Set a rule on the rentals');
    render({ watching: true, undecided: 0, accepted: 2, paid: 2, receipts: 2 });
    expect(label()).toBe('Every rental is settled');
  });
});
