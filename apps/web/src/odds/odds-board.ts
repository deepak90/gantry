/**
 * The odds panel's board: the 3D Galton board (odds/galton/odds-galton.ts, loaded the first time the panel opens)
 * as one of the panel's two views of the runs, beside the dot plot. The controller tells it everything it tells the
 * dot plot, through `sink` (the board's own `galtonSink` once it is loaded; calls that come before are kept and
 * handed over), so switching views is instant. `sink.ready` lets a pass's runs wait for the board's physics while the
 * board is on screen, so the first marbles leave the hopper as their runs land instead of pouring out together; with
 * the dots on screen it holds nothing up.
 *
 * The board can leave the panel and fill the chart's side at hero size (its big number and its words beside the
 * piles): the panel's button or `oddsBoard.setHero(true)`. Two boards side by side
 * ("Wait till Friday" against "Pay today") take over the whole of the plan's area while they show, the task grid and
 * the odds panel too, and leave everything as it was when they go. A quiet button beside their close button stacks
 * the runs as a building (the left board, then the right) and puts the piles back. The film walkthrough drives it
 * through `oddsBoard` (documented at the top of odds/OddsPanel.tsx).
 *
 * One board per odds controller, kept for a while after the panel closes (and through React's double mount in
 * development), so opening the panel again finds the physics warm.
 */
import type { GaltonPhase, OddsGalton, galtonSink } from './galton/odds-galton';
import type { PlotPass } from './dot-plot';
import type { OddsController, PlotSink } from './odds-controller';

export type OddsView = 'board' | 'dots';

/** Where the hero board goes: the chart's frame (laid over, from the chart's side to its right edge). */
export interface ChartSide {
  /** Positioned; the board is laid over it. */
  frame: HTMLElement;
  /** The chart's side of the Gantt (its left edge is the board's); the whole frame when null. */
  side: HTMLElement | null;
}

export interface BoardViewState {
  /** The board couldn't be made in this browser (no WebGL): the panel shows the dots. */
  failed: boolean;
  /** Over the chart's side, at hero size. */
  hero: boolean;
}

type Sink = ReturnType<typeof galtonSink>;
type Call =
  | { type: 'begin'; pass: PlotPass }
  | { type: 'land'; landed: readonly { run: number; day: number }[] }
  | { type: 'end'; runs: readonly number[] }
  | { type: 'show'; runs: ArrayLike<number>; days: ArrayLike<number>; instant: boolean };

/** The film's words, short enough for one line over each board; PayPal is named on the line under the second. */
const WAIT_TITLE = 'Wait till Friday';
/** The second board's title: `setPayTitle` names the day. */
let payTitle = 'Pay when due';
const NOTES: [string, string] = ['', 'with PayPal'];
/** How long a board is kept after the panel closes. */
const KEEP_MS = 90_000;

const phaseListeners = new Set<(phase: GaltonPhase, at: number) => void>();
/** Hero or not, for every board from now on: whatever was chosen last. */
let heroWanted = false;
/** The view the panel opens on: the board, unless the dots were chosen since the page loaded. */
let viewWanted: OddsView = 'board';

export const preferredView = (): OddsView => viewWanted;
export const rememberView = (view: OddsView): void => {
  viewWanted = view;
};

