/**
 * What plain Bryntum does, with none of our classes in the path: two clients in one page, on the setup its
 * revisions guide and realtime demo use, trading revisions through a small server here. Each check states
 * a behavior docs/bryntum-workarounds.md answers. A failure after an upgrade is good news: Bryntum changed,
 * and the workaround that row names may be able to go.
 */
import { expect, test, type Page } from '@playwright/test';
import { SEED_IDS } from '../../packages/shared/src/seed/index.ts';
import { resetDemoProject } from './demo-reset';
import { CM, quietAgent, signIn } from './plan';

const NESTED = {
  name: 'Keep top',
  children: [
    { name: 'Keep sub', children: [{ name: 'Keep leaf', duration: 1 }, { name: 'Hidden leaf', duration: 1 }] },
    { name: 'Hidden sub', children: [{ name: 'Hidden leaf 2', duration: 1 }] },
  ],
};

/** Puts the two-client harness on the page, as `__plain`. */
const installHarness = (page: Page) =>
  page.evaluate(() => {
    const real = (globalThis as any).__gantt();
    const baseOf = (type: any, name: string) => {
      let at = type;
      while (at.$name !== name) at = Object.getPrototypeOf(at);
      return at;
    };
    const ProjectModel = baseOf(real.project.constructor, 'ProjectModel');
    // The realtime demo's own task model.
    class DemoTask extends baseOf(real.project.taskStore.modelClass, 'TaskModel') {
      static $name = 'DemoTask';
      static fields = [
        { name: 'startDate', format: 'YYYY-MM-DDTHH:mm:ss' },
        { name: 'endDate', format: 'YYYY-MM-DDTHH:mm:ss' },
        { name: 'constraintDate', format: 'YYYY-MM-DDTHH:mm:ss' },
        { name: 'parentIndex', persist: true },
        { name: 'orderedParentIndex', persist: true },
      ];
    }
    const seed = JSON.stringify(real.project.inlineData);
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const client = async (name: string) => {
      const project = new ProjectModel({ taskModelClass: DemoTask, stm: { revisionsEnabled: true }, autoSetConstraints: true, taskStore: { useOrderedTreeForWbs: true } });
      const self = { name, project, outbox: [] as any[], errors: [] as string[], task: (id: number) => project.taskStore.getById(id) };
      project.on('revisionNotification', ({ localRevisionId, changes, conflictResolutionFor, clientId }: any) => {
        self.outbox.push({ localRevisionId, changes: JSON.parse(JSON.stringify(changes)), conflictResolutionFor, clientId: clientId ?? name });
      });
      await project.queue(async () => {
        const data = JSON.parse(seed);
        project.stm.disable();
        project.stm.resetQueue();
        await project.loadInlineData({ project: data.project, calendars: data.calendarsData, tasks: data.tasksData, dependencies: data.dependenciesData, resources: data.resourcesData, assignments: data.assignmentsData });
        await project.commitAsync();
        project.stm.enable();
        project.initRevisions(name, 'base');
      });
      return self;
    };

    let nextRevision = 1;
    let nextId = 900_000;
    const ids = new Map<unknown, number>();
    /** What a server does to a revision: numbers it, and gives new records their ids. */
    const accept = (revision: any) => {
      const row = JSON.parse(JSON.stringify(revision));
      row.revisionId = String(nextRevision++);
      const bags = Object.values<any>(row.changes).flatMap((store) => [store, store?.$input]);
      for (const entry of bags.flatMap((bag) => bag?.added ?? [])) {
        if (!entry.$PhantomId || entry.id != null) continue;
        if (!ids.has(entry.$PhantomId)) ids.set(entry.$PhantomId, ++nextId);
        entry.id = ids.get(entry.$PhantomId);
      }
      for (const entry of bags.flatMap((bag) => [...(bag?.added ?? []), ...(bag?.updated ?? [])])) {
        for (const key of ['parentId', 'fromEvent', 'toEvent', 'event', 'eventId']) if (ids.has(entry[key])) entry[key] = ids.get(entry[key]);
      }
      return row;
    };
    const deliver = async (revision: any, clients: any[]) => {
      for (const one of clients) {
        try {
          await one.project.applyRevisions([JSON.parse(JSON.stringify(revision))]);
        } catch (error: any) {
          one.errors.push(String(error?.message ?? error));
        }
      }
    };
    /** Lets the clients record what they did. */
    const recorded = async (one: any) => {
      await one.project.commitAsync();
      await wait(400);
    };
    /** Everything sent so far reaches everyone, in the order given, along with any corrections it brings. */
    const settle = async (clients: any[], first: any[] = clients) => {
      for (const one of first) for (const revision of one.outbox.splice(0)) await deliver(accept(revision), clients);
      for (let round = 0; round < 3; round++) {
        await wait(350);
        for (const one of clients) for (const revision of one.outbox.splice(0)) await deliver(accept(revision), clients);
      }
    };
    (globalThis as any).__plain = { client, settle, recorded };
  });

