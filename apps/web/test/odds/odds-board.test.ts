/**
 * The odds panel's board, around the 3D board itself (a stand-in here: jsdom has no WebGL): what the controller says
 * before the board is loaded is kept and handed over from the last pass on; the runs wait for the board only while
 * it is on screen; a browser that can't make it falls back to the dots; the board can fill the chart's side and come
 * back; the side by side is the panel's own runs in the film's words, over the whole of the plan's area, and leaves
 * everything where it was; it stacks as a building one board at a time, or both from its quiet button; and one board
 * is kept per controller for a while after the panel closes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OddsComparison, OddsController } from '../../src/odds/odds-controller';
import type { Simulation } from '../../src/gantt/monte-carlo';

const fake = vi.hoisted(() => {
  interface Board {
    container: HTMLElement;
    size: string;
    log: string[];
    readyAsked: number;
    release: () => void;
    disposed: boolean;
  }
  const boards: Board[] = [];
  return { boards, fail: false };
});

vi.mock('../../src/odds/galton/odds-galton', () => {
  function createOddsGalton(container: HTMLElement, options: { size?: string }) {
    if (fake.fail) throw new Error('Error creating WebGL context.');
    let release = () => undefined as void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record = { container, size: options.size ?? 'panel', log: [] as string[], readyAsked: 0, release: () => release(), disposed: false, stacked: new Set<string>() };
    fake.boards.push(record);
    return {
      begin: (pass: { fresh: boolean }) => record.log.push(`begin:${pass.fresh ? 'fresh' : 'again'}`),
      land: (landed: unknown[]) => record.log.push(`land:${landed.length}`),
      settle: () => record.log.push('settle'),
      morph: (_results: unknown, options: { instant?: boolean } = {}) => record.log.push(`morph:${options.instant ? 'instant' : 'moving'}`),
      jumpTo: (state: string) => record.log.push(`jump:${state}`),
      compare: (left: { runs: ArrayLike<number> }, right: { runs: ArrayLike<number> }, titles: string[], notes: string[]) =>
        record.log.push(`compare:${titles.join(' | ')}:${notes.join(' | ')}:${left.runs.length}/${right.runs.length}`),
      single: () => record.log.push('single'),
      stack: (side?: string) => {
        record.log.push(`stack:${side ?? 'both'}`);
        for (const each of side ? [side] : ['left', 'right']) record.stacked.add(each);
        return Promise.resolve();
      },
      unstack: () => {
        record.log.push('unstack');
        record.stacked.clear();
      },
      isStacked: () => record.stacked.size > 0,
      setSize: (size: string) => {
        record.size = size;
        record.log.push(`size:${size}`);
      },
      whenReady: () => {
        record.readyAsked += 1;
        return ready;
      },
      dispose: () => {
        record.disposed = true;
      },
    };
  }
  // As the board's own: the controller's `end` settles, `show` morphs.
  function galtonSink(board: ReturnType<typeof createOddsGalton>) {
    return {
      begin: (pass: { fresh: boolean }) => board.begin(pass),
      land: (landed: unknown[]) => board.land(landed),
      end: () => board.settle(),
      show: (runs: ArrayLike<number>, days: ArrayLike<number>, instant?: boolean) => board.morph({ runs, days }, { instant: instant ?? false }),
    };
  }
  return { createOddsGalton, galtonSink };
});

const { acquireBoardView, oddsBoard, releaseBoardView } = await import('../../src/odds/odds-board');

if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const PASS = { fresh: true, total: 3, contractDay: 100, plannedDay: 95, nonWorking: () => false };
const runs = (count: number) => ({ runs: Int32Array.from({ length: count }, (_, i) => i), days: Int32Array.from({ length: count }, () => 100) }) as unknown as Simulation;
const controllerWith = (pair: OddsComparison | null = null) => ({ comparison: () => pair }) as unknown as OddsController;
const settled = () => vi.dynamicImportSettled();
/** True once the promise has resolved, after the microtasks queued so far. */
async function resolved(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

const opened: { release(): void }[] = [];
afterEach(() => {
  opened.splice(0).forEach((view) => view.release());
  fake.fail = false;
  vi.useRealTimers();
});

function openPanel(controller = controllerWith(), chartSide: Parameters<typeof acquireBoardView>[1] = () => null) {
  const slot = document.createElement('div');
  document.body.append(slot);
  const view = acquireBoardView(controller, chartSide);
  view.mount(slot);
  const handle = {
    view,
    slot,
    release: () => {
      view.unmount(slot);
      releaseBoardView(view);
      slot.remove();
    },
  };
  opened.push(handle);
  return handle;
}

describe('the odds panel’s board', () => {
  it('keeps what the controller says until the board is loaded, then hands it over from the last pass on', async () => {
    const { view, slot } = openPanel();
    expect(slot.firstElementChild).toBe(view.host);
    view.sink.begin(PASS);
    view.sink.land([{ run: 1, day: 100 }]);
    // The pass was asked again before the board came: only the newer one counts.
    view.sink.begin({ ...PASS, fresh: false });
    view.sink.land([{ run: 1, day: 99 }, { run: 2, day: 101 }]);
    await settled();
    const board = fake.boards.at(-1)!;
    expect(board.container).toBe(view.host);
    expect(board.log).toEqual(['begin:again', 'land:2']);
    view.sink.end([1, 2]);
    view.sink.show(Int32Array.of(1, 2), Int32Array.of(99, 100), true);
    expect(board.log.slice(2)).toEqual(['settle', 'morph:instant']);
  });

  it('lets the runs wait for the board’s physics only while the board is on screen', async () => {
    const { view } = openPanel();
    view.sink.begin(PASS);
    const ready = view.sink.ready!();
    await settled();
    const board = fake.boards.at(-1)!;
    expect(await resolved(ready)).toBe(false);
    expect(board.readyAsked).toBe(1);
    board.release();
    expect(await resolved(ready)).toBe(true);
    // The dots on screen: nothing to wait for, whatever the board is doing.
    const other = openPanel(controllerWith());
    other.view.setShown(false);
    other.view.sink.begin(PASS);
    expect(await resolved(other.view.sink.ready!())).toBe(true);
  });

  it('falls back to the dots when this browser can’t make the board', async () => {
    fake.fail = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { view } = openPanel(controllerWith());
    view.sink.begin(PASS);
    await settled();
    expect(view.getState().failed).toBe(true);
    expect(await resolved(view.sink.ready!())).toBe(true);
    errors.mockRestore();
  });

  it('fills the chart’s side at hero size, from the chart side’s left edge, and goes back into the panel', async () => {
    const frame = document.createElement('div');
    const side = document.createElement('div');
    frame.append(side);
    document.body.append(frame);
    frame.getBoundingClientRect = () => ({ left: 40, top: 0, right: 1240, bottom: 800, width: 1200, height: 800 }) as DOMRect;
    side.getBoundingClientRect = () => ({ left: 560, top: 60, right: 1240, bottom: 800, width: 680, height: 740 }) as DOMRect;
    const { view, slot } = openPanel(controllerWith(), () => ({ frame, side }));
    view.sink.begin(PASS);
    await settled();
    const board = fake.boards.at(-1)!;
    view.setHero(true);
    const hero = frame.querySelector<HTMLElement>('.odds-hero')!;
    expect(view.getState().hero).toBe(true);
    expect(oddsBoard.hero).toBe(true);
    expect(hero.firstElementChild).toBe(view.host);
    expect(hero.style.left).toBe('520px');
    expect(board.size).toBe('hero');
    hero.querySelector<HTMLButtonElement>('.odds-hero-back')!.click();
    expect(view.getState().hero).toBe(false);
    expect(slot.firstElementChild).toBe(view.host);
    expect(frame.querySelector('.odds-hero')).toBeNull();
    expect(board.size).toBe('panel');
    frame.remove();
  });

  it('stays in the panel when there is no chart to lay the board over', async () => {
    const { view, slot } = openPanel(controllerWith(), () => null);
    view.setHero(true);
    expect(view.getState().hero).toBe(false);
    expect(slot.firstElementChild).toBe(view.host);
    oddsBoard.setHero(false);
  });

  it('puts the panel’s own runs side by side in the film’s words, and only when it has them', async () => {
    const pair = { wait: runs(4), pay: runs(5) };
    const { view } = openPanel(controllerWith(pair));
    view.sink.begin(PASS);
    await settled();
    expect(oddsBoard.compare()).toBe(true);
    const board = fake.boards.at(-1)!;
    // Short titles for one line each; PayPal named under the second, whose title names the day once it is told it.
    expect(board.log.at(-1)).toBe('compare:Wait till Friday | Pay when due: | with PayPal:4/5');
    oddsBoard.setPayTitle('Pay by Tuesday');
    expect(oddsBoard.compare()).toBe(true);
    expect(board.log.at(-1)).toBe('compare:Wait till Friday | Pay by Tuesday: | with PayPal:4/5');
    oddsBoard.setPayTitle('Pay when due');
    // A way forward shown afterwards takes the board back to one first.
    view.sink.show(Int32Array.of(1), Int32Array.of(100));
    expect(board.log.slice(-2)).toEqual(['single', 'morph:moving']);
    oddsBoard.jumpTo('result');
    expect(board.log.at(-1)).toBe('jump:result');
    const none = openPanel(controllerWith(null));
    none.view.sink.begin(PASS);
    await settled();
    expect(oddsBoard.compare()).toBe(false);
  });

  it('covers the whole of the plan’s area while two boards stand side by side, and leaves everything where it was', async () => {
    // The plan's area: the chart's frame (the grid and the chart side) and the odds panel beside it.
    const area = document.createElement('div');
    area.className = 'collab-gantt-body';
    const frame = document.createElement('div');
    const side = document.createElement('div');
    frame.append(side);
    area.append(frame);
    document.body.append(area);
    const pair = { wait: runs(4), pay: runs(5) };
    const { view, slot } = openPanel(controllerWith(pair), () => ({ frame, side }));
    view.sink.begin(PASS);
    await settled();
    expect(view.compare()).toBe(true);
    const cover = area.querySelector<HTMLElement>(':scope > .odds-takeover')!;
    expect(cover).not.toBeNull();
    expect(cover.firstElementChild).toBe(view.host);
    // One board again: back in the panel, nothing left over the plan.
    oddsBoard.single();
    expect(slot.firstElementChild).toBe(view.host);
    expect(area.querySelector('.odds-takeover')).toBeNull();
    // Over the chart's side when the side by side began there: back over the chart's side.
    view.setHero(true);
    const hero = frame.querySelector<HTMLElement>('.odds-hero')!;
    expect(hero.firstElementChild).toBe(view.host);
    expect(view.compare()).toBe(true);
    expect(cover.isConnected).toBe(true);
    expect(cover.firstElementChild).toBe(view.host);
    // A new pass (PayPal paid) takes it back too, before the board drains and refills.
    view.sink.begin({ ...PASS, fresh: false });
    expect(hero.firstElementChild).toBe(view.host);
    expect(cover.isConnected).toBe(false);
    // Its own button, and leaving the hero, do as well.
    expect(view.compare()).toBe(true);
    cover.querySelector<HTMLButtonElement>('.odds-takeover-back')!.click();
    expect(hero.firstElementChild).toBe(view.host);
    expect(view.compare()).toBe(true);
    view.setHero(false);
    expect(slot.firstElementChild).toBe(view.host);
    expect(cover.isConnected).toBe(false);
    // Asked to stay in place, it does.
    expect(view.compare({ takeover: false })).toBe(true);
    expect(slot.firstElementChild).toBe(view.host);
    expect(cover.isConnected).toBe(false);
    view.single();
    area.remove();
  });

  it('stacks the side by side as a building, one board at a time or both, and its quiet button switches piles and towers', async () => {
    const area = document.createElement('div');
    area.className = 'collab-gantt-body';
    const frame = document.createElement('div');
    const side = document.createElement('div');
    frame.append(side);
    area.append(frame);
    document.body.append(area);
    const pair = { wait: runs(4), pay: runs(5) };
    const { view } = openPanel(controllerWith(pair), () => ({ frame, side }));
    view.sink.begin(PASS);
    await settled();
    // One board: nothing to stack side by side.
    expect(await oddsBoard.stack('wait')).toBe(false);
    expect(view.compare()).toBe(true);
    const board = fake.boards.at(-1)!;
    const button = area.querySelector<HTMLButtonElement>('.odds-takeover-stack')!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.title).toBe('Stack the runs like a building');
    // Friday's board as Remy talks about it, then today's: the left board, then the right.
    expect(await oddsBoard.stack('wait')).toBe(true);
    expect(board.log.at(-1)).toBe('stack:left');
    expect(await oddsBoard.stack('pay')).toBe(true);
    expect(board.log.at(-1)).toBe('stack:right');
    expect(oddsBoard.stacked).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.title).toBe('Back to the piles');
    // The button puts the piles back, and stacks both again.
    button.click();
    expect(board.log.at(-1)).toBe('unstack');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click();
    expect(board.log.at(-1)).toBe('stack:both');
    oddsBoard.jumpTo('stacked');
    expect(board.log.at(-1)).toBe('jump:stacked');
    oddsBoard.unstack();
    expect(oddsBoard.stacked).toBe(false);
    view.single();
    area.remove();
  });

  it('keeps one board per controller a while after the panel closes, and lets it go for another controller', async () => {
    const controller = controllerWith();
    const first = openPanel(controller);
    first.view.sink.begin(PASS);
    await settled();
    const board = fake.boards.at(-1)!;
    vi.useFakeTimers();
    opened.splice(opened.indexOf(first), 1);
    first.release();
    vi.advanceTimersByTime(30_000);
    const again = openPanel(controller);
    expect(again.view).toBe(first.view);
    expect(board.disposed).toBe(false);
    // Closed for longer than it is kept: it goes.
    opened.splice(opened.indexOf(again), 1);
    again.release();
    vi.advanceTimersByTime(90_000);
    expect(board.disposed).toBe(true);
    // Another project's controller never gets this one's board.
    const fresh = openPanel(controllerWith());
    expect(fresh.view).not.toBe(first.view);
  });

  it('tells the film when the panel’s board is ready to pour', async () => {
    let ready = false;
    const waiting = oddsBoard.whenReady().then(() => (ready = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ready).toBe(false);
    const { view } = openPanel(controllerWith());
    await settled();
    expect(ready).toBe(false);
    view.sink.begin(PASS);
    fake.boards.at(-1)!.release();
    await waiting;
    expect(ready).toBe(true);
  });
});
