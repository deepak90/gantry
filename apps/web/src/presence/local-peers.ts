/**
 * People who are in this page only: the simulated teammates the walkthrough shows
 * (crowd/in-page-team.ts). Each of them is a presence session on an in-memory channel, `localPeers`,
 * which this page's own presence session listens to and talks on beside its real channel
 * (`withLocalPeers`). So the header avatars, the pointers, the selected cells and the row tags show
 * them like anyone else, while nothing of theirs leaves the page: nobody else sees them, and having no
 * copy of the plan, they cannot change it.
 *
 * The plan on screen is registered here too (PresenceLayer does it), for those people to point at.
 */
import type { Gantt } from '@bryntum/gantt';
import { InMemoryPresenceHub } from './in-memory-presence';
import { byArrival } from './peers';
import type { Peer } from './protocol';
import type { PresenceViewport } from './session';
import type { PresenceTransport } from './transport';

/** This page's own presence channel. */
export const localPeers = new InMemoryPresenceHub();

/**
 * `transport` with this page's own people added: the session hears both channels, everyone on them
 * in one list, and what it sends goes to both, so page-local people see its selection too. Its
 * connection status is the real channel's. Sends to the page's channel are skipped while nobody else
 * is on it.
 */
export function withLocalPeers(transport: PresenceTransport, session: string, hub: InMemoryPresenceHub = localPeers): PresenceTransport {
  const local = hub.connect(session);
  let remote: Peer[] = [];
  let here: Peer[] = [];
  const company = () => here.some((peer) => peer.session !== session);
  return {
    connect(handlers) {
      const everyone = () => {
        const seen = new Set(remote.map((peer) => peer.session));
        handlers.onPeers([...remote, ...here.filter((peer) => !seen.has(peer.session))].sort(byArrival));
      };
      transport.connect({
        ...handlers,
        onPeers: (peers) => {
          remote = peers;
          everyone();
        },
      });
      local.connect({
        ...handlers,
        onStatus: () => undefined,
        onPeers: (peers) => {
          here = peers;
          everyone();
        },
      });
    },
    track(me) {
      transport.track(me);
      local.track(me);
    },
    sendCursor(message) {
      transport.sendCursor(message);
      if (company()) local.sendCursor(message);
    },
    sendFrame(frame) {
      transport.sendFrame(frame);
      if (company()) local.sendFrame(frame);
    },
    requestFrame(request) {
      transport.requestFrame(request);
      if (company()) local.requestFrame(request);
    },
    sendState(message) {
      transport.sendState(message);
      if (company()) local.sendState(message);
    },
    disconnect() {
      transport.disconnect();
      local.disconnect();
    },
  };
}

/** The plan on this page's screen, and its view as presence reads it. */
export interface ShownPlan {
  gantt: Gantt;
  viewport: PresenceViewport;
}

let shown: ShownPlan | null = null;
const listeners = new Set<() => void>();

/** Registers the plan on screen (PresenceLayer); the returned function takes it back. */
export function setShownPlan(plan: ShownPlan): () => void {
  shown = plan;
  for (const listener of [...listeners]) listener();
  return () => {
    if (shown !== plan) return;
    shown = null;
    for (const listener of [...listeners]) listener();
  };
}

/** The plan on screen now, or null (none open, or between projects). */
export function shownPlan(): ShownPlan | null {
  return shown;
}

export function onShownPlan(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How many simulated teammates the address asks for (`?team=2`, `?team` for 2): 1 to 3, or null. */
export function teamSizeFrom(search: string): number | null {
  const params = new URLSearchParams(search);
  if (!params.has('team')) return null;
  const raw = params.get('team');
  const count = raw === '' || raw === null ? 2 : Number(raw);
  return Number.isFinite(count) && count >= 1 ? Math.min(3, Math.floor(count)) : null;
}
