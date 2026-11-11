/**
 * The assistant's hand: it types into a React-controlled box so React sees every letter; it presses with
 * the events of a mouse; it drags with a press, moves and a release; it joins and leaves like a person on
 * a call; and a stopped drag lets go without dropping.
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Hand } from '../../src/rails/hand';
import { RailStopped } from '../../src/rails/wait';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('the assistant’s hand', () => {
  it('types into a React-controlled box, and React sees every letter', async () => {
    const seen: string[] = [];
    function Box() {
      const [text, setText] = useState('');
      return (
        <textarea
          data-testid="box"
          value={text}
          onChange={(event) => {
            seen.push(event.target.value);
            setText(event.target.value);
          }}
        />
      );
    }
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Box />));
    const box = document.querySelector<HTMLTextAreaElement>('[data-testid="box"]')!;
    await act(() => new Hand({ speed: 0 }).type(box, 'Hi you'));
    expect(seen).toEqual(['H', 'Hi', 'Hi ', 'Hi y', 'Hi yo', 'Hi you']);
    expect(box.value).toBe('Hi you');
  });

  it('types over a number the way a person does: selects it, then the first key replaces it', async () => {
    const seen: string[] = [];
    function Amount() {
      const [text, setText] = useState('6000');
      return (
        <input
          data-testid="amount"
          value={text}
          onChange={(event) => {
            seen.push(event.target.value);
            setText(event.target.value);
          }}
        />
      );
    }
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Amount />));
    const amount = document.querySelector<HTMLInputElement>('[data-testid="amount"]')!;
    await act(() => new Hand({ speed: 0 }).type(amount, '7500', undefined, { replace: true }));
    expect(seen).toEqual(['7', '75', '750', '7500']);
  });

  it('carries a drag slowly along a bent path, never a straight line, and lets go on the spot', async () => {
    const source = document.createElement('div');
    document.body.append(source);
    const moves: { x: number; y: number }[] = [];
    const record = (event: Event) => {
      const mouse = event as MouseEvent;
      if (mouse.buttons === 1) moves.push({ x: mouse.clientX, y: mouse.clientY });
    };
    document.addEventListener('pointermove', record);
    const hand = new Hand({ speed: 25, seed: 7 });
    await hand.join({ x: 40, y: 40 });
    // jsdom lays nothing out, so the source sits at 0,0.
    await hand.drag(source, { x: 700, y: 420 }, undefined, { hold: 100 });
    document.removeEventListener('pointermove', record);
    expect(moves.length).toBeGreaterThan(12);
    expect(hand.position).toEqual({ x: 700, y: 420 });
    // How far the carry strays from the straight line between where it was picked up and where it landed.
    const from = { x: 0, y: 0 };
    const to = { x: 700, y: 420 };
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const off = (point: { x: number; y: number }) => Math.abs((to.x - from.x) * (from.y - point.y) - (from.x - point.x) * (to.y - from.y)) / length;
    expect(Math.max(...moves.map(off))).toBeGreaterThan(15);
    hand.destroy();
  });

  it('carries a straight drag in one line onto the spot, without a bend, when asked', async () => {
    const source = document.createElement('div');
    document.body.append(source);
    const moves: { x: number; y: number }[] = [];
    const record = (event: Event) => {
      const mouse = event as MouseEvent;
      if (mouse.buttons === 1) moves.push({ x: mouse.clientX, y: mouse.clientY });
    };
    document.addEventListener('pointermove', record);
    const hand = new Hand({ speed: 25, seed: 7 });
    await hand.join({ x: 40, y: 40 });
    await hand.drag(source, { x: 700, y: 420 }, undefined, { hold: 100, straight: true });
    document.removeEventListener('pointermove', record);
    expect(moves.length).toBeGreaterThan(3);
    expect(hand.position).toEqual({ x: 700, y: 420 });
    const from = { x: 0, y: 0 };
    const to = { x: 700, y: 420 };
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const off = (point: { x: number; y: number }) => Math.abs((to.x - from.x) * (from.y - point.y) - (from.x - point.x) * (to.y - from.y)) / length;
    expect(Math.max(...moves.map(off))).toBeLessThan(1.5);
    hand.destroy();
  });

  it('double-clicks as a mouse does: two presses, then the double click', async () => {
    const cell = document.createElement('div');
    document.body.append(cell);
    const events: string[] = [];
    for (const type of ['mousedown', 'click', 'dblclick']) cell.addEventListener(type, (event) => events.push(`${type} ${(event as MouseEvent).detail}`));
    await new Hand({ speed: 0 }).doubleClick(cell);
    expect(events).toEqual(['mousedown 1', 'click 1', 'mousedown 2', 'click 2', 'dblclick 2']);
  });

  it('presses with the events of a mouse, then a click', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    const events: string[] = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) button.addEventListener(type, () => events.push(type));
    await new Hand({ speed: 0 }).click(button);
    expect(events).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  });

  it('right-clicks with the right button and asks for the menu, without a click', async () => {
    const bar = document.createElement('div');
    document.body.append(bar);
    const events: string[] = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'contextmenu']) bar.addEventListener(type, (event) => events.push(`${type} ${(event as MouseEvent).button}`));
    await new Hand({ speed: 0 }).rightClick(bar);
    expect(events).toEqual(['pointerdown 2', 'mousedown 2', 'pointerup 2', 'mouseup 2', 'contextmenu 2']);
  });

  it('drags: a press on the source, moves with the button held, and a release', async () => {
    const source = document.createElement('div');
    document.body.append(source);
    const events: string[] = [];
    source.addEventListener('pointerdown', () => events.push('down'));
    document.addEventListener('pointermove', (event) => {
      if ((event as MouseEvent).buttons === 1) events.push('move');
    });
    document.addEventListener('pointerup', () => events.push('up'));
    const hand = new Hand({ speed: 0 });
    await hand.drag(source, { x: 300, y: 200 });
    expect(events[0]).toBe('down');
    expect(events.at(-1)).toBe('up');
    expect(events.filter((event) => event === 'move').length).toBeGreaterThanOrEqual(6);
    expect(hand.position).toEqual({ x: 300, y: 200 });
  });

  it('joins and leaves like a person on a call', async () => {
    const hand = new Hand({ speed: 0 });
    // Not on the page until it joins.
    expect(document.querySelector('[data-testid="rail-hand"]')).toBeNull();
    await hand.join({ x: 10, y: 10 });
    const cursor = document.querySelector<HTMLElement>('[data-testid="rail-hand"]')!;
    expect(hand.present).toBe(true);
    expect(cursor.hidden).toBe(false);
    await hand.leave();
    expect(hand.present).toBe(false);
    expect(cursor.hidden).toBe(true);
  });

  it('comes back on the page when it joins after being taken off it', async () => {
    const hand = new Hand({ speed: 0 });
    // What React's development mode does: the page's cleanup runs once, then the page mounts again.
    hand.destroy();
    expect(document.querySelectorAll('[data-testid="rail-hand"]')).toHaveLength(0);
    await hand.join({ x: 10, y: 10 });
    const cursor = document.querySelector<HTMLElement>('[data-testid="rail-hand"]');
    expect(cursor?.isConnected).toBe(true);
    expect(cursor?.hidden).toBe(false);
    hand.destroy();
  });

  it('a drag stopped part way lets go with Escape, so nothing lands', async () => {
    const source = document.createElement('div');
    document.body.append(source);
    const events: string[] = [];
    document.addEventListener('keydown', (event) => events.push(`key ${event.key}`));
    document.addEventListener('pointerup', () => events.push('up'));
    const stop = new AbortController();
    // Stopped once the button is down: the first move frame sees it.
    source.addEventListener('pointerdown', () => stop.abort());
    const hand = new Hand({ speed: 0 });
    await expect(hand.drag(source, { x: 300, y: 200 }, stop.signal)).rejects.toBeInstanceOf(RailStopped);
    expect(events).toEqual(['key Escape', 'up']);
  });
});