export class BoardView {
  /** The board's element: in the panel's slot, or in the frame over the chart. */
  readonly host: HTMLDivElement;
  readonly sink: PlotSink;
  phase: GaltonPhase | null = null;
  private board: OddsGalton | null = null;
  private target: Sink | null = null;
  private readonly created: Promise<OddsGalton | null>;
  /** What the controller said before the board was loaded, since its last `begin`. */
  private calls: Call[] = [];
  private begun = false;
  private beginWaiters: (() => void)[] = [];
  /** The panel shows the board (not the dots). */
  private inPanel = true;
  private comparing = false;
  private slot: HTMLElement | null = null;
  private heroFrame: HTMLElement | null = null;
  private heroWatch: ResizeObserver | null = null;
  /** Over the whole of the plan's area while two boards stand side by side. */
  private takeover: HTMLElement | null = null;
  /** The side by side's quiet switch between piles and towers. */
  private stackButton: HTMLButtonElement | null = null;
  private disposed = false;
  private state: BoardViewState;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly controller: OddsController,
    public chartSide: () => ChartSide | null,
  ) {
    this.state = { failed: false, hero: false };
    this.host = document.createElement('div');
    this.host.className = 'odds-board';
    this.sink = {
      begin: (pass) => this.call({ type: 'begin', pass }),
      land: (landed) => this.call({ type: 'land', landed }),
      end: (runs) => this.call({ type: 'end', runs }),
      show: (runs, days, instant) => this.call({ type: 'show', runs, days, instant: instant ?? false }),
      ready: () => this.ready(),
    };
    this.created = this.create();
  }

  // -------------------------------------------------------------------------------------------
  // For the panel
  // -------------------------------------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): BoardViewState => this.state;

  /** Whether the panel shows the board rather than the dots. The runs wait for the board only while it is on screen. */
  setShown(inPanel: boolean): void {
    this.inPanel = inPanel;
  }

  private get shown(): boolean {
    return this.inPanel || this.state.hero;
  }

  /** The panel's slot for the board: it goes there, or over the chart when that is wanted. */
  mount(slot: HTMLElement): void {
    this.slot = slot;
    if (heroWanted && this.placeHero()) this.set({ hero: true });
    else slot.append(this.host);
  }

  /** The panel closed: the board leaves the page (and the chart), and is kept a while. */
  unmount(slot: HTMLElement): void {
    if (this.slot === slot) this.slot = null;
    this.takeover?.remove();
    this.host.remove();
    this.liftHero();
    if (this.state.hero) this.set({ hero: false });
  }

  /** Over the chart's side at hero size, or back in the panel. Boards opened later follow the last choice. */
  setHero(on: boolean): void {
    heroWanted = on;
    // Two boards side by side go back to one first, where they were.
    if (this.comparing) this.single();
    if (on === this.state.hero || !this.slot) return;
    if (on) {
      // Nowhere to lay it (no chart on screen): it stays in the panel.
      if (!this.placeHero()) return;
    } else {
      this.liftHero();
      this.slot.append(this.host);
      this.board?.setSize('panel');
    }
    this.set({ hero: on });
  }

  // -------------------------------------------------------------------------------------------
  // For the film (oddsBoard)
  // -------------------------------------------------------------------------------------------

  /** The board loaded, a pass begun on it, and its physics ready to pour (at most 1.5 s after that). */
  async whenReady(): Promise<void> {
    const board = await this.created;
    if (!board || this.disposed) return;
    if (!this.begun) await new Promise<void>((resolve) => this.beginWaiters.push(resolve));
    if (!this.disposed) await board.whenReady();
  }

  jumpTo(state: 'result' | 'stacked'): void {
    this.board?.jumpTo(state);
  }

  /**
   * The runs on the side by side stacked as a building (odds/galton/tower.ts): `which` board ('wait', the left one, or
   * 'pay', the right), or both, the left first. Resolves true once the tower stands; false when two boards aren't
   * side by side.
   */
  async stack(which?: 'wait' | 'pay', options: { instant?: boolean } = {}): Promise<boolean> {
    if (!this.board || !this.comparing) return false;
    const standing = this.board.stack(which === 'wait' ? 'left' : which === 'pay' ? 'right' : undefined, options);
    this.syncStack();
    await standing;
    return true;
  }

  /** The towers back into piles. */
  unstack(options: { instant?: boolean } = {}): void {
    this.board?.unstack(undefined, options);
    this.syncStack();
  }

  /** Whether a tower stands, or is going up, on the board. */
  get stacked(): boolean {
    return this.board?.isStacked() ?? false;
  }

  /**
   * "Wait till Friday" against "Pay today" (with PayPal), from the panel's own runs; false when it has no such pair
   * yet. They take over the whole of the plan's area (the task grid, the chart and this panel) unless `takeover` is
   * false, and stay in place otherwise.
   */
  compare(options: { takeover?: boolean } = {}): boolean {
    const pair = this.controller.comparison();
    if (!this.board || !pair) return false;
    if (options.takeover ?? true) this.takeOver();
    else this.giveBack();
    this.board.compare(pair.wait, pair.pay, [WAIT_TITLE, payTitle], NOTES);
    this.comparing = true;
    return true;
  }

  /** Back to one board, where it was before the side by side, with everything around it as it was. */
  single(): void {
    this.board?.single();
    this.comparing = false;
    this.giveBack();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.takeover?.remove();
    this.liftHero();
    this.host.remove();
    this.board?.dispose();
    this.board = null;
    this.target = null;
    this.beginWaiters.splice(0).forEach((resolve) => resolve());
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------------------------
  // The board
  // -------------------------------------------------------------------------------------------

  private set(patch: Partial<BoardViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private async create(): Promise<OddsGalton | null> {
    try {
      const { createOddsGalton, galtonSink } = await import('./galton/odds-galton');
      if (this.disposed) return null;
      const board = createOddsGalton(this.host, {
        size: this.state.hero ? 'hero' : 'panel',
        onPhase: (phase, at) => {
          this.phase = phase;
          this.syncStack();
          for (const listener of [...phaseListeners]) listener(phase, at);
        },
      });
      this.board = board;
      this.target = galtonSink(board);
      for (const call of this.calls.splice(0)) this.forward(call);
      return board;
    } catch (error) {
      console.error('The odds board could not be shown here:', error);
      this.calls = [];
      this.set({ failed: true });
      return null;
    }
  }

  private call(call: Call): void {
    if (this.disposed || this.state.failed) return;
    if (this.target) {
      this.forward(call);
      return;
    }
    if (call.type === 'begin') this.calls = [];
    this.calls.push(call);
  }

  private forward(call: Call): void {
    const target = this.target!;
    switch (call.type) {
      case 'begin':
        // A new pass takes the board back from the side by side (the board does that itself), to where it was.
        if (this.comparing) {
          this.comparing = false;
          this.giveBack();
        }
        target.begin(call.pass);
        this.begun = true;
        this.beginWaiters.splice(0).forEach((resolve) => resolve());
        break;
      case 'land':
        target.land(call.landed);
        break;
      case 'end':
        target.end(call.runs);
        break;
      case 'show':
        if (this.comparing) this.single();
        target.show(call.runs, call.days, call.instant);
        break;
    }
  }

  private async ready(): Promise<void> {
    if (!this.shown || this.state.failed) return;
    const board = await this.created;
    if (board && this.shown && !this.disposed) await board.whenReady();
  }

  // -------------------------------------------------------------------------------------------
  // Over the chart's side
  // -------------------------------------------------------------------------------------------

  /** Lays the board over the chart's side; false when there is no chart to lay it over. */
  private placeHero(): boolean {
    const side = this.chartSide();
    if (!side) return false;
    if (!this.heroFrame) {
      const frame = document.createElement('div');
      frame.className = 'odds-hero';
      frame.dataset.testid = 'odds-hero';
      frame.setAttribute('role', 'region');
      frame.setAttribute('aria-label', 'The odds, over the chart');
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'button is-quiet is-sm is-icon odds-hero-back';
      back.title = 'Back to the panel';
      back.setAttribute('aria-label', 'Put the board back in the odds panel');
      back.innerHTML = '<i class="fa fa-down-left-and-up-right-to-center" aria-hidden="true"></i>';
      back.addEventListener('click', () => this.setHero(false));
      frame.append(back);
      this.heroFrame = frame;
    }
    side.frame.append(this.heroFrame);
    this.heroFrame.prepend(this.host);
    this.fitHero();
    this.heroWatch?.disconnect();
    this.heroWatch = new ResizeObserver(() => this.fitHero());
    this.heroWatch.observe(side.frame);
    if (side.side) this.heroWatch.observe(side.side);
    this.board?.setSize('hero');
    return true;
  }

  /** From the chart side's left edge to the frame's right: the grid's columns stay in view. */
  private fitHero(): void {
    const side = this.chartSide();
    if (!side || !this.heroFrame) return;
    const left = side.side ? Math.max(0, Math.round(side.side.getBoundingClientRect().left - side.frame.getBoundingClientRect().left)) : 0;
    this.heroFrame.style.left = `${left}px`;
  }

  private liftHero(): void {
    this.heroWatch?.disconnect();
    this.heroWatch = null;
    this.heroFrame?.remove();
  }

  // -------------------------------------------------------------------------------------------
  // Over the whole of the plan's area, while two boards stand side by side
  // -------------------------------------------------------------------------------------------

  /** The plan's area (the chart and the odds panel), covered by the side by side; false when it isn't on screen. */
  private takeOver(): boolean {
    const area = this.chartSide()?.frame.closest<HTMLElement>('.collab-gantt-body') ?? null;
    if (!area) return false;
    if (!this.takeover) {
      const cover = document.createElement('div');
      cover.className = 'odds-takeover';
      cover.dataset.testid = 'odds-takeover';
      cover.setAttribute('role', 'region');
      cover.setAttribute('aria-label', 'The odds, side by side');
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'button is-quiet is-sm is-icon odds-takeover-back';
      back.title = 'Back to one board';
      back.setAttribute('aria-label', 'Back to one board');
      back.innerHTML = '<i class="fa fa-xmark" aria-hidden="true"></i>';
      back.addEventListener('click', () => this.single());
      // Piles or towers: the runs stacked as a building, a tenth of them to a floor, the deadline a floor line.
      const stack = document.createElement('button');
      stack.type = 'button';
      stack.className = 'button is-quiet is-sm is-icon odds-takeover-stack';
      stack.dataset.testid = 'odds-stack';
      stack.setAttribute('aria-label', 'Stack the runs like a building');
      stack.addEventListener('click', () => {
        if (this.stacked) this.unstack();
        else void this.stack();
      });
      cover.append(stack, back);
      this.takeover = cover;
      this.stackButton = stack;
      this.syncStack();
    }
    if (this.takeover.parentElement !== area) area.append(this.takeover);
    this.takeover.prepend(this.host);
    return true;
  }

  /** The switch says what it does next: stack the runs, or put the piles back. */
  private syncStack(): void {
    const button = this.stackButton;
    if (!button) return;
    const stacked = this.stacked;
    button.setAttribute('aria-pressed', String(stacked));
    button.title = stacked ? 'Back to the piles' : 'Stack the runs like a building';
    button.innerHTML = `<i class="fa ${stacked ? 'fa-chart-column' : 'fa-building'}" aria-hidden="true"></i>`;
  }

  /** The board goes back where it was (over the chart's side, or in the panel), and the plan's area is uncovered. */
  private giveBack(): void {
    if (!this.takeover) return;
    if (this.host.parentElement === this.takeover) {
      if (this.state.hero && this.heroFrame?.isConnected) this.heroFrame.prepend(this.host);
      else if (this.slot) this.slot.append(this.host);
      else this.host.remove();
    }
    this.takeover.remove();
  }
}

// ---------------------------------------------------------------------------------------------
// One board per controller
// ---------------------------------------------------------------------------------------------

let held: { view: BoardView; users: number; timer?: ReturnType<typeof setTimeout> } | null = null;
const viewWaiters: (() => void)[] = [];

/** The board for this controller's panel: the one kept from before, or a new one. */
export function acquireBoardView(controller: OddsController, chartSide: () => ChartSide | null): BoardView {
  if (held && held.view.controller !== controller) {
    clearTimeout(held.timer);
    held.view.dispose();
    held = null;
  }
  held ??= { view: new BoardView(controller, chartSide), users: 0 };
  clearTimeout(held.timer);
  held.users += 1;
  held.view.chartSide = chartSide;
  viewWaiters.splice(0).forEach((resolve) => resolve());
  return held.view;
}

/** The panel let it go: it is kept for KEEP_MS in case the panel opens again. */
export function releaseBoardView(view: BoardView): void {
  if (!held || held.view !== view) return;
  const mine = held;
  mine.users = Math.max(0, mine.users - 1);
  if (mine.users > 0) return;
  mine.timer = setTimeout(() => {
    if (held !== mine || mine.users > 0) return;
    mine.view.dispose();
    held = null;
  }, KEEP_MS);
}

const shownView = (): BoardView | null => (held && held.users > 0 ? held.view : null);

/**
 * The board for the film walkthrough and scripted takes (see the top of odds/OddsPanel.tsx). Everything works on the
 * board in the open odds panel; with the panel closed, `whenReady` waits for it and the rest do nothing.
 */
export const oddsBoard = {
  /** Names the second board of the side by side ("Pay by Tuesday"). */
  setPayTitle(title: string): void {
    payTitle = title;
  },
  /**
   * The phase last on screen: 'board', 'cascade', 'poured', 'settled', 'result', 'drain', 'drained', 'compare',
   * 'stacking' or 'stacked'.
   */
  get phase(): GaltonPhase | null {
    return shownView()?.phase ?? null;
  },
  get hero(): boolean {
    return shownView()?.getState().hero ?? heroWanted;
  },
  /** The board fills the chart's side at hero size (true), or goes back into the panel; boards opened later follow. */
  setHero(on: boolean): void {
    heroWanted = on;
    shownView()?.setHero(on);
  },
  /** Resolves once the panel is open, its board loaded and a pass begun on it, and the physics is ready to pour. */
  async whenReady(): Promise<void> {
    while (!shownView()) await new Promise<void>((resolve) => viewWaiters.push(resolve));
    await shownView()?.whenReady();
  },
  /** Each phase as it is first on screen (`at` is that frame's performance.now()); returns a function that stops it. */
  onPhase(listener: (phase: GaltonPhase, at: number) => void): () => void {
    phaseListeners.add(listener);
    return () => phaseListeners.delete(listener);
  },
  /**
   * 'result': the poster frame from any state (every marble in its place in the piles, the big number and its words);
   * 'stacked': every tower on its way up standing at once.
   */
  jumpTo(state: 'result' | 'stacked'): void {
    shownView()?.jumpTo(state);
  },
  /**
   * Two boards side by side, "Wait till Friday" and "Pay today" (with PayPal), from the panel's own runs, over the
   * whole of the plan's area (`{ takeover: false }` keeps them where the board is). False when there is no pair yet.
   */
  compare(options?: { takeover?: boolean }): boolean {
    return shownView()?.compare(options) ?? false;
  },
  /** Back to one board, with the latest answer, where it was: everything around it as before the side by side. */
  single(): void {
    shownView()?.single();
  },
  /**
   * The side by side's runs stacked as a building: 'wait' (the left board), 'pay' (the right), or both (the left first,
   * the right a moment later). The marbles lift out of the bins, earliest handover first, into ten floors of a tenth
   * of the runs each, the deadline a floor line; on the right the band between the two boards' lines (the runs that
   * make it only by paying today) is lit and counted. Resolves true once standing; false without two boards.
   */
  stack(which?: 'wait' | 'pay', options?: { instant?: boolean }): Promise<boolean> {
    return shownView()?.stack(which, options) ?? Promise.resolve(false);
  },
  /** The towers back into piles. */
  unstack(options?: { instant?: boolean }): void {
    shownView()?.unstack(options);
  },
  /** Whether a tower stands, or is going up, on the board. */
  get stacked(): boolean {
    return shownView()?.stacked ?? false;
  },
};

