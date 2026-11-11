/**
 * Lifting the plan's filters around a change. A client filtering that receives a nested group keeps only
 * the tasks its filter shows (on Bryntum's own too: 3 of 6), and a piece dropped here with a filter on
 * reached the server with the tasks showing and none of the rest (4 of 15). The corrections that followed
 * collided with the revision coming back, and the client fell out of sync for good. So a change that adds
 * tasks runs on the whole plan, and the filters go back afterwards. The view's own re-filtering waits for
 * that (`whenFiltersBack`).
 */
import type { ProjectModel } from '@bryntum/gantt';

interface FilterableStore {
  filters?: { values: unknown[] };
  clearFilters(): void;
  addFilter(filter: unknown, silent?: boolean): void;
  filter(): unknown;
}

interface Lift {
  /** Changes running on the whole plan right now. */
  count: number;
  filters: unknown[];
  back: Promise<void>;
  resume(): void;
}

const lifts = new WeakMap<object, Lift>();

const storeOf = (project: ProjectModel) => project.taskStore as unknown as FilterableStore | undefined;

/** Runs `change` with the plan's filters lifted, and puts them back after it. */
export async function withoutFilters<T>(project: ProjectModel, change: () => Promise<T>): Promise<T> {
  const store = storeOf(project);
  let lift = lifts.get(project);
  if (!lift) {
    const filters = [...(store?.filters?.values ?? [])];
    if (!store || filters.length === 0) return change();
    let resume = () => {};
    const back = new Promise<void>((resolve) => {
      resume = resolve;
    });
    lift = { count: 0, filters, back, resume };
    lifts.set(project, lift);
    store.clearFilters();
  }
  lift.count++;
  try {
    return await change();
  } finally {
    lift.count--;
    if (lift.count === 0) {
      lifts.delete(project);
      if (store && !project.isDestroyed) {
        for (const filter of lift.filters) store.addFilter(filter, true);
        await store.filter();
      }
      lift.resume();
    }
  }
}

/** Resolves once no change is running on the whole plan: a filter applied before then would get in its way. */
export async function whenFiltersBack(project: ProjectModel): Promise<void> {
  await lifts.get(project)?.back;
}
