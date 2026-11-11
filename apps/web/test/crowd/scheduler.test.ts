import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { choosePlan, type BrainContext } from '../../src/crowd/brain';
import { ContentBook } from '../../src/crowd/content';
import { Governor } from '../../src/crowd/governor';
import { PERSONAS } from '../../src/crowd/personas';
import { Random } from '../../src/crowd/random';
import { CrowdScheduler, TaskClaims, type Actor } from '../../src/crowd/scheduler';
import { runProjectTransaction } from '../../src/scenario/publish';
import { FakeClock } from '../presence/helpers';
import { flush, seededProject, SEED } from './helpers';

/** Runs the fake clock forward in small steps, letting the async loops react between them. */
async function run(clock: FakeClock, ms: number, step = 50): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    clock.advance(step);
    await flush();
  }
}

describe('the crowd scheduler', () => {
  it('staggers people, then gives each a change every 10 to 15 seconds', async () => {
    const clock = new FakeClock();
    const random = new Random(11);
    const turns = new Map<string, number[]>();
    const actors: Actor[] = ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      idleUntil: (until) => new Promise<void>((resolve) => clock.setTimeout(resolve, until - clock.now())),
      // A change takes 3 to 6 seconds of moves.
      turn: () => new Promise<void>((resolve) => clock.setTimeout(resolve, random.range(3_000, 6_000))),
    }));
    const scheduler = new CrowdScheduler({ clock, random: new Random(5), onTurn: (actor, at) => turns.set(actor.id, [...(turns.get(actor.id) ?? []), at]) });
    const start = clock.now();
    scheduler.start(actors);
    await run(clock, 120_000);
    const stopped = scheduler.stop();
    await run(clock, 10_000);
    await stopped;

    const firsts = actors.map((actor) => turns.get(actor.id)![0]! - start).sort((a, b) => a - b);
    // Spread over the first cadence, not all at once.
    for (let index = 1; index < firsts.length; index++) expect(firsts[index]! - firsts[index - 1]!).toBeGreaterThan(1_800);
    expect(firsts[firsts.length - 1]!).toBeLessThan(15_000);
    for (const actor of actors) {
      const starts = turns.get(actor.id)!;
      expect(starts.length).toBeGreaterThanOrEqual(7);
      for (let index = 1; index < starts.length; index++) {
        const gap = starts[index]! - starts[index - 1]!;
        expect(gap).toBeGreaterThanOrEqual(10_000);
        expect(gap).toBeLessThanOrEqual(15_050);
      }
    }
  });

  it('keeps going when a turn fails', async () => {
    const clock = new FakeClock();
    const errors: unknown[] = [];
    let turns = 0;
    const actor: Actor = {
      id: 'x',
      idleUntil: (until) => new Promise<void>((resolve) => clock.setTimeout(resolve, until - clock.now())),
      turn: async () => {
        turns++;
        throw new Error('the engine said no');
      },
    };
    const scheduler = new CrowdScheduler({ clock, random: new Random(1), onError: (_actor, error) => errors.push(error) });
    scheduler.start([actor]);
    await run(clock, 40_000);
    const stopped = scheduler.stop();
    await run(clock, 16_000);
    await stopped;
    expect(turns).toBeGreaterThanOrEqual(3);
    expect(errors.length).toBe(turns);
  });
});

