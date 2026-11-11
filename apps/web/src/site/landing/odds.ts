/**
 * The odds on the landing page (`[data-odds]`): the app's own Galton board (odds/galton/odds-galton.ts) replaying real
 * runs of Harbor Street Offices on Bryntum's scheduling engine (media/odds-runs.json, written by
 * scripts/odds-runs.ts). First the footings paid on Friday's pay run: a thousand runs pour through the pegs, one
 * marble per run into its handover day's bin, at about the pace the engine makes them in the app, and the board says
 * its number and its words. Then the same runs paid today stand beside them, "Wait till Friday" against "Pay today",
 * the board's own titles. It plays once, the first time the block is well on screen, and holds there.
 *
 * Nothing heavy loads before the block nears the screen: then three.js, the board and its physics worker (Rapier)
 * come in, and a still of the end (media/odds-end.webp) stands in until the board is drawn. The still is all there is
 * under reduced motion (with Play, to see it move), below 600px wide and without WebGL 2. The replay waits while the
 * block is off screen or the tab is hidden, and the board, its worker and its canvas are let go on pagehide. The
 * button in the corner pauses, plays and replays it.
 *
 * Inside `[data-odds]`, which the page sizes:
 *   <div class="odds3d" data-state="still | loading | ready | playing | paused | done" [data-live]>
 *     <picture class="odds3d-picture">                          the end, until the board is drawn (a narrower
 *       <source media="(max-width: 599.98px)">                  one on phones, so its words read there)
 *       <img class="odds3d-still" alt="">
 *     </picture>
 *     <div class="odds3d-board galton" aria-hidden="true">…</div>  the board's canvas and words, while it lives
 *     <p class="odds3d-said">…</p>                                what the end shows, in the board's words
 *     <button class="odds3d-control" type="button">Pause</button>
 *   </div>
 */
import data from '../media/odds-runs.json';
import stillUrl from '../media/odds-end.webp';
import narrowStillUrl from '../media/odds-end-narrow.webp';
import type { GaltonPass, GaltonPhase, OddsGalton } from '../../odds/galton/odds-galton';
import { percentOf, resultWords } from '../../odds/galton/words';
import { onReducedMotionChange, prefersReducedMotion, watchVisibility } from './motion';
import './odds.css';

const DAY_MS = 86_400_000;

/** Runs landing a second: about the pace the engine makes them on Harbor in the app (a few milliseconds a run). */
export const RUNS_PER_SECOND = 260;
/** The board's answer holds this long before the two boards stand side by side. */
const ANSWER_MS = 2400;
/** The longest the last marbles get to find their falls before the board goes to its answer at once. */
const SETTLE_LIMIT_MS = 8000;
/** Out to the paper before the two boards stand side by side, and back in (the fades are odds.css's). */
const CUT_MS = 240;
/** Shares of the block on screen: the replay starts at the first, waits below the second, carries on at the third. */
const START_AT = 0.4;
const WAIT_BELOW = 0.15;
const GO_ON_AT = 0.35;
/** The board's own titles and notes for its side by side (odds/galton/odds-galton.ts `compare`). */
export const TITLES: [string, string] = ['Wait till Friday', 'Pay today'];
export const NOTES: [string, string] = ['', 'with PayPal'];
/** Below this width there's only the still, and a narrower one, so its words read on a phone. */
const NARROW = '(max-width: 599.98px)';
/**
 * The stills' sizes on the page. Each is the board's own end state, drawn by the board: at this size at 2×, and the
 * phone's in a 384×480 frame at 3×, cropped to 4:3 around the two boards.
 */
const STILL = { width: 1280, height: 720 };
const NARROW_STILL = { width: 384, height: 288 };

type RunsFile = typeof data;

/** One way of paying, as the board is given it. */
export interface OddsChoice {
  /** Run numbers and each run's handover day (days since 1970-01-01), in run order. */
  results: { runs: Int32Array; days: Int32Array };
  onTime: number;
  total: number;
  /** The handover with every length as planned, paid this way. */
  plannedDay: number;
}

