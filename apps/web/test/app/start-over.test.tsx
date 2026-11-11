/**
 * Start over, in the account menu on the hosted site: asked twice, because the session is everyone's in it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { START_OVER_WARNING, StartOverItem } from '../../src/app/StartOver';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Start over', () => {
  it('says what happens, for everyone in the session, and only then starts over', () => {
    const startOver = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<StartOverItem onStartOver={startOver} />));

    act(() => host.querySelector<HTMLButtonElement>('[data-testid="menu-start-over"]')!.click());
    expect(host.textContent).toContain('Everything in this session goes back to how it started, for everyone in it.');
    expect(START_OVER_WARNING).not.toMatch(/\bcopy\b/);
    expect(startOver).not.toHaveBeenCalled();

    // Cancel puts the question away; asked again, the second press starts over.
    act(() => host.querySelector<HTMLButtonElement>('.app-user-confirm .button.is-quiet')!.click());
    expect(host.querySelector('[data-testid="menu-start-over-confirm"]')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="menu-start-over"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="menu-start-over-confirm"]')!.click());
    expect(startOver).toHaveBeenCalledTimes(1);
  });
});
