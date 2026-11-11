/**
 * The coach keeps out of the way: after a pause it points at the thing to do, but not while a menu or a popover is
 * open (the header's invite card sits under the coach's layer, so the note would cover it), nor over the odds.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mayCoach, StoryCoach, type CoachStep } from '../../src/onboarding/StoryCoach';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INVITE: CoachStep = { key: 'invite', label: 'Invite a teammate', hint: 'Press Invite, then share the session code.', targets: ['[data-testid="invite-open"]'] };

let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  const button = document.createElement('button');
  button.dataset.testid = 'invite-open';
  button.getBoundingClientRect = () => ({ top: 13, left: 860, width: 70, height: 30, bottom: 43, right: 930, x: 860, y: 13, toJSON: () => ({}) }) as DOMRect;
  document.body.append(button);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function mountCoach() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<StoryCoach step={INVITE} idleMs={1000} onShow={() => undefined} />));
  return () => document.querySelector('[data-testid="story-coach"]');
}

function open(testId: string, className = 'popover') {
  const node = document.createElement('div');
  node.className = className;
  node.dataset.testid = testId;
  document.body.append(node);
  return node;
}

describe('the coach', () => {
  it('waits while the invite card is open, and points once it is closed', () => {
    const card = open('invite-card', 'popover copy-invite-card');
    const coach = mountCoach();
    act(() => vi.advanceTimersByTime(5000));
    expect(coach()).toBeNull();

    card.remove();
    act(() => vi.advanceTimersByTime(1000));
    expect(coach()).not.toBeNull();
    expect(coach()?.textContent).toContain('Invite a teammate');
  });

  it('speaks up on its own once a step, and comes back only when someone asks with Show me', () => {
    const spoken = new Set<string>();
    expect(mayCoach(spoken, 'invite', false)).toBe(true);
    spoken.add('invite');
    expect(mayCoach(spoken, 'invite', false)).toBe(false);
    expect(mayCoach(spoken, 'invite', true)).toBe(true);
    expect(mayCoach(spoken, 'call', false)).toBe(true);
  });

  it('waits while any menu is open, or the odds are up', () => {
    for (const [testId, className] of [
      ['account-menu', 'popover app-user-popover'],
      ['odds-panel', 'odds-panel'],
    ] as const) {
      const node = open(testId, className);
      const coach = mountCoach();
      act(() => vi.advanceTimersByTime(5000));
      expect(coach()).toBeNull();
      node.remove();
      act(() => root!.unmount());
      root = null;
    }
  });
});