export interface OddsRuns {
  contractDay: number;
  /** The handover in the plan as it stands. */
  plannedDay: number;
  /** The days the handover can't fall on: weekends and the plan's holidays. */
  nonWorking: (day: number) => boolean;
  friday: OddsChoice;
  today: OddsChoice;
}

/** "2027-06-11" as the board's day number (days since 1970-01-01, by the date). */
export const dayOfIso = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS;

const weekend = (day: number): boolean => {
  const weekday = (((day + 4) % 7) + 7) % 7;
  return weekday === 0 || weekday === 6;
};

/** The runs file as the board takes it: each run's day back from days after the contract date. */
export function readRuns(file: RunsFile = data): OddsRuns {
  const contractDay = dayOfIso(file.contract);
  const holidays = new Set(file.holidays.map(dayOfIso));
  const choice = (entry: RunsFile['friday']): OddsChoice => {
    const days = Int32Array.from(entry.days, (offset) => contractDay + offset);
    let onTime = 0;
    for (const day of days) if (day <= contractDay) onTime += 1;
    return { results: { runs: Int32Array.from(days, (_, run) => run), days }, onTime, total: days.length, plannedDay: dayOfIso(entry.planned) };
  };
  return {
    contractDay,
    plannedDay: dayOfIso(file.planned),
    nonWorking: (day) => weekend(day) || holidays.has(day),
    friday: choice(file.friday),
    today: choice(file.today),
  };
}

/** How many runs have landed this far into the cascade. */
export const landedBy = (elapsedMs: number, total: number, perSecond = RUNS_PER_SECOND): number => Math.max(0, Math.min(total, Math.floor((elapsedMs * perSecond) / 1000)));

/** What the two boards say at the end, in their own words, for anyone who can't see them. */
export function oddsSummary(runs: OddsRuns): string {
  const line = (index: 0 | 1, choice: OddsChoice) =>
    `${TITLES[index]}${NOTES[index] ? `, ${NOTES[index]}` : ''}: ${resultWords(choice.onTime, choice.total, runs.contractDay)}, ${percentOf(choice.onTime, choice.total)}%.`;
  return `${line(0, runs.friday)} ${line(1, runs.today)}`;
}

/**
 * Whether this browser can draw the board (three.js needs WebGL 2): asked once, when the board is about to load (not
 * on the page's load), its context let go at once. Null until asked.
 */
let canDraw: boolean | null = null;
function webgl2(): boolean {
  if (canDraw === null) {
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      canDraw = Boolean(gl);
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      canDraw = false;
    }
  }
  return canDraw;
}

export function startOdds(root: ParentNode = document): void {
  const host = root.querySelector<HTMLElement>('[data-odds]');
  if (!host) return;
  new OddsSection(host, readRuns()).start();
}

/** Where it is; `data-state` says 'paused' while someone holds it with Pause. */
type State = 'still' | 'loading' | 'ready' | 'playing' | 'done';
/** Why the replay waits: off screen, the tab hidden, or someone pressed Pause. */
type Hold = 'screen' | 'tab' | 'person';

class OddsSection {
  private readonly frame: HTMLDivElement;
  private readonly said: HTMLParagraphElement;
  private readonly control: HTMLButtonElement;
  private readonly narrow = matchMedia(NARROW);
  private state: State = 'still';
  private board: OddsGalton | null = null;
  private boardElement: HTMLElement | null = null;
  private loading: Promise<void> | null = null;
  /** Bumped whenever the board goes or starts over: older work stops at its next step. */
  private generation = 0;
  private shown = 0;
  private readonly holds = new Set<Hold>();
  /** The replay has run to its end. */
  private played = false;
  /** Someone pressed Play or Replay: it moves even under reduced motion, as soon as the board is drawn, for as long as this board lives. */
  private asked = false;
  /** The board failed here (no WebGL, a lost context): the still from now on. */
  private broken = false;
  private waiters: { phase: GaltonPhase; resolve: () => void }[] = [];
  private frameId = 0;
  /** The replay's clock, stopped while anything holds it: starts it again, or ends it early. */
  private resumeClock: (() => void) | null = null;
  private stopClock: (() => void) | null = null;
  private readonly detach: (() => void)[] = [];