describe('choosing work', () => {
  let project: ProjectModel;
  beforeEach(async () => {
    project = await seededProject();
  });
  afterEach(() => project.destroy());

  function context(personIndex: number, overrides: Partial<BrainContext> & { governor: Governor; content: ContentBook }): BrainContext {
    const persona = PERSONAS[personIndex]!;
    return {
      persona,
      who: { id: persona.person.id, name: persona.person.displayName },
      project,
      area: [],
      pool: [],
      busy: () => false,
      intent: null,
      random: new Random(personIndex + 1),
      now: 0,
      ...overrides,
    };
  }

  it('never picks a task another person has claimed, nor one somebody has selected', () => {
    const clock = new FakeClock();
    const governor = new Governor({ clock, random: new Random(1), handoverTaskId: SEED.handover_task_id });
    const content = new ContentBook(governor, new Random(2));
    const claims = new TaskClaims();
    const leaves = (project.taskStore.leaves as TaskModel[]).filter((task) => !governor.refusal(task)).map((task) => task.id as number);
    const shared = leaves.slice(10, 16);
    // Somebody (a real person) has one selected; another simulated person is working on another.
    const selected = new Set([shared[0]!]);
    expect(claims.claim(shared[1]!, PERSONAS[0]!.person.id)).toBe(true);
    const busy = (who: string) => (taskId: number) => selected.has(taskId) || (claims.holder(taskId) !== undefined && claims.holder(taskId) !== who);
    const chosen = new Set<number>();
    for (let round = 0; round < 60; round++) {
      const ctx = context(1, { governor, content, area: shared, busy: busy(PERSONAS[1]!.person.id), random: new Random(round + 100) });
      const plan = choosePlan(ctx);
      if (plan) chosen.add(plan.taskId);
    }
    expect(chosen.size).toBeGreaterThan(1);
    expect(chosen.has(shared[0]!)).toBe(false);
    expect(chosen.has(shared[1]!)).toBe(false);
    // And claiming refuses a second person outright.
    expect(claims.claim(shared[1]!, PERSONAS[1]!.person.id)).toBe(false);
  });

  it('brings back what someone else changed once it is due, not what they changed themselves', async () => {
    const clock = new FakeClock();
    const governor = new Governor({ clock, random: new Random(1), handoverTaskId: SEED.handover_task_id, ledger: { delayMs: { min: 60_000, max: 60_000 }, selfGraceMs: 30_000 } });
    const content = new ContentBook(governor, new Random(2));
    const task = (project.taskStore.leaves as TaskModel[]).find((leaf) => !governor.refusal(leaf) && Number(leaf.percentDone) < 50)!;
    const marcus = PERSONAS[0]!.person;
    const progress = Math.round(Number(task.percentDone));
    const nudge = { title: 'Edit progress', taskId: task.id as number, field: 'progress' as const, movesDates: false, read: (record: TaskModel) => Math.round(Number(record.percentDone)), write: (record: TaskModel) => (record.percentDone = progress + 20) };
    expect((await governor.apply(project, nudge, { id: marcus.id, name: marcus.displayName })).ok).toBe(true);
    expect(governor.ledger.get(task.id as number, 'progress')?.seed).toBe(progress);
    const plans = (personIndex: number) => choosePlan(context(personIndex, { governor, content, now: clock.now(), random: new Random(3) }));

    // Not yet due: nobody brings it back.
    expect(plans(1)?.restores).toBeUndefined();
    clock.advance(61_000);
    // Due: Lena (the scheduler) takes it; Marcus, who made it, leaves it to the others for a while.
    expect(plans(1)?.restores?.taskId).toBe(task.id);
    expect(plans(0)?.restores).toBeUndefined();
    clock.advance(31_000);
    expect(plans(0)?.restores?.taskId).toBe(task.id);
    // Somebody (a real person, say) changed it since: it is theirs now, nothing to bring back.
    await runProjectTransaction(project, 'Edit progress', () => (task.percentDone = progress + 30));
    expect(plans(1)?.restores).toBeUndefined();
    expect(governor.ledger.size).toBe(0);
  });

  it('with their share of drift out, brings back an older change of someone else instead of idling, never a fresh one', async () => {
    const clock = new FakeClock();
    const governor = new Governor({ clock, random: new Random(1), handoverTaskId: SEED.handover_task_id, ledger: { delayMs: { min: 600_000, max: 600_000 } } });
    const content = new ContentBook(governor, new Random(2));
    const lena = PERSONAS[1]!.person;
    const marcus = PERSONAS[0]!.person;
    const free = (project.taskStore.leaves as TaskModel[]).filter((leaf) => !governor.refusal(leaf));
    // Lena has her full share out (notes on four tasks).
    for (const task of free.slice(0, governor.perPerson)) governor.ledger.record({ taskId: task.id as number, taskName: task.name, field: 'note', before: '', after: 'x', by: lena.id, byName: lena.displayName });
    // Marcus nudged progress on another task.
    const nudged = free[10]!;
    const progress = Math.round(Number(nudged.percentDone));
    await runProjectTransaction(project, 'Edit progress', () => (nudged.percentDone = progress + 10));
    governor.ledger.record({ taskId: nudged.id as number, taskName: nudged.name, field: 'progress', before: progress, after: progress + 10, by: marcus.id, byName: marcus.displayName });
    const restores = (now: number) =>
      Array.from({ length: 20 }, (_, seed) => choosePlan(context(1, { governor, content, area: free.slice(0, 8).map((task) => task.id as number), now, random: new Random(seed + 1) }))).filter((plan) => plan?.restores);
    // Just made: left alone.
    expect(restores(clock.now() + 10_000)).toHaveLength(0);
    // A minute and more later (still long before it is due): Lena brings it back.
    const later = restores(clock.now() + 70_000);
    expect(later.length).toBeGreaterThan(5);
    expect(later.every((plan) => plan!.taskId === nudged.id)).toBe(true);
  });
});