test.describe('plain Bryntum', () => {
  test.beforeAll(() => resetDemoProject(SEED_IDS.project));

  test.beforeEach(async ({ page }) => {
    await quietAgent(page.context());
    await signIn(page, SEED_IDS.project, CM);
    await installHarness(page);
  });

  test('a split task replayed under another revision: the clients disagree on its length', async ({ page }) => {
    const durations = await page.evaluate(async () => {
      const { client, settle, recorded } = (globalThis as any).__plain;
      const [a, b] = [await client('a'), await client('b')];
      b.project.taskStore.remove([b.task(242), b.task(464)]);
      await b.project.commitAsync();
      b.project.dependencyStore.add({ fromEvent: 462, toEvent: 111 });
      await recorded(b);
      a.task(614).name = 'renamed';
      await recorded(a);
      await settle([a, b], [a, b]);
      return [a.task(421).duration, b.task(421).duration];
    });
    expect(durations[0]).not.toBe(durations[1]);
  });

  test('a client with a filter on keeps only the tasks it shows of a nested group it receives', async ({ page }) => {
    const held = await page.evaluate(async (group) => {
      const { client, settle, recorded } = (globalThis as any).__plain;
      const [a, b] = [await client('a'), await client('b')];
      b.project.taskStore.filter({ property: 'name', value: 'Keep', operator: '*' });
      const target = a.task(210);
      target.parent.insertChild(group, target.nextSibling);
      await recorded(a);
      await settle([a, b]);
      b.project.taskStore.clearFilters();
      const count = (one: any) => one.project.taskStore.allRecords.filter((task: any) => /Keep|Hidden/.test(task.name ?? '')).length;
      return [count(a), count(b)];
    }, NESTED);
    expect(held).toEqual([6, 3]);
  });

  test('sending a nested group with a filter on keeps all of it', async ({ page }) => {
    const sent = await page.evaluate(async (group) => {
      const { client, recorded } = (globalThis as any).__plain;
      const b = await client('b');
      b.project.taskStore.filter({ property: 'name', value: 'Keep', operator: '*' });
      const target = b.task(210);
      target.parent.insertChild(group, target.nextSibling);
      await recorded(b);
      return b.outbox.flatMap((revision: any) => revision.changes.tasks?.$input?.added ?? []).length;
    }, NESTED);
    expect(sent).toBe(6);
  });

  test('two groups moved into each other: a stack overflow on both clients', async ({ page }) => {
    const errors = await page.evaluate(async () => {
      const { client, settle, recorded } = (globalThis as any).__plain;
      const [a, b] = [await client('a'), await client('b')];
      a.task(420).appendChild(a.task(410));
      await recorded(a);
      b.task(410).appendChild(b.task(420));
      await recorded(b);
      await settle([a, b], [a, b]);
      return [a.errors, b.errors];
    });
    expect(errors[0].join(' ')).toContain('Maximum call stack');
    expect(errors[1].join(' ')).toContain('Maximum call stack');
  });

  test('the same link made twice: two copies on both clients', async ({ page }) => {
    const copies = await page.evaluate(async () => {
      const { client, settle, recorded } = (globalThis as any).__plain;
      const [a, b] = [await client('a'), await client('b')];
      for (const one of [a, b]) {
        one.project.dependencyStore.add({ fromEvent: 412, toEvent: 422 });
        await recorded(one);
      }
      await settle([a, b], [a, b]);
      return [a, b].map((one) => one.project.dependencyStore.allRecords.filter((link: any) => link.fromEvent?.id === 412 && link.toEvent?.id === 422).length);
    });
    expect(copies).toEqual([2, 2]);
  });

  // We rely on this one: no loop check of our own.
  test('two links that close a loop only together: the later one is switched off, alike on both', async ({ page }) => {
    const links = await page.evaluate(async () => {
      const { client, settle, recorded } = (globalThis as any).__plain;
      const [a, b] = [await client('a'), await client('b')];
      a.project.dependencyStore.add({ fromEvent: 412, toEvent: 422 });
      await recorded(a);
      b.project.dependencyStore.add({ fromEvent: 422, toEvent: 412 });
      await recorded(b);
      await settle([a, b], [a, b]);
      return [a, b].map((one) =>
        one.project.dependencyStore.allRecords
          .filter((link: any) => [412, 422].includes(link.fromEvent?.id) && [412, 422].includes(link.toEvent?.id))
          .map((link: any) => `${link.fromEvent.id}>${link.toEvent.id}:${link.active}`)
          .sort(),
      );
    });
    expect(links[0]).toEqual(['412>422:true', '422>412:false']);
    expect(links[1]).toEqual(links[0]);
  });

  test('deleted under a filter and undone after it: back in the wrong row, the ordered tree right', async ({ page }) => {
    const { before, rows, ordered } = await page.evaluate(async () => {
      const { client, settle, recorded } = (globalThis as any).__plain;
      const b = await client('b');
      const group = b.task(210);
      const before = group.children.map((task: any) => task.id);
      b.project.taskStore.filter({ filterBy: (task: any) => task.id !== before[1] });
      b.task(before[2]).remove();
      await recorded(b);
      b.project.taskStore.clearFilters();
      await settle([b]);
      await b.project.stm.undo();
      await recorded(b);
      return { before, rows: b.task(210).children.map((task: any) => task.id), ordered: b.task(210).orderedChildren.map((task: any) => task.id) };
    });
    expect(rows).not.toEqual(before);
    expect(ordered).toEqual(before);
  });

  test('someone else moves a row: the rows here stay as they were', async ({ page }) => {
    const { before, rows, theirs } = await page.evaluate(async () => {
      const { client, settle, recorded } = (globalThis as any).__plain;
      const [a, b] = [await client('a'), await client('b')];
      const ids = (list: any[]) => list.map((task) => task.id);
      const before = ids(b.task(210).children);
      const group = a.task(210);
      group.insertChild(group.children[group.children.length - 1], group.children[0], false, { orderedBeforeNode: group.orderedChildren[0] });
      group.refreshWbs({ deep: true, useOrderedTree: true });
      await recorded(a);
      await settle([a, b]);
      return { before, rows: ids(b.task(210).children), theirs: ids(a.task(210).children) };
    });
    expect(theirs).not.toEqual(before);
    expect(rows).toEqual(before);
  });

  test('what is done while the engine lets the screen draw is recorded as calculated: nobody else gets it', async ({ page }) => {
    const { input, removed } = await page.evaluate(async () => {
      const { client, recorded } = (globalThis as any).__plain;
      const b = await client('b');
      const detach = b.project.on({
        refresh: ({ isCalculated }: { isCalculated?: boolean }) => {
          if (!isCalculated) return;
          detach();
          setTimeout(() => b.task(212).remove());
        },
      });
      b.task(211).duration = 4;
      await recorded(b);
      await recorded(b);
      const tasks = b.outbox.map((revision: any) => revision.changes.tasks ?? {});
      return {
        removed: tasks.flatMap((bag: any) => bag.removed ?? []).map((entry: any) => entry.id),
        input: tasks.flatMap((bag: any) => bag.$input?.removed ?? []).map((entry: any) => entry.id),
      };
    });
    expect(removed).toContain(212);
    expect(input).not.toContain(212);
  });

  test('deletes that cross and empty a group: each client keeps the length of its own last step', async ({ page }) => {
    const durations = await page.evaluate(async () => {
      const { client, settle, recorded } = (globalThis as any).__plain;
      const [a, b] = [await client('a'), await client('b')];
      a.project.taskStore.remove([a.task(421), a.task(422)]);
      await recorded(a);
      b.task(422).remove();
      await recorded(b);
      await settle([a, b], [a, b]);
      return [a.task(420).duration, b.task(420).duration];
    });
    expect(durations[0]).not.toBe(durations[1]);
  });
});