  constructor(
    host: HTMLElement,
    private readonly runs: OddsRuns,
  ) {
    this.frame = document.createElement('div');
    this.frame.className = 'odds3d';
    const picture = document.createElement('picture');
    picture.className = 'odds3d-picture';
    const narrow = document.createElement('source');
    narrow.media = NARROW;
    narrow.srcset = narrowStillUrl;
    narrow.setAttribute('width', String(NARROW_STILL.width));
    narrow.setAttribute('height', String(NARROW_STILL.height));
    const still = document.createElement('img');
    still.className = 'odds3d-still';
    // Lazy before its source, and in its picture first, so nothing is fetched early or twice.
    still.loading = 'lazy';
    still.decoding = 'async';
    still.width = STILL.width;
    still.height = STILL.height;
    still.alt = '';
    picture.append(narrow, still);
    still.src = stillUrl;
    this.said = document.createElement('p');
    this.said.className = 'odds3d-said';
    this.said.textContent = oddsSummary(runs);
    this.control = document.createElement('button');
    this.control.type = 'button';
    this.control.className = 'odds3d-control';
    this.control.hidden = true;
    this.control.addEventListener('click', () => this.press());
    this.frame.append(picture, this.said, this.control);
    host.replaceChildren(this.frame);
    this.set('still');
    // Gone with the page, back from the back-forward cache: the board is made again only when it's wanted.
    window.addEventListener('pagehide', () => this.stop());
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) this.start();
    });
    onReducedMotionChange(() => this.reconsider());
  }

  start(): void {
    if (this.detach.length > 0) return;
    this.detach.push(
      watchVisibility(
        this.frame,
        (fraction) => {
          this.shown = fraction;
          if (fraction < WAIT_BELOW) this.hold('screen');
          else if (fraction >= GO_ON_AT) this.release('screen');
          this.maybeStart();
        },
        [0, WAIT_BELOW, GO_ON_AT, START_AT, 0.7],
      ),
    );
    const onTab = () => {
      if (document.hidden) this.hold('tab');
      else this.release('tab');
      this.maybeStart();
    };
    document.addEventListener('visibilitychange', onTab);
    const onWidth = () => this.reconsider();
    this.narrow.addEventListener('change', onWidth);
    this.detach.push(
      () => document.removeEventListener('visibilitychange', onTab),
      () => this.narrow.removeEventListener('change', onWidth),
    );
    onTab();
    this.reconsider();
  }

  /** Everything let go: the board, its worker and canvas, the watches. The still is what's left. */
  private stop(): void {
    this.detach.splice(0).forEach((undo) => undo());
    this.teardown();
  }

  // ---- What it can do here ---------------------------------------------------------------------------------

  /** The still, or the board on its way (loaded when the block nears the screen), as this browser and person allow. */
  private reconsider(): void {
    if (this.narrow.matches || this.broken || canDraw === false) {
      this.teardown();
      return;
    }
    if (prefersReducedMotion() && !this.asked) {
      // The end only, with Play to see it move.
      this.teardown();
      return;
    }
    if (this.board || this.loading) return;
    if (this.played && !this.asked) {
      this.set('still');
      return;
    }
    this.loadWhenNear();
  }

  private nearWatch: IntersectionObserver | null = null;

  private loadWhenNear(): void {
    if (this.nearWatch) return;
    if (typeof IntersectionObserver === 'undefined') {
      void this.load();
      return;
    }
    this.nearWatch = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        this.nearWatch?.disconnect();
        this.nearWatch = null;
        void this.load();
      },
      { rootMargin: '100% 0px' },
    );
    this.nearWatch.observe(this.frame);
  }

  private load(): Promise<void> {
    if (!webgl2()) {
      this.broken = true;
      this.teardown();
      return Promise.resolve();
    }
    this.loading ??= this.create().catch((error: unknown) => {
      console.error('The odds board could not be shown here:', error);
      this.broken = true;
      this.teardown();
    });
    return this.loading;
  }

  /** three.js, the board and (once it begins) its physics worker; the board begins at once, empty, warming up. */
  private async create(): Promise<void> {
    const generation = this.generation;
    this.set('loading');
    const { createOddsGalton } = await import('../../odds/galton/odds-galton');
    if (generation !== this.generation) return;
    const element = document.createElement('div');
    element.className = 'odds3d-board';
    element.setAttribute('aria-hidden', 'true');
    this.frame.insertBefore(element, this.said);
    this.boardElement = element;
    const board = createOddsGalton(element, { size: 'hero', reducedMotion: false, onPhase: (phase) => this.onPhase(phase) });
    this.board = board;
    element.querySelector('canvas')?.addEventListener('webglcontextlost', () => {
      this.broken = true;
      this.teardown();
    });
    board.begin(this.pass());
  }

  private pass(): GaltonPass {
    const { contractDay, nonWorking, friday } = this.runs;
    return { fresh: true, total: friday.total, contractDay, plannedDay: friday.plannedDay, nonWorking };
  }

  /** Back to the still: the board, its worker and canvas let go, and anything on its way stopped. */
  private teardown(): void {
    this.generation += 1;
    this.endClock();
    this.waiters = [];
    this.nearWatch?.disconnect();
    this.nearWatch = null;
    this.loading = null;
    this.board?.dispose();
    this.board = null;
    this.boardElement?.remove();
    this.boardElement = null;
    this.holds.delete('person');
    this.asked = false;
    this.frame.removeAttribute('data-live');
    this.set('still');
  }

  // ---- The board's phases -----------------------------------------------------------------------------------

  private onPhase(phase: GaltonPhase): void {
    const ready = this.waiters.filter((waiter) => waiter.phase === phase);
    this.waiters = this.waiters.filter((waiter) => waiter.phase !== phase);
    ready.forEach((waiter) => waiter.resolve());
    // The empty board is drawn: it takes the still's place, and pours once it's well on screen.
    if (phase === 'board' && this.state === 'loading') {
      this.frame.setAttribute('data-live', '');
      this.set('ready');
      this.maybeStart();
    }
  }

  /** Resolves when the board next shows `phase`. */
  private phase(phase: GaltonPhase): Promise<void> {
    return new Promise((resolve) => this.waiters.push({ phase, resolve }));
  }

  // ---- The replay -------------------------------------------------------------------------------------------

  private maybeStart(): void {
    if (this.state !== 'ready') return;
    if (this.asked || (this.shown >= START_AT && !document.hidden)) void this.replay();
  }

  /** The cascade (Friday's pay run, run by run), the board's answer, then the two boards side by side. */
  private async replay(): Promise<void> {
    const board = this.board;
    if (!board) return;
    const generation = this.generation;
    const live = () => generation === this.generation && this.board === board;
    this.set('playing');
    await board.whenReady();
    if (!live()) return;
    const { friday, today } = this.runs;
    const { runs, days } = friday.results;
    const element = this.boardElement;
    if (!element) return;
    let landed = 0;
    const poured = await this.elapse((ms) => {
      const upTo = landedBy(ms, runs.length);
      if (upTo > landed) {
        const batch: { run: number; day: number }[] = [];
        for (let i = landed; i < upTo; i += 1) batch.push({ run: runs[i]!, day: days[i]! });
        board.land(batch);
        landed = upTo;
      }
      return landed >= runs.length;
    });
    if (!poured || !live()) return;
    const answered = this.phase('result');
    board.settle(Array.from(runs));
    if (!(await this.within(answered, SETTLE_LIMIT_MS))) {
      if (!live()) return;
      // A marble still looking for its fall: the board's poster frame, every marble in its place at once.
      board.jumpTo('result');
      await this.within(answered, 1500);
    }
    if (!live() || !(await this.elapse((ms) => ms >= ANSWER_MS)) || !live()) return;
    // Out to the paper, and back with the same runs paid today beside them.
    element.classList.add('is-cut');
    if (!(await this.elapse((ms) => ms >= CUT_MS)) || !live()) return;
    const compared = this.phase('compare');
    board.compare(friday.results, today.results, TITLES, NOTES);
    await this.within(compared, 600);
    element.classList.remove('is-cut');
    if (!live()) return;
    this.played = true;
    this.holds.delete('person');
    this.set('done');
  }

  /**
   * Calls `step` every frame with the time since it began, counting only time nothing holds it, until it returns
   * true. Resolves true then, or false when the board went first.
   */
  private elapse(step: (ms: number) => boolean): Promise<boolean> {
    this.endClock();
    const generation = this.generation;
    return new Promise((resolve) => {
      let ms = 0;
      let last: number | null = null;
      const finish = (value: boolean) => {
        this.resumeClock = null;
        this.stopClock = null;
        resolve(value);
      };
      const frame = (now: number) => {
        this.frameId = 0;
        if (generation !== this.generation) return finish(false);
        if (this.holds.size > 0) {
          last = null;
          this.resumeClock = () => {
            this.resumeClock = null;
            this.frameId = requestAnimationFrame(frame);
          };
          return;
        }
        // A long gap (the tab came back) counts as one frame, so nothing jumps.
        if (last !== null) ms += Math.min(100, now - last);
        last = now;
        if (step(ms)) return finish(true);
        this.frameId = requestAnimationFrame(frame);
      };
      this.stopClock = () => finish(false);
      this.frameId = requestAnimationFrame(frame);
    });
  }

  /** Whether `promise` settles within `limitMs` of the replay's time. */
  private async within(promise: Promise<unknown>, limitMs: number): Promise<boolean> {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    await this.elapse((ms) => done || ms >= limitMs);
    return done;
  }

  private endClock(): void {
    cancelAnimationFrame(this.frameId);
    this.frameId = 0;
    this.resumeClock = null;
    this.stopClock?.();
  }

  private hold(reason: Hold): void {
    this.holds.add(reason);
    if (reason === 'person') this.render();
  }

  private release(reason: Hold): void {
    if (!this.holds.delete(reason)) return;
    if (reason === 'person') this.render();
    if (this.holds.size === 0) this.resumeClock?.();
  }

  // ---- The button -------------------------------------------------------------------------------------------

  private press(): void {
    if (this.state === 'done') this.again();
    else if (this.state === 'still') {
      this.asked = true;
      this.reconsider();
    } else if (this.holds.has('person')) this.release('person');
    else this.hold('person');
  }

  /** Replay: the same board empties and the runs pour again. */
  private again(): void {
    const board = this.board;
    if (!board) return;
    this.generation += 1;
    this.endClock();
    this.waiters = [];
    this.holds.delete('person');
    this.boardElement?.classList.remove('is-cut');
    this.asked = true;
    this.set('loading');
    board.begin(this.pass());
  }

  private set(state: State): void {
    this.state = state;
    this.render();
  }

  /**
   * The state on the block, and the button for it: Pause and Play while it moves (or is on its way after a press, so
   * the button keeps its focus), Replay at the end; on the still, Play under reduced motion and Replay after the board
   * was let go, where the board can be drawn.
   */
  private render(): void {
    const paused = this.holds.has('person');
    const moving = this.state === 'playing' || ((this.state === 'loading' || this.state === 'ready') && this.asked);
    this.frame.dataset.state = moving && paused ? 'paused' : this.state;
    let label: [text: string, name: string] | null = null;
    if (moving) label = paused ? ['Play', 'Play the runs'] : ['Pause', 'Pause the runs'];
    else if (this.state === 'done') label = ['Replay', 'Play the runs again'];
    else if (this.state === 'still' && !this.narrow.matches && !this.broken && canDraw !== false && (this.played || prefersReducedMotion())) {
      label = this.played ? ['Replay', 'Play the runs again'] : ['Play', 'Play the runs'];
    }
    this.control.hidden = label === null;
    if (label) {
      this.control.textContent = label[0];
      this.control.setAttribute('aria-label', label[1]);
    }
  }
}
