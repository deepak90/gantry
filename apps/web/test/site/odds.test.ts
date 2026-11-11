/**
 * The landing page's odds (src/site/landing/odds.ts). The runs it replays are the scheduling engine's own
 * (media/odds-runs.json, written by scripts/odds-runs.ts), read back as the board takes them: a thousand runs each way
 * in run order, 109 and 754 of them by the lease date, the same dice paid two ways, every handover on a working day on
 * the board. The cascade lands each run once, in order, at about the engine's pace, then the board gives its answer and
 * the two boards stand side by side under their own titles; pagehide lets the board go. Without WebGL the block is the
 * still and its words, and the board is never loaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { HARBOR_CONTRACT_DATE, isWorkingDay } from '@collab/shared/seed';
import { percentile, sortedCopy } from '../../src/gantt/monte-carlo-sampling';
import { defaultRange } from '../../src/odds/galton/board';
import type { GaltonOptions, GaltonPhase } from '../../src/odds/galton/odds-galton';
import data from '../../src/site/media/odds-runs.json';
import { NOTES, RUNS_PER_SECOND, TITLES, dayOfIso, landedBy, oddsSummary, readRuns } from '../../src/site/landing/odds';

const iso = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);

interface StandIn {
  begin: Mock;
  whenReady: Mock;
  land: Mock;
  settle: Mock;
  jumpTo: Mock;
  compare: Mock;
  dispose: Mock;
}

/** The board, stood in for: it says each phase a frame or so after the call that leads to it. */
const galton = vi.hoisted(() => ({ loaded: 0, made: [] as { element: HTMLElement; options: unknown; board: StandIn }[] }));
vi.mock('../../src/odds/galton/odds-galton', () => {
  galton.loaded += 1;
  return {
    createOddsGalton: (element: HTMLElement, options: GaltonOptions) => {
      const say = (phase: GaltonPhase, ms: number) => setTimeout(() => options.onPhase?.(phase, performance.now()), ms);
      element.append(document.createElement('canvas'));
      const board: StandIn = {
        begin: vi.fn(() => say('board', 16)),
        whenReady: vi.fn(() => Promise.resolve()),
        land: vi.fn(),
        settle: vi.fn(() => say('result', 700)),
        jumpTo: vi.fn(),
        compare: vi.fn(() => say('compare', 16)),
        dispose: vi.fn(),
      };
      galton.made.push({ element, options, board });
      return board;
    },
  };
});

describe('the runs it replays', () => {
  const runs = readRuns();

  it('are a thousand runs of Harbor each way, in run order, against the lease date', () => {
    expect(iso(runs.contractDay)).toBe(HARBOR_CONTRACT_DATE);
    expect(iso(runs.plannedDay)).toBe('2027-05-27');
    expect(data.asOf).toBe('2026-11-10');
    expect(data.seed).toBe(7);
    for (const choice of [runs.friday, runs.today]) {
      expect(choice.total).toBe(1000);
      expect([...choice.results.runs]).toEqual(Array.from({ length: 1000 }, (_, run) => run));
    }
    // With every length as planned: the pay run lands on Jun 8, paying today keeps May 27.
    expect([iso(runs.friday.plannedDay), iso(runs.today.plannedDay)]).toEqual(['2027-06-08', '2027-05-27']);
  });

  it('give the film’s odds: 109 of 1,000 on Friday’s pay run, 754 paid today, and the percentiles the engine gave', () => {
    expect([runs.friday.onTime, runs.today.onTime]).toEqual([109, 754]);
    expect([data.friday.onTime, data.today.onTime]).toEqual([109, 754]);
    for (const [choice, file] of [
      [runs.friday, data.friday],
      [runs.today, data.today],
    ] as const) {
      const sorted = sortedCopy(choice.results.days);
      expect([iso(percentile(sorted, 0.5)), iso(percentile(sorted, 0.8))]).toEqual([file.p50, file.p80]);
    }
    expect([data.friday.p50, data.friday.p80, data.today.p50, data.today.p80]).toEqual(['2027-06-17', '2027-06-21', '2027-06-09', '2027-06-14']);
  });

  it('are the same dice paid two ways: no run hands over later for paying today', () => {
    const { days: friday } = runs.friday.results;
    const { days: today } = runs.today.results;
    for (let run = 0; run < 1000; run += 1) expect(today[run]!).toBeLessThanOrEqual(friday[run]!);
  });

  it('hand over on working days inside the board’s dates, by the plan’s calendar (weekends and Memorial Day off)', () => {
    const { from, to } = defaultRange(runs.contractDay);
    for (let day = from; day <= to; day += 1) expect(runs.nonWorking(day)).toBe(!isWorkingDay(iso(day), 'standard'));
    expect(runs.nonWorking(dayOfIso('2027-05-31'))).toBe(true);
    for (const choice of [runs.friday, runs.today]) {
      for (const day of choice.results.days) {
        expect(day).toBeGreaterThanOrEqual(from);
        expect(day).toBeLessThanOrEqual(to);
        expect(runs.nonWorking(day)).toBe(false);
      }
    }
  });

  it('say the board’s own words', () => {
    expect(TITLES).toEqual(['Wait till Friday', 'Pay today']);
    expect(NOTES).toEqual(['', 'with PayPal']);
    expect(oddsSummary(runs)).toBe('Wait till Friday: 109 of 1,000 finish by Fri, Jun 11, 11%. Pay today, with PayPal: 754 of 1,000 finish by Fri, Jun 11, 75%.');
  });
});

