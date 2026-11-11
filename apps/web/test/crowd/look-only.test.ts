/**
 * A look-only crowd (`pnpm crowd --look-only`, for a session where nothing may change): the people point, select, open the task
 * panel and scroll, and never change anything. What they may choose holds no edit at all, the brain
 * makes no plan, the governor refuses every change before a transaction opens, and a crowd run over the
 * in-memory relay sends no revision while a real person sees them busy.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chooseLook, choosePlan, editPlan, LOOK_KINDS, type BrainContext, type LookKind } from '../../src/crowd/brain';
import { ContentBook } from '../../src/crowd/content';
import { Crowd } from '../../src/crowd/crowd';
import { Governor, type DriftEntry } from '../../src/crowd/governor';
import { ACTION_KINDS, PERSONAS } from '../../src/crowd/personas';
import { Random } from '../../src/crowd/random';
import { SCREEN_COLUMNS, viewerColumns, VirtualScreen } from '../../src/crowd/screen';
import { createProjectModel, toInlineDataPackage } from '../../src/gantt/project';
import type { Clock } from '../../src/presence/clock';
import { InMemoryPresenceHub } from '../../src/presence/in-memory-presence';
import type { CursorPoint } from '../../src/presence/protocol';
import { PresenceSession } from '../../src/presence/session';
import { runProjectTransaction } from '../../src/scenario/publish';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { RevisionSync } from '../../src/sync/revision-sync';
import { FakeClock } from '../presence/helpers';
import { PROJECT_ID, loadResult } from '../sync/helpers';
import { seededProject, seedSnapshot, SEED } from './helpers';

const LENA = { id: PERSONAS[1]!.person.id, name: PERSONAS[1]!.person.displayName };
const MARCUS = { id: PERSONAS[0]!.person.id, name: PERSONAS[0]!.person.displayName };
const EDITS = new Set<string>(ACTION_KINDS);

/** Crowd time runs `factor` times faster than the wall clock (the sync layer keeps real time). */
function fastClock(factor: number): Clock {
  const start = Date.now();
  return {
    now: () => start + (Date.now() - start) * factor,
    setTimeout: (callback, ms) => setTimeout(callback, ms / factor),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('what a look-only person may choose', () => {
  it('holds no edit: the ways of looking and the kinds of edit have nothing in common', () => {
    expect(LOOK_KINDS.filter((kind) => EDITS.has(kind))).toEqual([]);
  });

  it('only ever picks a way of looking, turn or not, with or without a colleague to look at', () => {
    const picked = new Map<LookKind, number>();
    for (let seed = 1; seed <= 400; seed++) {
      const random = new Random(seed);
      for (const turn of [false, true]) {
        for (const colleague of [false, true]) {
          for (const left of [900, 2_000, 4_000, 9_000]) {
            const kind = chooseLook(random, { left, lookOnly: true, turn, colleague });
            expect(kind).toBeDefined();
            expect(LOOK_KINDS).toContain(kind);
            expect(EDITS.has(kind!)).toBe(false);
            picked.set(kind!, (picked.get(kind!) ?? 0) + 1);
          }
        }
      }
    }
    // Not a degenerate mode: it opens the task panel, rests on bars and joins colleagues too.
    for (const kind of ['peek', 'inspect', 'glance', 'select', 'read'] as const) expect(picked.get(kind) ?? 0).toBeGreaterThan(20);
  });

  it('between the changes of a crowd that edits, looks around as it always has (no panel, bar or colleague looks)', () => {
    const random = new Random(7);
    const seen = new Set<LookKind | undefined>();
    for (let index = 0; index < 2_000; index++) seen.add(chooseLook(random, { left: index % 2 ? 1_000 : 5_000 }));
    expect([...seen].sort()).toEqual(['read', 'rest', 'scroll', 'select', 'wander']);
  });
});

describe('a look-only brain and governor', () => {
  let project: ProjectModel;
  let clock: FakeClock;
  let revisions: number;
  beforeEach(async () => {
    project = await seededProject();
    clock = new FakeClock();
    revisions = 0;
    project.on({ revisionNotification: () => revisions++ });
  });
  afterEach(() => project.destroy());

  const context = (governor: Governor, overrides: Partial<BrainContext> = {}): BrainContext => ({
    persona: PERSONAS[1]!,
    who: LENA,
    project,
    governor,
    content: new ContentBook(governor, new Random(2)),
    area: [],
    pool: [],
    busy: () => false,
    intent: null,
    random: new Random(3),
    now: clock.now(),
    ...overrides,
  });

  it('makes no plan, not even to bring back a change that is due, where a crowd that edits would', async () => {
    const governor = new Governor({ clock, random: new Random(1), handoverTaskId: SEED.handover_task_id, ledger: { delayMs: { min: 60_000, max: 60_000 }, selfGraceMs: 30_000 } });
    const free = (project.taskStore.leaves as TaskModel[]).filter((leaf) => !governor.refusal(leaf) && Number(leaf.percentDone) < 50);
    const task = free[0]!;
    const progress = Math.round(Number(task.percentDone));
    const nudge = { title: 'Edit progress', taskId: task.id as number, field: 'progress' as const, movesDates: false, read: (record: TaskModel) => Math.round(Number(record.percentDone)), write: (record: TaskModel) => (record.percentDone = progress + 20) };
    expect((await governor.apply(project, nudge, MARCUS)).ok).toBe(true);
    clock.advance(61_000);
    const area = free.slice(1, 12).map((leaf) => leaf.id as number);
    const intent = { text: 'tidying up', kinds: ACTION_KINDS, focus: area, until: clock.now() + 60_000, source: 'canned' as const };
    for (let seed = 1; seed <= 40; seed++) {
      const ctx = context(governor, { area, pool: area, intent, random: new Random(seed), now: clock.now() });
      // The same moment without look-only: something to do (the due change first).
      expect(choosePlan({ ...ctx, random: new Random(seed) })).not.toBeNull();
      expect(choosePlan({ ...ctx, lookOnly: true })).toBeNull();
    }
  });

  it('refuses every change before a transaction opens: nothing is written, recorded or sent', async () => {
    const governor = new Governor({ clock, random: new Random(1), handoverTaskId: SEED.handover_task_id, lookOnly: true });
    const leaves = (project.taskStore.leaves as TaskModel[]).filter((leaf) => !governor.refusal(leaf));
    const before = leaves.map((leaf) => [leaf.id, leaf.name, Number(leaf.percentDone), (leaf as TaskModel & { note?: string }).note ?? ''] as const);
    // (Follow-up revisions of the load come within 100 ms.)
    await sleep(200);
    const baseline = revisions;
    let attempts = 0;
    for (const [index, leaf] of leaves.slice(0, 12).entries()) {
      for (const kind of ACTION_KINDS) {
        const plan = editPlan(context(governor, { random: new Random(index + 1) }), leaf, kind);
        if (!plan) continue;
        attempts++;
        const outcome = await governor.apply(project, plan.change, LENA);
        expect(outcome).toEqual({ ok: false, reason: 'look-only: nobody changes anything' });
      }
    }
    expect(attempts).toBeGreaterThan(10);
    await sleep(200);
    expect(revisions).toBe(baseline);
    expect(governor.ledger.size).toBe(0);
    expect(governor.stats.applied + governor.stats.restored).toBe(0);
    expect(leaves.map((leaf) => [leaf.id, leaf.name, Number(leaf.percentDone), (leaf as TaskModel & { note?: string }).note ?? ''] as const)).toEqual(before);
    // A change made outside the crowd still goes through: only the crowd is held back.
    await runProjectTransaction(project, 'Edit progress', () => (leaves[0]!.percentDone = 40));
    await sleep(200);
    expect(revisions).toBeGreaterThan(baseline);
  });
});

describe('the columns a look-only person’s screen has', () => {
  it('are the ones a viewer opening the project has', () => {
    const all = SCREEN_COLUMNS.map((column) => column.id);
    expect(viewerColumns(false, ['Level 1 build-out', 'Level 2 build-out'])).toEqual(all);
    expect(viewerColumns(true, ['Site and foundations', 'Level 1 build-out', 'Level 2 build-out', 'Completion'])).toEqual(['task', 'schedule-crew']);
    expect(viewerColumns(true, ['Site work', 'Fit-out'])).toEqual(['task', 'equipment']);
  });

  it('put the timeline right after them', async () => {
    const project = await seededProject();
    try {
      const narrow = new VirtualScreen(project, { columns: ['task', 'schedule-crew'] });
      const wide = new VirtualScreen(project);
      expect(narrow.columns.map((column) => column.id)).toEqual(['task', 'schedule-crew']);
      expect(narrow.timelineLeft).toBe(290 + 88 + 40 + 6);
      expect(wide.timelineLeft).toBe(290 + 88 + 128 + 214 + 40 + 6);
      // Over the cells either has, the same thing; past the crew, the narrow screen is on the timeline.
      expect(narrow.pointAt({ x: 300, y: 100 })).toEqual(wide.pointAt({ x: 300, y: 100 }));
      expect(narrow.pointAt({ x: 450, y: 100 })?.kind).toBe('timeline');
      narrow.dispose();
      wide.dispose();
    } finally {
      project.destroy();
    }
  });
});

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

describe('a look-only minute in the site office', () => {
  it('three people look busy to a real person, keep to the viewer’s columns, and send no revision, an old ledger notwithstanding', async () => {
    const SPEED = 10;
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: seedSnapshot() });
    const hub = new InMemoryPresenceHub();
    const clock = fastClock(SPEED);
    const columns = ['task', 'schedule-crew'];

    const clients: { project: ProjectModel; sync: RevisionSync; presence: PresenceSession; sessionId: string }[] = [];
    for (const persona of PERSONAS.slice(0, 3)) {
      const sessionId = `sim-${persona.firstName.toLowerCase()}`;
      const project = createProjectModel();
      const sync = new RevisionSync(project, relay.connect(sessionId), { sessionId, projectId: PROJECT_ID, prepareSnapshot: toInlineDataPackage, backoff: { initialMs: 20, maxMs: 100 } });
      await sync.init(loadResult(seedSnapshot()));
      const presence = new PresenceSession({
        self: { session: sessionId, user: persona.person.id, name: persona.person.displayName, color: persona.person.color, role: 'pm', simulated: true },
        transport: hub.connect(sessionId),
        clock,
      });
      presence.start();
      cleanup.push(() => {
        presence.dispose();
        sync.dispose();
        project.destroy();
      });
      clients.push({ project, sync, presence, sessionId });
    }
    // An earlier run (one that edited) left a note out of place: a crowd that edits would put it back now.
    const noted = (clients[0]!.project.taskStore.leaves as TaskModel[]).find((leaf) => !(leaf as TaskModel & { note?: string }).note && leaf.isLeaf)!;
    const old: DriftEntry = { key: `${noted.id}:note`, taskId: noted.id as number, taskName: noted.name, field: 'note', seed: 'an older note', current: '', by: MARCUS.id, byName: MARCUS.name, since: 0, dueAt: 0, attempts: 0 };
    const crowd = new Crowd({
      projectName: 'Riverside Clinic',
      handoverTaskId: SEED.handover_task_id,
      offLimits: () => new Set([SEED.booking.task_id]),
      clock,
      seed: 20261106,
      lookOnly: true,
      screenColumns: columns,
      ledgerEntries: [old],
    });
    cleanup.push(() => crowd.dispose());
    PERSONAS.slice(0, 3).forEach((persona, index) => {
      const { project, sync, presence, sessionId } = clients[index]!;
      crowd.add({ persona, displayName: persona.person.displayName, project, sync, presence, sessionId });
    });

    // A real person watching.
    const human = new PresenceSession({ self: { session: 'priya', user: 'priya', name: 'Priya Mehta', color: '#2563eb', role: 'pm' }, transport: hub.connect('priya'), clock });
    human.start();
    cleanup.push(() => human.dispose());
    const points: CursorPoint[] = [];
    const selected = new Set<number>();
    let activities = 0;
    const lastSeq = new Map<string, number>();
    cleanup.push(
      human.subscribe(() => {
        const snapshot = human.getSnapshot();
        for (const cursor of snapshot.cursors) {
          if (lastSeq.get(cursor.session) === cursor.seq) continue;
          lastSeq.set(cursor.session, cursor.seq);
          points.push(cursor.point);
        }
        for (const peer of snapshot.peers) {
          if (peer.taskId !== null) selected.add(peer.taskId);
          if (peer.activity) activities++;
        }
      }),
    );

    crowd.start();
    await sleep(45_000 / SPEED);
    const status = crowd.status();
    const left = await crowd.windDown(5_000);

    // Busy to look at: everyone's pointer moved, rows were selected, all three were seen.
    expect(human.getSnapshot().peers.filter((peer) => peer.simulated)).toHaveLength(3);
    expect(status.people.every((person) => person.pointerUpdates > 20)).toBe(true);
    expect(new Set(points.map((point) => point.taskId)).size).toBeGreaterThan(4);
    expect(selected.size).toBeGreaterThan(0);
    // Nothing shown as being done to the plan (no typing, dragging or panel editing).
    expect(activities).toBe(0);
    // Only the columns the viewer has, or the timeline.
    expect(points.filter((point) => point.kind === 'grid' && !columns.includes(point.column))).toEqual([]);
    // Nothing written: no change, nothing brought back (the old note neither), no revision anywhere.
    expect(status.governor).toEqual({ applied: 0, vetoed: 0, restored: 0 });
    expect(status.people.every((person) => person.changes === 0 && person.restores === 0)).toBe(true);
    expect(left).toEqual([]);
    expect(relay.allRows()).toEqual([]);
    for (const client of clients) {
      expect(client.sync.state.pending).toBe(0);
      expect(client.sync.state.lastRevision).toBe(0);
    }
  }, 30_000);
});
