/**
 * On the call bar: what to say once Remy is on the call (a few questions, one at a time, and the name rule), closing by
 * itself after the first exchange with her or 20 seconds, or with its button.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Motion's exits never finish under fake timers here: plain elements stand in, so what shows is what the strip decided.
vi.mock('motion/react', async () => {
  const React = await import('react');
  const MOTION_PROPS = new Set(['initial', 'animate', 'exit', 'transition', 'variants', 'custom', 'layout']);
  const made = new Map<string, unknown>();
  const element = (tag: string) =>
    React.forwardRef<unknown, Record<string, unknown>>((props, ref) =>
      React.createElement(tag, { ...Object.fromEntries(Object.entries(props).filter(([key]) => !MOTION_PROPS.has(key))), ref }),
    );
  return {
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    motion: new Proxy({}, { get: (_target, tag: string) => made.get(tag) ?? made.set(tag, element(tag)).get(tag) }),
    useReducedMotion: () => false,
  };
});

import { CallTip, TIP_HINT, TIP_LINES, TIP_SHOW_MS, TIP_TURN_MS, type TipCall } from '../../src/call/CallTip';
import { REMY, type RemyMessage } from '../../src/call/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return (next: React.ReactNode) => act(() => root!.render(next));
}

/** A call that tells the tip what Remy hears and says. */
function fakeCall() {
  const listeners = new Set<(message: RemyMessage, from: string | null) => void>();
  const call: TipCall = {
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const send = (message: RemyMessage, from: string | null = REMY) => act(() => listeners.forEach((listener) => listener(message, from)));
  return { call, send, listening: () => listeners.size };
}

const tip = () => document.querySelector('[data-testid="call-tip"]');
const line = () => document.querySelector('[data-testid="call-tip-line"]')?.textContent ?? null;
/** Lets the strip's way out (its exit animation) finish. */
const settle = () => act(() => vi.advanceTimersByTime(1_000));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('what to say, once the call starts', () => {
  it('waits for Remy, then shows a question to ask her and how to talk to her', () => {
    const { call } = fakeCall();
    const render = mount(<CallTip call={call} remyHere={false} />);
    expect(tip()).toBeNull();
    render(<CallTip call={call} remyHere />);
    expect(tip()).not.toBeNull();
    expect(line()).toBe(`“${TIP_LINES[0]}”`);
    expect(tip()!.textContent).toContain('Try saying');
    expect(tip()!.textContent).toContain(TIP_HINT);
    expect(TIP_HINT).toBe('Just talk. With others on the call, start with “Remy, …”');
  });

  it('turns to the next question every few seconds', () => {
    const { call } = fakeCall();
    mount(<CallTip call={call} remyHere />);
    const seen = [line()];
    for (let turn = 1; turn < TIP_LINES.length; turn += 1) {
      act(() => vi.advanceTimersByTime(TIP_TURN_MS));
      settle();
      seen.push(line());
    }
    expect(seen).toEqual(TIP_LINES.map((text) => `“${text}”`));
    expect(TIP_LINES.length).toBeGreaterThanOrEqual(3);
    expect(TIP_LINES.length).toBeLessThanOrEqual(4);
  });

  it('closes by itself after 20 seconds, and stays closed on this call', () => {
    const { call, listening } = fakeCall();
    const render = mount(<CallTip call={call} remyHere />);
    act(() => vi.advanceTimersByTime(TIP_SHOW_MS - 1));
    expect(tip()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    settle();
    expect(tip()).toBeNull();
    expect(listening()).toBe(0);
    render(<CallTip call={call} remyHere={false} />);
    render(<CallTip call={call} remyHere />);
    expect(tip()).toBeNull();
  });

  it('closes after the first exchange with Remy: a line said to her, then the end of her answer', () => {
    const { call, send } = fakeCall();
    mount(<CallTip call={call} remyHere />);
    // Her greeting ends: no exchange yet.
    send({ kind: 'said', id: 'greeting', interrupted: false });
    // People talking to each other, and a line from someone else's tab pretending to be her.
    send({ kind: 'heard', identity: 'ana', text: 'Can you hear me?', addressed: false, final: true, at: 1 });
    send({ kind: 'said', id: 'x', interrupted: false });
    send({ kind: 'heard', identity: 'ana', text: 'What does the crane cost?', addressed: true, final: true, at: 2 }, 'ana');
    send({ kind: 'said', id: 'y', interrupted: false });
    settle();
    expect(tip()).not.toBeNull();
    send({ kind: 'heard', identity: 'ana', text: 'What does the crane cost?', addressed: true, final: true, at: 3 });
    send({ kind: 'filler', text: 'Let me look.' });
    expect(tip()).not.toBeNull();
    send({ kind: 'said', id: 'answer', interrupted: false });
    settle();
    expect(tip()).toBeNull();
  });

  it('closes with its button', () => {
    const { call } = fakeCall();
    mount(<CallTip call={call} remyHere />);
    const close = document.querySelector<HTMLButtonElement>('[data-testid="call-tip-close"]')!;
    expect(close.getAttribute('aria-label')).toBe('Close');
    act(() => close.click());
    settle();
    expect(tip()).toBeNull();
  });
});
