/**
 * This browser's other Gantry tabs on the same session, as one tab hears them: whether one of them is in front. Each tab
 * says, over a BroadcastChannel named for the session's project, whether it is in front when that changes, and every
 * two seconds while it is. The away rule (away.ts) asks: a call tab sent to the background while a teammate's tab
 * (opened from Invite, as Remy suggests for a second approval) is in front isn't away. Tabs on other machines are their
 * own; a browser without BroadcastChannel hears nobody.
 */

/** How often a tab in front says so. */
export const TAB_HEARTBEAT_MS = 2_000;
/** A tab not heard from in this long isn't counted as in front. */
export const TAB_FRESH_MS = 5_000;

/** What a tab says. */
export interface TabWord {
  tab: string;
  front: boolean;
  at: number;
}

/** The part of a BroadcastChannel this uses. */
export interface TabChannel {
  postMessage(word: TabWord): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

/** The part of `document` this uses. */
export interface TabPage {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface Tabs {
  /** Another of this session's tabs is in front, in this browser. */
  othersInFront(): boolean;
  stop(): void;
}

const NOBODY: Tabs = { othersInFront: () => false, stop: () => undefined };

/** The channel the session's tabs talk on. */
export const tabChannelName = (projectId: string) => `gantry-tabs-${projectId}`;

export function watchTabs(
  projectId: string,
  {
    page = typeof document === 'undefined' ? null : document,
    channel = typeof BroadcastChannel === 'undefined' ? null : (new BroadcastChannel(tabChannelName(projectId)) as unknown as TabChannel),
    now = () => Date.now(),
    tab = Math.random().toString(36).slice(2),
    setTimer = setInterval,
    clearTimer = clearInterval,
  }: { page?: TabPage | null; channel?: TabChannel | null; now?: () => number; tab?: string; setTimer?: typeof setInterval; clearTimer?: typeof clearInterval } = {},
): Tabs {
  if (!page || !channel) return NOBODY;
  const heard = new Map<string, { front: boolean; at: number }>();
  const say = () => channel.postMessage({ tab, front: !page.hidden, at: now() });
  channel.addEventListener('message', (event) => {
    const word = event.data as Partial<TabWord> | null;
    if (!word || typeof word.tab !== 'string' || word.tab === tab || typeof word.front !== 'boolean') return;
    heard.set(word.tab, { front: word.front, at: now() });
  });
  page.addEventListener('visibilitychange', say);
  const beat = setTimer(() => {
    if (!page.hidden) say();
  }, TAB_HEARTBEAT_MS);
  say();
  return {
    othersInFront: () => [...heard.values()].some((other) => other.front && now() - other.at <= TAB_FRESH_MS),
    stop: () => {
      clearTimer(beat);
      page.removeEventListener('visibilitychange', say);
      try {
        channel.postMessage({ tab, front: false, at: now() });
        channel.close();
      } catch {
        // Already closed.
      }
    },
  };
}
