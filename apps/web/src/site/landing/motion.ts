/**
 * What the landing page's scenes share: whether to move at all, when something is on screen, the site's spring as
 * an easing for the Web Animations API, and a timeline of timed steps that can be paused and played again.
 */

const reduceQuery = typeof window !== 'undefined' && 'matchMedia' in window ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

/** True when the visitor asked for less motion: scenes show their last frame and nothing plays by itself. */
export function prefersReducedMotion(): boolean {
  return reduceQuery?.matches ?? false;
}

/** Calls back when the preference changes. */
export function onReducedMotionChange(callback: (reduce: boolean) => void): void {
  reduceQuery?.addEventListener('change', (event) => callback(event.matches));
}

/** Watches how much of an element is on screen; the callback gets the visible fraction (0 to 1). */
export function watchVisibility(element: Element, callback: (fraction: number) => void, thresholds: number[] = [0, 0.25, 0.5, 0.75, 1]): () => void {
  if (!('IntersectionObserver' in window)) {
    callback(1);
    return () => {};
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) callback(entry.isIntersecting ? entry.intersectionRatio : 0);
  }, { threshold: thresholds });
  observer.observe(element);
  return () => observer.disconnect();
}

export type Step = readonly [at: number, run: () => void];

/**
 * Steps at set times (ms from the start). Pausing stops the clock and the CSS transitions and animations running
 * under `root`; playing again picks up where it stopped.
 */
export class Timeline {
  private index = 0;
  private elapsed = 0;
  private startedAt = 0;
  private timer: number | undefined;
  private held: Animation[] = [];
  private running = false;

  constructor(
    private readonly steps: readonly Step[],
    private readonly root: Element,
    private readonly onEnd?: () => void,
  ) {}

  get playing(): boolean {
    return this.running;
  }

  get finished(): boolean {
    return this.index >= this.steps.length;
  }

  play(): void {
    if (this.running || this.finished) return;
    this.running = true;
    this.startedAt = performance.now() - this.elapsed;
    for (const animation of this.held) animation.play();
    this.held = [];
    this.next();
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.elapsed = performance.now() - this.startedAt;
    window.clearTimeout(this.timer);
    this.held = this.root.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running');
    for (const animation of this.held) animation.pause();
  }

  /** Back to the start, stopped. */
  rewind(): void {
    this.pause();
    for (const animation of this.held) animation.play();
    this.held = [];
    this.index = 0;
    this.elapsed = 0;
  }

  private next(): void {
    const step = this.steps[this.index];
    if (!step) {
      this.running = false;
      this.onEnd?.();
      return;
    }
    const wait = Math.max(0, step[0] - (performance.now() - this.startedAt));
    this.timer = window.setTimeout(() => {
      if (!this.running) return;
      this.index += 1;
      step[1]();
      this.next();
    }, wait);
  }
}
