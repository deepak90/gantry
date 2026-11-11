/**
 * Drag a crew from the side panel onto the plan: drop it on a task bar, or anywhere on a task's row,
 * and the crew is put on that task. Built on Bryntum's DragHelper (the pattern of its "drag
 * resources from a grid" demo): the card is cloned into a small proxy with the crew's logo, the
 * task under the pointer lights up (green: it can take the crew; red: it cannot, and the proxy says
 * why), and a drop adds one assignment in its own project transaction, so it reaches everyone as
 * one revision. A short pulse on the bar confirms it.
 */
import { DragHelper, StringHelper, Toast } from '@bryntum/gantt';
import type { Gantt, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { runProjectTransaction } from '../scenario/publish';
import { crewColor, crewIcon, crewOf, isGeneratedParent, original } from './look';

export interface CrewDropVerdict {
  ok: boolean;
  /** One plain line for the drag proxy: what a drop here does, or why it does nothing. */
  message: string;
}

/** Whether `crew` can be dropped on `task` (a row or bar of the Gantt, possibly a grouped copy). */
export function crewDropVerdict(task: TaskModel | null | undefined, crew: ResourceModel, readOnly = false): CrewDropVerdict {
  const crewName = crew.name || 'This crew';
  if (!task || isGeneratedParent(task)) {
    return { ok: false, message: 'Drop on a task in the plan' };
  }
  const record = original(task);
  const name = record.name || 'this task';
  if (readOnly) {
    return { ok: false, message: 'The plan is read-only' };
  }
  if (!record.isLeaf) {
    return { ok: false, message: `“${name}” is a group of tasks: drop on one of them` };
  }
  if (record.isMilestone) {
    return { ok: false, message: `“${name}” is a milestone, with no work to do` };
  }
  if (crewOf(record).includes(crew)) {
    return { ok: false, message: `Already on “${name}”` };
  }
  return { ok: true, message: `Put ${crewName} on “${name}”` };
}

/**
 * Puts the crew on the task in one project transaction (one revision for everyone). Resolves false
 * when there was nothing to do: the crew was already on it (another person may have just added
 * it). Rejects when the task or the crew no longer exists.
 */
export async function assignCrew(project: ProjectModel, task: TaskModel, crew: ResourceModel): Promise<boolean> {
  const record = original(task);
  let added = false;
  await runProjectTransaction(project, 'Assign crew', () => {
    // Checked inside the queue: a revision applied since the drag started may have changed things.
    if (project.taskStore.getById(record.id) !== record) throw new Error(`“${record.name ?? 'The task'}” has been deleted`);
    if (project.resourceStore.getById(crew.id) !== crew) throw new Error(`${crew.name ?? 'The crew'} has been removed`);
    if (crewOf(record).includes(crew)) return;
    project.assignmentStore.add({ event: record, resource: crew, units: 100 } as object);
    added = true;
  });
  return added;
}

export interface CrewDragOptions {
  /** The element holding the crew cards; each card carries `data-crew-id`. Drags start here. */
  source: HTMLElement;
  project: ProjectModel;
  /** The Gantt to drop onto (read when a drag starts, so it may appear after this is attached). */
  gantt(): Gantt | undefined;
  /** The crew a card stands for. */
  crewFor(card: HTMLElement): ResourceModel | null;
  /** A drop that could not be saved. */
  onError?(message: string): void;
}

/** Elements inside a card that keep their own pointer behavior (typing, buttons). */
const NOT_A_HANDLE = 'input, textarea, select, button, a, [data-no-drag]';
const TARGET_CLS = 'crew-drop-target';

interface DragContext {
  element: HTMLElement;
  grabbed: HTMLElement;
  target?: HTMLElement | null;
  valid: boolean;
  crew?: ResourceModel | null;
  /** The record under the pointer, as the Gantt shows it (a linked copy while grouped). */
  shown?: TaskModel | null;
  verdict?: CrewDropVerdict;
}

interface ScrollingGantt {
  scrollManager?: unknown;
  timeAxisSubGrid?: unknown;
  enableScrollingCloseToEdges?(subGrid: unknown): void;
  disableScrollingCloseToEdges?(subGrid: unknown): void;
}

/** The little card that follows the pointer: the crew's logo (or icon), its name and the verdict. */
export function crewProxy(crew: ResourceModel): HTMLElement {
  const proxy = document.createElement('div');
  proxy.className = 'crew-drag-proxy';
  proxy.style.setProperty('--crew', crewColor(crew));
  const badge = document.createElement('span');
  badge.className = 'crew-drag-badge';
  const icon = document.createElement('i');
  icon.className = `fa fa-${crewIcon(crew)}`;
  badge.append(icon);
  if (typeof crew.imageUrl === 'string' && crew.imageUrl) {
    const img = document.createElement('img');
    img.src = crew.imageUrl;
    img.alt = '';
    badge.append(img);
  }
  const text = document.createElement('span');
  text.className = 'crew-drag-text';
  const name = document.createElement('strong');
  name.textContent = crew.name ?? '';
  const hint = document.createElement('span');
  hint.className = 'crew-drag-hint';
  hint.textContent = 'Drop on a task in the plan';
  text.append(name, hint);
  proxy.append(badge, text);
  return proxy;
}

/** The elements that show `shown` in the Gantt: its row (both halves) and its bar. */
function taskElements(gantt: Gantt, shown: TaskModel): HTMLElement[] {
  const elements: HTMLElement[] = [];
  const row = gantt.getRowFor(shown);
  if (row) elements.push(...Object.values(row.elements));
  const bar = gantt.getElementFromTaskRecord(shown, false) as HTMLElement | null;
  if (bar) elements.push(bar);
  return elements;
}

function clearHighlight(root: HTMLElement | undefined): void {
  root?.querySelectorAll(`.${TARGET_CLS}`).forEach((element) => element.classList.remove(TARGET_CLS, 'is-valid', 'is-invalid'));
}

/** The part of `element` inside every one of `clips` (the plan scrolls and clips its bars), or null when hidden. */
function visibleRect(element: Element | null | undefined, clips: (Element | null | undefined)[]): DOMRect | null {
  if (!element?.isConnected) return null;
  let { left, top, right, bottom } = element.getBoundingClientRect();
  for (const clip of clips) {
    if (!clip) continue;
    const box = clip.getBoundingClientRect();
    left = Math.max(left, box.left);
    top = Math.max(top, box.top);
    right = Math.min(right, box.right);
    bottom = Math.min(bottom, box.bottom);
  }
  return right - left > 4 && bottom - top > 4 ? new DOMRect(left, top, right - left, bottom - top) : null;
}

/**
 * A ring that pulses around the bar and a chip that rises from it ("Electricians added"); around the
 * task's row instead when its bar is scrolled out of sight.
 */
export function pulseTask(gantt: Gantt, shown: TaskModel, crew: ResourceModel): void {
  const view = gantt as Gantt & { bodyContainer?: HTMLElement; timeAxisSubGrid?: { element?: HTMLElement } };
  const rect =
    visibleRect(gantt.getElementFromTaskRecord(shown, true), [view.timeAxisSubGrid?.element, view.bodyContainer]) ??
    visibleRect(gantt.getRowFor(shown)?.elements.locked, [gantt.getSubGrid('locked')?.element, view.bodyContainer]);
  if (!rect) return;
  const layer = document.createElement('div');
  layer.className = 'crew-drop-pulse';
  layer.style.setProperty('--crew', crewColor(crew));
  Object.assign(layer.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  const chip = document.createElement('span');
  chip.className = 'crew-drop-chip';
  chip.textContent = `${crew.name ?? 'Crew'} added`;
  layer.append(chip);
  document.body.append(layer);
  window.setTimeout(() => layer.remove(), 1600);
}

/**
 * Lets crew cards inside `source` be dragged onto the Gantt. Returns the function that detaches it.
 */
export function attachCrewDrag({ source, project, gantt, crewFor, onError }: CrewDragOptions): () => void {
  let active: Gantt | undefined;
  /** The task tooltip is paused while dragging: it would cover the bar the crew is dropped on. */
  let pausedTooltip: { disabled: boolean } | null = null;
  let highlighted: { shown: TaskModel | null; ok: boolean } | null = null;

  const highlight = (shown: TaskModel | null | undefined, ok: boolean) => {
    if (!active) return;
    if (!highlighted || highlighted.shown !== (shown ?? null) || highlighted.ok !== ok) {
      clearHighlight(active.element);
      highlighted = { shown: shown ?? null, ok };
    }
    // Re-applied on every move: Bryntum redraws rows and bars (scrolling, hover) and drops our class.
    if (shown) {
      for (const element of taskElements(active, shown)) element.classList.add(TARGET_CLS, ok ? 'is-valid' : 'is-invalid');
    }
  };

  const finish = () => {
    clearHighlight(active?.element);
    highlighted = null;
    if (pausedTooltip) {
      pausedTooltip.disabled = false;
      pausedTooltip = null;
    }
    if (active && !active.isDestroyed) {
      active.element.classList.remove('crew-dragging');
      const scrolling = active as unknown as ScrollingGantt;
      scrolling.disableScrollingCloseToEdges?.(scrolling.timeAxisSubGrid);
    }
    active = undefined;
  };

  const helper = new DragHelper({
    cloneTarget: true,
    autoSizeClonedTarget: false,
    // The proxy is free to leave the panel and travel over the plan.
    constrain: false,
    outerElement: source,
    targetSelector: '[data-crew-id]',
    isElementDraggable: (element: HTMLElement) => Boolean(element.closest('[data-crew-id]')) && !element.closest(NOT_A_HANDLE),
    dropTargetSelector: '.b-gantt .b-grid-row, .b-gantt .b-gantt-task-wrap',
    createProxy: (element: HTMLElement) => {
      const crew = crewFor(element.closest<HTMLElement>('[data-crew-id]') ?? element);
      return crew ? crewProxy(crew) : (element.cloneNode(true) as HTMLElement);
    },
    listeners: {
      beforeDragStart: ({ context }: { context: DragContext }) => {
        const crew = crewFor(context.element.closest<HTMLElement>('[data-crew-id]') ?? context.element);
        const instance = gantt();
        if (!crew || !instance || instance.isDestroyed) return false;
        context.crew = crew;
        active = instance;
        // Scrolls the plan when the proxy nears its edges, as Bryntum's own drags do.
        const scrolling = instance as unknown as ScrollingGantt;
        (helper as unknown as { scrollManager: unknown }).scrollManager = scrolling.scrollManager;
        return true;
      },
      dragStart: () => {
        if (!active) return;
        active.element.classList.add('crew-dragging');
        const tooltip = (active.features as unknown as Record<string, { disabled: boolean } | undefined>).taskTooltip;
        if (tooltip && !tooltip.disabled) {
          tooltip.disabled = true;
          pausedTooltip = tooltip;
        }
        const scrolling = active as unknown as ScrollingGantt;
        scrolling.enableScrollingCloseToEdges?.(scrolling.timeAxisSubGrid);
      },
      drag: ({ context }: { context: DragContext }) => {
        try {
          const crew = context.crew;
          const target = context.target ?? null;
          const inPlan = Boolean(active && crew && target && active.element.contains(target) && target.closest('.b-grid-row, .b-gantt-task-wrap'));
          const shown = inPlan && active ? (active.resolveTaskRecord(target as HTMLElement) as TaskModel | null) : null;
          const verdict = crew && shown ? crewDropVerdict(shown, crew, Boolean(active?.readOnly)) : { ok: false, message: 'Drop on a task in the plan' };
          context.valid = verdict.ok;
          context.shown = shown;
          context.verdict = verdict;
          highlight(shown, verdict.ok);
          const hint = context.element.querySelector('.crew-drag-hint');
          if (hint && hint.textContent !== verdict.message) hint.textContent = verdict.message;
          context.element.classList.toggle('is-valid', verdict.ok);
        } catch (error) {
          // Bryntum swallows listener errors; an invalid drop is the safe outcome.
          context.valid = false;
          console.error('Crew drag failed:', error);
        }
      },
      drop: async ({ context }: { context: DragContext }) => {
        const instance = active;
        const { crew, shown, verdict } = context;
        try {
          if (!context.valid || !instance || !crew || !shown) {
            // "Already on it" deserves a word; dropping elsewhere just slides the proxy home.
            if (crew && shown && verdict && /^Already/.test(verdict.message)) {
              Toast.show({ html: StringHelper.encodeHtml(`${crew.name ?? 'This crew'}: a${verdict.message.slice(1)}`), timeout: 2500 });
            }
            return;
          }
          // The proxy lands on the task's crew cell (or its bar) before the change is made.
          const crewColumn = (instance.columns as unknown as { getById(id: string): unknown }).getById('schedule-crew');
          const cell = crewColumn && !(crewColumn as { hidden?: boolean }).hidden ? instance.getCell({ record: shown, column: crewColumn } as never) : null;
          const avatars = cell?.querySelector('.look-avatars') as HTMLElement | null;
          const landing = avatars ?? cell ?? (instance.getElementFromTaskRecord(shown) as HTMLElement | null);
          if (landing?.isConnected) {
            // The proxy folds down to the badge and flies next to the task's other crews.
            context.element.classList.add('is-landing');
            await Promise.race([helper.animateProxyTo(landing, { align: avatars ? 'l50-r50' : 'c-c' }), new Promise((resolve) => setTimeout(resolve, 900))]);
          }
          assignCrew(project, shown, crew)
            .then((added) => {
              if (added && !instance.isDestroyed) pulseTask(instance, shown, crew);
            })
            .catch((error: unknown) => onError?.(error instanceof Error ? error.message : String(error)));
        } catch (error) {
          onError?.(error instanceof Error ? error.message : String(error));
        } finally {
          finish();
        }
      },
      abort: () => finish(),
      reset: () => finish(),
    },
  } as object as ConstructorParameters<typeof DragHelper>[0]);

  return () => {
    finish();
    helper.destroy();
  };
}
