/**
 * "Try these" on the page (try-these.ts): the list for this person, ticked from the session's own data, from a
 * teammate in the session (presence: anyone else here, or a follow either way), and from the 3D view coming up (the
 * page's `data-fx3d`, theater.ts). The workspace ticks the rest as they happen here (`mark`): the call joined, Remy's
 * answer and the odds worked out in this browser. Each item done is counted once (`try_item_done`).
 *
 * "Show me" picks the item at hand (`pick`); once it is done, the next one left after it is.
 */
import type { ProjectModel } from '@bryntum/gantt';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { report } from '../copy/report';
import type { PresenceSession } from '../presence/session';
import type { WorkflowSnapshot } from '../workflow/api';
import { currentItem, railOrder, tryFactsOf, tryItemsFor, TryTheseTracker, type TryContext, type TryItemView, type TryKey } from './try-these';

export type { TryItemView } from './try-these';

export interface TryTheseOptions {
  /** On the hosted site only. */
  enabled: boolean;
  /** Where this session's ticks are kept in this browser. */
  storageKey: string | null;
  project: ProjectModel;
  snapshot: WorkflowSnapshot | null;
  /** Bumped when the plan's data changes. */
  dataVersion: number;
  presence: PresenceSession | null;
  context: TryContext;
}

export interface TryThese {
  /** The items in their listed order. */
  items: readonly TryItemView[];
  /** The item at hand, or null when every one is done. */
  current: TryItemView | null;
  /** The items as the counter in the header turns through them (try-these.ts `railOrder`). */
  rail: readonly TryItemView[];
  /** The item happened here. */
  mark(key: TryKey): void;
  /** "Show me": this item is the one at hand. */
  pick(key: TryKey): void;
}

export function useTryThese({ enabled, storageKey, project, snapshot, dataVersion, presence, context }: TryTheseOptions): TryThese {
  const tracker = useMemo(() => new TryTheseTracker({ storageKey: enabled ? storageKey : null, onDone: (key) => report('try_item_done', { item: key }) }), [enabled, storageKey]);
  const done = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);
  const [picked, setPicked] = useState<TryKey | null>(null);

  // The session's own data: a library piece on level 1, the tenant invoice sent, a payment hold paid (and the crane's rental, unlisted for now).
  useEffect(() => {
    if (enabled) tracker.sync(tryFactsOf(project, snapshot));
  }, [enabled, tracker, project, snapshot, dataVersion]);

  // A teammate in the session: anyone else here, or following someone, or being followed.
  useEffect(() => {
    if (!enabled || !presence || tracker.has('invite')) return undefined;
    const check = () => {
      const { peers, following, followers } = presence.getSnapshot();
      if (peers.length > 0 || following || followers.length > 0) tracker.mark('invite');
    };
    check();
    return presence.subscribe(check);
  }, [enabled, presence, tracker]);

  // The 3D view: the page says which view is up (flat, site or building).
  useEffect(() => {
    if (!enabled || tracker.has('site') || typeof MutationObserver === 'undefined') return undefined;
    const root = document.documentElement;
    const check = () => {
      const view = root.dataset.fx3d;
      if (view === 'site' || view === 'building') tracker.mark('site');
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(root, { attributes: true, attributeFilter: ['data-fx3d'] });
    return () => observer.disconnect();
  }, [enabled, tracker]);

  const { flags, calls, assistant, site, seesCosts, pays } = context;
  const items = useMemo(
    () => (enabled ? tryItemsFor({ flags, calls, assistant, site, seesCosts, pays }).map((item) => ({ ...item, done: done.has(item.key) })) : []),
    [enabled, flags, calls, assistant, site, seesCosts, pays, done],
  );
  const current = useMemo(() => currentItem(items, picked), [items, picked]);
  const rail = useMemo(() => railOrder(items, done, current?.key ?? null), [items, done, current]);
  return { items, current, rail, mark: tracker.mark, pick: setPicked };
}
