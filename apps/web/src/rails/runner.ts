/**
 * Runs the walkthrough: one step per press of Next, each through the real interface.
 *
 * - Next runs the following step. While a step runs, Next does nothing. After a step fails, Next puts
 *   the project back as it was before that step and tries it again.
 * - Previous stops a running step, puts the project back as it was before the step on the counter, and
 *   shows the one before as done. Pressing Next then runs the same step again.
 * - Start over goes back to before the first step.
 *
 * Putting the project back is the host's job (`restore`); where it can't, these only move the counter.
 */
import type { RailContext, RailStep } from './types';
import { isStopped } from './wait';

export type RailStatus = 'ready' | 'running' | 'done' | 'failed';

export interface RailState {
  /** The step on the counter: -1 before the first. */
  index: number;
  status: RailStatus;
  /** What went wrong, when a step failed. */
  error: string | null;
}

export interface RailHost {
  makeContext(signal: AbortSignal): RailContext;
  /** Puts the project back as it was before step `index` (0 is the very start). */
  restore?(index: number): Promise<void>;
  /** Step `index` is done: keep what it left, so `restore(index + 1)` can come back to it. */
  checkpoint?(index: number): void | Promise<void>;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class RailRunner {
  private current: RailState = { index: -1, status: 'ready', error: null };
  private readonly listeners = new Set<(state: RailState) => void>();
  private controller: AbortController | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** Bumped by Previous and Start over, so work queued before them is dropped. */
  private generation = 0;

  constructor(
    readonly steps: readonly RailStep[],
    private readonly host: RailHost,
  ) {}

  get state(): RailState {
    return this.current;
  }

  /**
   * For checking a later step by hand on the dev server: the counter stands just before `index`, so the next press runs
   * it. Only from the very start.
   */
  startAt(index: number): void {
    if (this.current.index !== -1 || this.current.status !== 'ready') return;
    this.set({ index: Math.max(-1, Math.min(this.steps.length - 1, index - 1)), status: 'done', error: null });
  }

  /** The step on the counter, if any. */
  get step(): RailStep | null {
    return this.steps[this.current.index] ?? null;
  }

  subscribe(listener: (state: RailState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(change: Partial<RailState>): void {
    this.current = { ...this.current, ...change };
    for (const listener of this.listeners) listener(this.current);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const queued = this.chain.then(work, work);
    this.chain = queued.catch(() => undefined);
    return queued;
  }

  /** Runs the next step, or tries the current one again after it failed. */
  next(): Promise<void> {
    const { index, status } = this.current;
    if (status === 'running') return this.chain;
    const retry = status === 'failed';
    const target = retry ? index : index + 1;
    if (target >= this.steps.length) return this.chain;
    // Claimed at once, so a second press before it starts does nothing.
    this.set({ index: target, status: 'running', error: null });
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation) return;
      if (retry) await this.host.restore?.(target);
      await this.run(target, generation);
    });
  }

  /** Back one step: stops the running one and puts the project back as it was before it. */
  previous(): Promise<void> {
    const { index } = this.current;
    if (index < 0) return this.chain;
    const generation = ++this.generation;
    this.controller?.abort();
    this.set({ status: 'running', error: null });
    return this.enqueue(async () => {
      if (generation !== this.generation) return;
      await this.host.restore?.(index);
      if (generation !== this.generation) return;
      this.set(index === 0 ? { index: -1, status: 'ready', error: null } : { index: index - 1, status: 'done', error: null });
    });
  }

  /** Back to before the first step. */
  startOver(): Promise<void> {
    const generation = ++this.generation;
    this.controller?.abort();
    this.set({ status: 'running', error: null });
    return this.enqueue(async () => {
      if (generation !== this.generation) return;
      await this.host.restore?.(0);
      if (generation !== this.generation) return;
      this.set({ index: -1, status: 'ready', error: null });
    });
  }

  /** After a step failed: leave it as it is and stand after it, so the next press runs the step after. */
  skip(): void {
    if (this.current.status !== 'failed') return;
    this.set({ status: 'done', error: null });
  }

  /** Stops whatever runs, for good. */
  dispose(): void {
    this.generation += 1;
    this.controller?.abort();
    this.listeners.clear();
  }

  private async run(index: number, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const step = this.steps[index]!;
    const controller = new AbortController();
    this.controller = controller;
    this.set({ index, status: 'running', error: null });
    try {
      const context = this.host.makeContext(controller.signal);
      await step.prepare?.(context);
      await step.run(context);
      if (controller.signal.aborted) return;
      await this.host.checkpoint?.(index);
      this.set({ status: 'done' });
    } catch (error) {
      if (controller.signal.aborted || isStopped(error)) return;
      console.error(`Walkthrough step "${step.key}" failed`, error);
      this.set({ status: 'failed', error: messageOf(error) });
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
