/**
 * The row order every client shares. Revisions carry `orderedParentIndex` and every client numbers the
 * ordered tree alike, but Bryntum keeps each client's own row order, and each one's redo goes by that.
 */
export interface OrderedNode {
  id: unknown;
  isLeaf: boolean;
  parent?: OrderedNode | null;
  orderedParentIndex: number;
  children?: OrderedNode[] | boolean;
  unfilteredChildren?: OrderedNode[];
  orderedChildren?: OrderedNode[];
  traverse(fn: (node: OrderedNode) => void): void;
  setData(field: string, value: unknown): void;
  sortVisibleChildren(sorterFn: (a: OrderedNode, b: OrderedNode) => number, deep: boolean): void;
  sortUnfilteredChildren(sorterFn: (a: OrderedNode, b: OrderedNode) => number, deep: boolean): void;
}

export interface OrderedTreeStore {
  isSorted: boolean;
  rootNode: OrderedNode;
  getById(id: unknown): OrderedNode | undefined;
  storage: { replaceValues(options: { values: unknown[]; silent: boolean }): void };
  collectDescendants(node: OrderedNode): { visible: unknown[] };
  afterPerformSort(silent: boolean): void;
}

export interface AppliedOrder {
  /** Every task's `orderedParentIndex` before the changeset. */
  before: Map<OrderedNode, number>;
  changes: Record<string, unknown>;
}

/** The last word when two rows claim one place: the same on every client, unlike each one's row list. */
const byTaskId = (a: OrderedNode, b: OrderedNode) => (typeof a.id === 'number' && typeof b.id === 'number' ? a.id - b.id : 0);

export function orderedPositions(store: OrderedTreeStore): Map<OrderedNode, number> {
  const positions = new Map<OrderedNode, number>();
  store.rootNode.traverse((node) => positions.set(node, node.orderedParentIndex));
  return positions;
}

/**
 * A revision sends the fields that changed, so a task moved to another parent at the position number
 * it already had (an outdent, typically) arrives with its new `parentId` only. Bryntum applies the
 * siblings' new positions first, then moves the task, appending it to the new parent and renumbering
 * that parent's ordered children, which overwrote the positions it had just applied: the receiving
 * clients ordered the parent differently from the sender (and WBS followed). The positions the
 * revision describes are the ones from before it, overlaid with the ones it sends; they are restored
 * here, before Bryntum sorts the ordered children and refreshes WBS. Two children can claim the same
 * position when the revision was made on another order (a move into a deleted group is ignored, but
 * the revision still shifts the siblings it left behind): the child the revision did not send keeps
 * its place ahead of the one it shifted, on every client alike, rather than in whatever order each
 * client's array happens to hold.
 */
export function keepOrderedPositions(store: OrderedTreeStore, applied: AppliedOrder, parents: OrderedNode[]): void {
  const input = ((applied.changes.$input as Record<string, unknown> | undefined) ?? applied.changes) as {
    added?: Record<string, unknown>[];
    updated?: Record<string, unknown>[];
  };
  const sent = new Map<OrderedNode, number>();
  for (const entry of [...(input.added ?? []), ...(input.updated ?? [])]) {
    const record = store.getById(entry.id) ?? store.getById(entry[PHANTOM_ID_FIELD]);
    if (record && typeof entry.orderedParentIndex === 'number') {
      sent.set(record, entry.orderedParentIndex);
    }
  }
  // Bryntum lists the topmost modified parents and sorts their whole subtrees.
  for (const parent of new Set(parents)) {
    parent.traverse((node) => {
      const children = node.orderedChildren;
      if (!children?.length) {
        return;
      }
      const intended = (child: OrderedNode) => sent.get(child) ?? applied.before.get(child) ?? child.orderedParentIndex;
      const ranked = children
        .map((child, index) => ({ child, index }))
        .sort(
          (a, b) =>
            intended(a.child) - intended(b.child) ||
            Number(sent.has(a.child)) - Number(sent.has(b.child)) ||
            byTaskId(a.child, b.child) ||
            a.index - b.index,
        );
      ranked.forEach(({ child }, rank) => {
        if (child.orderedParentIndex !== rank) {
          child.setData('orderedParentIndex', rank);
        }
      });
    });
  }
}

export const PHANTOM_ID_FIELD = '$PhantomId';

const byOrderedIndex = (a: OrderedNode, b: OrderedNode) => (a.orderedParentIndex ?? 0) - (b.orderedParentIndex ?? 0);

function followsOrder(nodes: OrderedNode[] | undefined): boolean {
  return !nodes || nodes.every((node, index) => index === 0 || byOrderedIndex(nodes[index - 1]!, node) <= 0);
}

/**
 * Every client agrees on the ordered tree (`orderedParentIndex`, persisted, and the WBS built from
 * it), but Bryntum keeps each client's own row order when it applies another client's move, indent,
 * outdent or paste: the rows then sat out of WBS order everywhere but on the editing client, and a
 * snapshot's row order depended on which client saved it. Rows follow the ordered tree here, after
 * every applied changeset and every load, unless the user sorted the view.
 */
export function rowsFollowOrderedTree(store: OrderedTreeStore, parents: OrderedNode[]): void {
  if (store.isSorted) {
    return;
  }
  let moved = false;
  for (const parent of parents) {
    parent.traverse((node) => {
      if (node.isLeaf) {
        return;
      }
      const children = Array.isArray(node.children) ? node.children : undefined;
      if (!followsOrder(children) || !followsOrder(node.unfilteredChildren)) {
        node.sortVisibleChildren(byOrderedIndex, false);
        node.sortUnfilteredChildren(byOrderedIndex, false);
        moved = true;
      }
    });
  }
  if (moved) {
    // What a sorted store does after applying a changeset: rebuild the visible rows, then refresh.
    store.storage.replaceValues({ values: store.collectDescendants(store.rootNode).visible, silent: true });
    store.afterPerformSort(false);
  }
}

/** Ranks the children the revision placed, from the order the clients share: see `CollabProjectModel.settleOwnOrder`. */
export function settleOrder(store: OrderedTreeStore, confirmed: Map<OrderedNode, number>, input: { added?: Record<string, unknown>[]; updated?: Record<string, unknown>[] }): void {
  const sent = new Map<OrderedNode, number>();
  const parents = new Set<OrderedNode>();
  for (const entry of [...(input.added ?? []), ...(input.updated ?? [])]) {
    if (typeof entry.orderedParentIndex !== 'number') continue;
    const record = store.getById(entry.id) ?? store.getById(entry[PHANTOM_ID_FIELD]);
    if (!record) continue;
    sent.set(record, entry.orderedParentIndex);
    if (record.parent) parents.add(record.parent);
  }
  let moved = false;
  for (const parent of parents) {
    const intended = (child: OrderedNode) => sent.get(child) ?? confirmed.get(child) ?? child.orderedParentIndex;
    (parent.orderedChildren ?? [])
      .map((child, index) => ({ child, index }))
      .sort((a, b) => intended(a.child) - intended(b.child) || Number(sent.has(a.child)) - Number(sent.has(b.child)) || byTaskId(a.child, b.child) || a.index - b.index)
      .forEach(({ child }, rank) => {
        confirmed.set(child, rank);
        if (child.orderedParentIndex !== rank) {
          child.setData('orderedParentIndex', rank);
          moved = true;
        }
      });
  }
  if (!moved) return;
  rowsFollowOrderedTree(store, [...parents]);
  for (const parent of parents) (parent as OrderedNode & { refreshWbs(options: unknown): void }).refreshWbs({ deep: true, useOrderedTree: true });
}