describe('the cascade', () => {
  it('lands every run once, in run order, a few a frame, in about four seconds', () => {
    const order: number[] = [];
    let landed = 0;
    for (let ms = 0; landed < 1000; ms += 1000 / 60) {
      const upTo = landedBy(ms, 1000);
      expect(upTo).toBeGreaterThanOrEqual(landed);
      expect(upTo - landed).toBeLessThanOrEqual(5);
      for (let run = landed; run < upTo; run += 1) order.push(run);
      landed = upTo;
    }
    expect(order).toEqual(Array.from({ length: 1000 }, (_, run) => run));
    expect(landedBy(0, 1000)).toBe(0);
    expect(landedBy(-50, 1000)).toBe(0);
    expect(landedBy(1e9, 1000)).toBe(1000);
    expect(1000 / RUNS_PER_SECOND).toBeGreaterThan(3);
    expect(1000 / RUNS_PER_SECOND).toBeLessThan(5);
  });
});

describe('the block', () => {
  let getContext: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    galton.loaded = 0;
    galton.made = [];
    document.body.innerHTML = '<section id="odds"><div data-odds><p>Written for no script</p></div></section>';
  });

  afterEach(() => {
    getContext?.mockRestore();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('without WebGL is the still and its words, with no button, and never loads the board', async () => {
    getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { startOdds } = await import('../../src/site/landing/odds');
    startOdds();
    await Promise.resolve();
    const frame = document.querySelector<HTMLElement>('[data-odds] > .odds3d')!;
    expect(frame.dataset.state).toBe('still');
    expect(document.querySelector('[data-odds] > p')).toBeNull();
    const still = frame.querySelector<HTMLImageElement>('picture.odds3d-picture > img.odds3d-still')!;
    expect([still.alt, still.loading, still.width, still.height]).toEqual(['', 'lazy', 1280, 720]);
    expect(still.getAttribute('src')).toMatch(/odds-end\.webp/);
    const narrow = frame.querySelector('picture > source')!;
    expect([narrow.getAttribute('media'), narrow.getAttribute('width'), narrow.getAttribute('height')]).toEqual(['(max-width: 599.98px)', '384', '288']);
    expect(narrow.getAttribute('srcset')).toMatch(/odds-end-narrow\.webp/);
    expect(frame.querySelector('.odds3d-said')?.textContent).toBe(oddsSummary(readRuns()));
    expect(frame.querySelector<HTMLButtonElement>('.odds3d-control')!.hidden).toBe(true);
    expect(frame.querySelector('.odds3d-board')).toBeNull();
    expect(galton.loaded).toBe(0);
  });

  it('pours Friday’s runs in order, gives the board’s answer, then stands the two boards side by side, and lets go on pagehide', async () => {
    getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ getExtension: () => ({ loseContext: () => {} }) } as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    const { startOdds } = await import('../../src/site/landing/odds');
    const runs = readRuns();
    startOdds();
    // Nothing holds it here (no IntersectionObserver in jsdom: the block counts as on screen), so it loads and plays.
    await vi.advanceTimersByTimeAsync(50);
    expect(galton.loaded).toBe(1);
    const [{ element, options, board }] = galton.made as [(typeof galton.made)[number]];
    const frame = document.querySelector<HTMLElement>('.odds3d')!;
    expect(element.className).toBe('odds3d-board');
    expect(element.getAttribute('aria-hidden')).toBe('true');
    expect(options).toMatchObject({ size: 'hero', reducedMotion: false });
    expect(board.begin).toHaveBeenCalledWith(expect.objectContaining({ fresh: true, total: 1000, contractDay: runs.contractDay, plannedDay: runs.friday.plannedDay }));
    expect(frame.hasAttribute('data-live')).toBe(true);
    expect(frame.dataset.state).toBe('playing');

    // The cascade: about four seconds, every run once, in order, each with its own day.
    await vi.advanceTimersByTimeAsync(4200);
    const landed = board.land.mock.calls.flatMap(([batch]) => batch as { run: number; day: number }[]);
    expect(landed.map((entry) => entry.run)).toEqual(Array.from({ length: 1000 }, (_, run) => run));
    expect(landed.map((entry) => entry.day)).toEqual([...runs.friday.results.days]);
    expect(board.settle).toHaveBeenCalledTimes(1);
    expect(board.compare).not.toHaveBeenCalled();

    // The board's answer (its camera arrives 0.7 s later), held for a moment, then the two boards side by side.
    await vi.advanceTimersByTimeAsync(700 + 2400 + 400);
    expect(board.compare).toHaveBeenCalledTimes(1);
    const [left, right, titles, notes] = board.compare.mock.calls[0]!;
    expect([...(left as { days: Int32Array }).days]).toEqual([...runs.friday.results.days]);
    expect([...(right as { days: Int32Array }).days]).toEqual([...runs.today.results.days]);
    expect([titles, notes]).toEqual([TITLES, NOTES]);
    expect(board.jumpTo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(frame.dataset.state).toBe('done');
    const control = frame.querySelector<HTMLButtonElement>('.odds3d-control')!;
    expect([control.hidden, control.textContent]).toEqual([false, 'Replay']);

    // Gone with the page: the board (its worker and canvas) let go, the still back.
    window.dispatchEvent(new Event('pagehide'));
    expect(board.dispose).toHaveBeenCalledTimes(1);
    expect(frame.querySelector('.odds3d-board')).toBeNull();
    expect(frame.dataset.state).toBe('still');
  });
});
