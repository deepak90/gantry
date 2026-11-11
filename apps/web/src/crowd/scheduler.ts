/**
 * When simulated people act. Each person makes a change every 10 to 15 seconds (jittered), the people
 * staggered so their changes spread out instead of landing together; between changes they look around
 * (scroll, read, select rows). Who is working on which task is claimed here, so two simulated people
 * never take the same task; real people are seen through presence by the person deciding.
 */
import type { Clock } from '../presence/clock';
import type { Random } from './random';

/** One task, one person at a time. */
export class TaskClaims {
  private readonly holders = new Map<number, string>();

  /** True when `who` holds it now (it was free, or theirs already). */
  claim(taskId: number, who: string): boolean {
    const holder = this.holders.get(taskId);
    if (holder !== undefined && holder !== who) return false;
    this.holders.set(taskId, who);
    return true;
  }

  release(taskId: number, who: string): void {
    if (this.holders.get(taskId) === who) this.holders.delete(taskId);
  }

  releaseAll(who: string): void {
    for (const [taskId, holder] of [...this.holders]) if (holder === who) this.holders.delete(taskId);
  }

  holder(taskId: number): string | undefined {
    return this.holders.get(taskId);
  }
}

/** What the scheduler drives: a person who can look around until a moment and take a turn. */
export interface Actor {
  readonly id: string;
  /** Looks around (no changes) until about `until`; may return a little early or late. */
  idleUntil(until: number): Promise<void>;
  /** Makes one change, with the moves that lead up to it (or just looks around when nothing fits). */
  turn(): Promise<void>;
}

export interface CadenceOptions {
  clock: Clock;
  random: Random;
  /** Time between the starts of one person's changes (ms). */
  cadenceMs?: { min: number; max: number };
  /** Least time between a turn ending and the next one starting. */
  restMs?: number;
  onError?(actor: Actor, error: unknown): void;
  onTurn?(actor: Actor, at: number): void;
}

const sleep = (clock: Clock, ms: number) => new Promise<void>((resolve) => clock.setTimeout(resolve, Math.max(0, ms)));

export class CrowdScheduler {
  private running = false;
  private readonly loops = new Map<string, Promise<void>>();
  /** The actor behind each loop (replaced when a person's session is rebuilt). */
  private readonly actors = new Map<string, Actor>();
  private readonly cadence: { min: number; max: number };

  constructor(private readonly options: CadenceOptions) {
    this.cadence = options.cadenceMs ?? { min: 10_000, max: 15_000 };
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Starts everyone; person `i` of `n` takes their first turn about `i / n` of a cadence in. */
  start(actors: readonly Actor[]): void {
    if (this.running) return;
    this.running = true;
    const mean = (this.cadence.min + this.cadence.max) / 2;
    actors.forEach((actor, index) => {
      const first = 1_500 + (mean * index) / Math.max(1, actors.length) + this.options.random.range(0, 1_200);
      this.actors.set(actor.id, actor);
      this.loops.set(actor.id, this.loop(actor.id, first));
    });
  }

  /** Puts a new actor behind an existing loop (same id), from its next step on. */
  replace(actor: Actor): void {
    if (this.actors.has(actor.id)) this.actors.set(actor.id, actor);
  }

  /** Stops after the turns in progress; resolves when every loop has ended. */
  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.loops.values());
    this.loops.clear();
    this.actors.clear();
  }

  private async loop(id: string, firstDelay: number): Promise<void> {
    const { clock, random } = this.options;
    let next = clock.now() + firstDelay;
    while (this.running) {
      const actor = this.actors.get(id)!;
      try {
        await actor.idleUntil(next);
      } catch (error) {
        this.options.onError?.(actor, error);
        await sleep(clock, Math.max(0, next - clock.now()));
      }
      if (!this.running) break;
      const started = clock.now();
      this.options.onTurn?.(actor, started);
      try {
        await actor.turn();
      } catch (error) {
        // Never loudly: the person shrugs and carries on.
        this.options.onError?.(actor, error);
      }
      next = Math.max(started + random.range(this.cadence.min, this.cadence.max), clock.now() + (this.options.restMs ?? 1_200));
    }
  }
}
