import { TaskStore } from '@bryntum/gantt';
import type { ProjectModel } from '@bryntum/gantt';
import { whenSaved } from '../../scenario/publish';
import { withoutFilters } from '../filters';
import { keepOrderedPositions, orderedPositions, rowsFollowOrderedTree, type AppliedOrder, type OrderedNode, type OrderedTreeStore } from '../revisions/ordered-tree';

interface ChangesetHooks {
  applyChangeset(this: unknown, changes: Record<string, unknown>, ...rest: unknown[]): unknown;
  afterChangesetApplied(this: unknown, modifiedParents: OrderedNode[]): void;
}

/**
 * The task store of every project: a remote revision keeps the ordered tree it describes
 * (`keepOrderedPositions`) and rows follow the ordered tree (`rowsFollowOrderedTree`).
 */
export class CollabTaskStore extends TaskStore {
  static $name = 'CollabTaskStore';

  private applying: AppliedOrder | undefined;

  applyChangeset(changes: Record<string, unknown>, ...rest: unknown[]): unknown {
    this.applying = { before: orderedPositions(this as unknown as OrderedTreeStore), changes };
    try {
      return (TaskStore.prototype as unknown as ChangesetHooks).applyChangeset.call(this, changes, ...rest);
    } finally {
      this.applying = undefined;
    }
  }

  /**
   * The task menu's Delete with a search on: what is hidden under a deleted group goes too, and Bryntum
   * only records that (with those tasks' links) while it can see it. See `withoutFilters`.
   */
  override remove(...args: Parameters<TaskStore['remove']>): ReturnType<TaskStore['remove']> {
    const project = (this as unknown as { project: ProjectModel }).project;
    const filtered = Boolean((this as unknown as { filters?: { count: number } }).filters?.count);
    if (!filtered || !project || this.applying) return super.remove(...args);
    // `withoutFilters` runs this at once, up to the wait: the rows are gone when it returns.
    let removed: ReturnType<TaskStore['remove']> | undefined;
    void withoutFilters(project, async () => {
      removed = super.remove(...args);
      await whenSaved(project);
    });
    return removed!;
  }

  afterChangesetApplied(modifiedParents: OrderedNode[]): void {
    if (this.applying) {
      keepOrderedPositions(this as unknown as OrderedTreeStore, this.applying, modifiedParents);
    }
    (TaskStore.prototype as unknown as ChangesetHooks).afterChangesetApplied.call(this, modifiedParents);
    rowsFollowOrderedTree(this as unknown as OrderedTreeStore, modifiedParents);
  }
}
