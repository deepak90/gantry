/**
 * Task bars as physical blocks, and the work behind them as a scale model. It comes up once the chart has settled, so
 * three.js and the models never compete with the plan's first load. `?fx=off` in the link leaves it out, and without
 * WebGL the chart simply stays as it is.
 *
 * What it is for: reviewing a payment. The chart is where the plan is made; a room is where someone decides whether to
 * pay, by seeing what the money covers, what the plan has by a date and what has been reported done. Its building is
 * drawn from the plan's task names, not from a design model.
 *
 * The ways in:
 * - right-click a bar, Open 3D view: the camera falls through the bar into a room with its work, at its dates;
 * - the Site board button in the toolbar: the whole plan as a site, scrubbed by date (site-view.ts).
 *
 * A double-click on a bar stays the task editor.
 */
import type { Gantt, TaskModel } from '@bryntum/gantt';
import type { LookState } from '../look';
import type { PanelTab } from './side-panel';
import type { SiteControl } from './site-view';

export type { SiteControl };

export interface TheaterOptions {
  gantt: Gantt;
  look: () => LookState;
  editTask: (task: TaskModel) => void;
  /** Opens the fix and payment for a task, for those who may act on them. */
  openFix?: (task: TaskModel) => void;
  /** Brings a tab of the side panel forward; says false when this person doesn't have it. */
  showPanelTab: (tab: PanelTab) => boolean;
  /** Whether this person has an assistant, which can change after opening. */
  hasAssistant: () => boolean;
  /** Selects a task in the plan. */
  selectTask: (task: TaskModel) => void;
}

export interface Theater {
  /** The plan, or what is known about it, changed. */
  planChanged(): void;
  /** Tasks someone pointed at from outside the scene: if it is open, it goes to them. Otherwise nothing. */
  show(taskIds: readonly number[]): void;
  /** Opens the site view, as its button does; resolves with whether it is open. Absent where there is no 3D. */
  openSite?(): Promise<boolean>;
  /** Back to the chart, as the Chart button does. */
  closeSite?(): void;
  /** Whether the site view is on screen (or on its way in or out). */
  siteOpen?(): boolean;
  /** Up and still: not flying in from the chart or back out to it. */
  siteSettled?(): boolean;
  /** The tower crane's days on the lot, the view from up on it, or back down: false when there is no crane to show. */
  crane?(look: 'days' | 'ride' | 'down'): boolean;
  /** The building's days and levels while the site view is open (null otherwise, or for the site board). */
  siteControl?(): SiteControl | null;
  destroy(): void;
}

export const fx3dEnabled = new URLSearchParams(window.location.search).get('fx') !== 'off';

const whenIdle = (run: () => void): (() => void) => {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: 3000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, 1000);
  return () => window.clearTimeout(handle);
};

/** Starts the theater for a mounted Gantt. */
export function attachBarTheater(options: TheaterOptions): Theater {
  if (!fx3dEnabled) return { planChanged: () => {}, show: () => {}, destroy: () => {} };
  let destroyed = false;
  let theater: Theater | undefined;
  const cancel = whenIdle(() => {
    void import('./theater').then(({ createTheater }) => {
      if (destroyed) return;
      theater = createTheater(options);
    });
  });
  return {
    planChanged: () => theater?.planChanged(),
    show: (taskIds) => theater?.show(taskIds),
    openSite: async () => (theater?.openSite ? theater.openSite() : false),
    closeSite: () => theater?.closeSite?.(),
    siteOpen: () => theater?.siteOpen?.() ?? false,
    siteSettled: () => theater?.siteSettled?.() ?? false,
    crane: (look) => theater?.crane?.(look) ?? false,
    siteControl: () => theater?.siteControl?.() ?? null,
    destroy: () => {
      destroyed = true;
      cancel();
      theater?.destroy();
    },
  };
}
