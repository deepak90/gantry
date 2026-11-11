/**
 * Dragging a library card onto the Gantt (Bryntum's DragHelper, as in its "drag from grid" demo).
 *
 * While the card is over a row, a line or outline on the row shows where the snippet lands (between
 * rows: above or below the row; the middle of a phase or work package row: at its end), and the card
 * says where in words. Releasing hands the place and the release point to `onDrop`; the library panel
 * then asks how to tie the work in, with what each way would move. The row stays marked until the
 * panel calls `release`. A card released on a folder of the library is filed there instead.
 * Nothing here changes the project.
 */
import { DragHelper } from '@bryntum/gantt';
import type { Gantt, Model, TaskModel } from '@bryntum/gantt';
import { isGeneratedParent, original } from '../gantt/look';
import { describePlace, zoneFor } from './describe';
import { placementFor, type DropZone, type Placement } from './insert';

/** Where the card was let go, and how to clear the row's drop mark once the panel is done with it. */
export interface DropPoint {
  x: number;
  y: number;
  release(): void;
}

export interface SnippetDragOptions {
  gantt: Gantt;
  /** The element holding the cards (`.library-grab` elements inside `[data-snippet-id]` cards). */
  container: HTMLElement;
  /** Name, icon and size shown on the dragged card. */
  cardFor(snippetId: string): { name: string; icon: string; detail: string } | null;
  onDrop(placement: Placement, snippetId: string, at: DropPoint): void;
  /** A card dropped on a folder of the library panel (`[data-folder-drop]`): file it there. */
  onFile?(snippetId: string, folderId: string | null): void;
}

interface Row {
  addCls(cls: string): void;
  removeCls(cls: string): void;
  getElement(region: string): HTMLElement;
}

interface DragContext {
  element: HTMLElement;
  grabbed: HTMLElement;
  target: HTMLElement | null;
  valid: boolean;
}

const ROW_CLASSES: Record<DropZone, string> = {
  before: 'library-drop-before',
  after: 'library-drop-after',
  'first-child': 'library-drop-after',
  inside: 'library-drop-inside',
};

/** Marks the rows of these tasks (those drawn now) with `cls`; returns the function that clears it. */
export function markRows(gantt: Gantt, tasks: readonly TaskModel[], cls: string): () => void {
  // Rows off screen are not drawn: getRowFor gives undefined for them.
  const rows = tasks.map((task) => gantt.getRowFor(task as unknown as Model) as unknown as Row | null | undefined).filter((row): row is Row => Boolean(row));
  for (const row of rows) row.addCls(cls);
  return () => {
    if (!gantt.isDestroyed) for (const row of rows) row.removeCls(cls);
  };
}

/** Starts listening for card drags; returns the function that stops it. */
export function attachSnippetDrag(options: SnippetDragOptions): () => void {
  const { gantt } = options;
  let marked: { row: Row; cls: string } | null = null;
  let placement: Placement | null = null;

  const features = gantt.features as unknown as { taskTooltip?: { disabled: boolean } };

  const clearMark = () => {
    marked?.row.removeCls(marked.cls);
    marked = null;
  };
  const setHint = (context: DragContext, where: string, placed = false) => {
    const hint = context.element.querySelector<HTMLElement>('.library-drag-hint');
    if (hint) hint.textContent = where;
    context.element.classList.toggle('is-placed', placed);
  };

  const helper = new DragHelper({
    cloneTarget: true,
    autoSizeClonedTarget: false,
    targetSelector: '.library-grab',
    ignoreSelector: 'input, select, textarea, button',
    dropTargetSelector: `#${CSS.escape(gantt.id)} .b-grid-sub-grid, [data-folder-drop]`,
    outerElement: options.container,
    scrollManager: (gantt as Gantt & { scrollManager: never }).scrollManager,
    createProxy(element: HTMLElement) {
      const id = element.closest<HTMLElement>('[data-snippet-id]')?.dataset.snippetId ?? '';
      const card = options.cardFor(id);
      const proxy = document.createElement('div');
      proxy.className = 'card is-selected library-drag-proxy';
      const head = document.createElement('div');
      head.className = 'library-drag-head';
      const icon = document.createElement('i');
      icon.className = `fa fa-${card?.icon ?? 'cubes'}`;
      const name = document.createElement('strong');
      name.textContent = card?.name ?? 'Snippet';
      const detail = document.createElement('span');
      detail.textContent = card?.detail ?? '';
      head.append(icon, name, detail);
      const hint = document.createElement('div');
      hint.className = 'library-drag-hint';
      hint.textContent = 'Drop it on a row of the plan';
      proxy.append(head, hint);
      return proxy;
    },
    listeners: {
      dragStart({ context, event }: { context: DragContext; event: MouseEvent }) {
        // The card follows the pointer from below and to the right, leaving the row it is over in sight.
        const box = context.element.getBoundingClientRect();
        context.element.style.marginLeft = `${Math.round(event.clientX - box.left + 18)}px`;
        context.element.style.marginTop = `${Math.round(event.clientY - box.top + 16)}px`;
        // Moving the pointer with the button down would otherwise select text across the page.
        window.getSelection()?.removeAllRanges();
        document.body.classList.add('library-dragging');
        if (features.taskTooltip) features.taskTooltip.disabled = true;
        gantt.enableScrollingCloseToEdges(gantt.subGrids.locked as never);
      },
      drag({ context, event }: { context: DragContext; event: MouseEvent }) {
        try {
          const target = context.target;
          clearMark();
          placement = null;
          // Over a folder of the library panel: file the snippet there.
          const folder = target?.closest<HTMLElement>('[data-folder-drop]');
          if (folder) {
            setHint(context, `File it in “${folder.dataset.folderName ?? 'the library'}”`, true);
            return;
          }
          if (gantt.readOnly) {
            context.valid = false;
            setHint(context, 'You can look at this plan but not change it');
            return;
          }
          const shown = context.valid && target ? (gantt.resolveTaskRecord(target) as TaskModel | null) : null;
          if (!shown || isGeneratedParent(shown)) {
            context.valid = false;
            setHint(context, 'Drop it on a row of the plan');
            return;
          }
          const row = gantt.getRowFor(shown as unknown as Model) as unknown as Row | null;
          if (!row) return;
          const rect = row.getElement('normal').getBoundingClientRect();
          const task = original(shown);
          const expanded = !task.isLeaf && Boolean((shown as TaskModel & { isExpanded(store: unknown): boolean }).isExpanded(gantt.store));
          const zone = zoneFor((event.clientY - rect.top) / Math.max(1, rect.height), task.isLeaf, expanded);
          placement = placementFor(task, zone);
          marked = { row, cls: ROW_CLASSES[zone] };
          row.addCls(marked.cls);
          setHint(context, describePlace(placement), true);
        } catch (error) {
          // Bryntum swallows listener errors; make them visible.
          console.error('Library drag failed', error);
        }
      },
      drop({ context, event }: { context: DragContext; event: MouseEvent }) {
        const chosen = placement;
        const id = context.grabbed.closest<HTMLElement>('[data-snippet-id]')?.dataset.snippetId;
        gantt.disableScrollingCloseToEdges(gantt.subGrids.locked as never);
        const folder = context.target?.closest<HTMLElement>('[data-folder-drop]');
        if (folder && id) {
          options.onFile?.(id, folder.dataset.folderDrop || null);
          return;
        }
        if (context.valid && chosen && id) {
          // The row keeps its mark while the panel asks how to tie the work in.
          const kept = marked;
          marked = null;
          options.onDrop(chosen, id, { x: event.clientX, y: event.clientY, release: () => kept?.row.removeCls(kept.cls) });
        }
      },
      reset() {
        clearMark();
        placement = null;
        document.body.classList.remove('library-dragging');
        if (features.taskTooltip) features.taskTooltip.disabled = false;
      },
    },
  } as never);

  return () => {
    clearMark();
    helper.destroy();
  };
}

/** The flash that last lit each task's row, per chart: a later flash keeps a row an earlier one's timer would clear. */
const litRows = new WeakMap<Gantt, Map<unknown, number>>();
let flashCount = 0;

/** Briefly marks the rows of new tasks (those currently drawn). */
export function flashRows(gantt: Gantt, tasks: readonly TaskModel[], ms = 2600): void {
  const cls = 'library-new-row';
  const rowOf = (task: TaskModel) => gantt.getRowFor(task as unknown as Model) as unknown as Row | null;
  const flash = ++flashCount;
  const lit = litRows.get(gantt) ?? new Map<unknown, number>();
  litRows.set(gantt, lit);
  for (const task of tasks) {
    lit.set(task.id, flash);
    rowOf(task)?.addCls(cls);
  }
  setTimeout(() => {
    if (gantt.isDestroyed) return;
    // A row lit again since by a later flash stays lit for that one.
    for (const task of tasks) {
      if (lit.get(task.id) !== flash) continue;
      lit.delete(task.id);
      rowOf(task)?.removeCls(cls);
    }
    if (lit.size > 0) return;
    // Nothing left lit: every row is cleared, for one scrolled on to another task in the meantime.
    const rows = (gantt as Gantt & { rowManager?: { rows: Row[] } }).rowManager?.rows ?? [];
    rows.forEach((row) => row.removeCls(cls));
  }, ms);
}
