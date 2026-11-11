/**
 * Presence drawn on the Gantt, in each person's color:
 *
 * - their pointer: an arrow with their name and what they are doing ("editing Schedule"), pinned to
 *   the edge with an arrow when it is scrolled out of view;
 * - their cell selection, like a shared spreadsheet: the selected cells tinted, one outline around each
 *   block of cells, and the cell their keyboard is on framed with a flag carrying their name (it shows
 *   the name for a moment after they move, stays open while they edit, and opens whenever this person
 *   points at any cell of their selection, as in Google Sheets);
 * - what they are about to change: the cells a fill will write (dashed), the bar they are moving,
 *   resizing or linking from (outlined), the row they are editing in the task panel;
 * - the row they have selected, when they have no cells selected (not while they follow someone: their selection
 *   is then the leader's, mirrored, and already drawn as the leader's);
 * - while following someone: a frame in their color with a way out.
 *
 * Mounted once per Gantt; it also plugs the Gantt into the presence session (view frames, pointer,
 * cell selection and activity), and registers it as the plan page-local people point at
 * (presence/local-peers.ts): `?team=2` brings two simulated teammates in (crowd/in-page-team.ts). Positions are recomputed every animation frame from task ids, columns
 * and dates, so everything stays on its task through this person's own scrolling, zooming and resizing.
 */
import type { Gantt, TaskModel } from '@bryntum/gantt';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ACTIVITY_ICONS, activityText, type Names } from './describe';
import {
  captureActivity,
  captureCursor,
  captureSelection,
  columnLabel,
  createGanttViewport,
  placeBar,
  placeCell,
  placePoint,
  placeRow,
  type CellBox,
  type LookBridge,
  type PlacedPoint,
} from './gantt-adapter';
import { setShownPlan, teamSizeFrom } from './local-peers';
import { initialsOf, readableInkOn } from './peers';
import { PointerPlayback, lerp, type PointerSpan } from './pointer-playback';
import { lookKey, type CursorPoint, type Peer } from './protocol';
import type { PresenceSession, PresenceSnapshot } from './session';
import { usePresenceSnapshot } from './usePresence';
import '../styles/presence.css';

export interface PresenceLayerProps {
  session: PresenceSession;
  /** The live Gantt; may be undefined until it has mounted. */
  gantt(): Gantt | undefined;
  /** How the toolbar draws the plan, so a follower can take the leader's grouping, filters and colors. */
  look?(): LookBridge | undefined;
}

const EDGE_ICONS = { above: 'arrow-up', below: 'arrow-down', left: 'arrow-left', right: 'arrow-right' } as const;
/** How long a cell flag shows the name after the person moves to another cell. */
const FLAG_MS = 2_500;

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const peerStyle = (peer: Peer) => ({ '--peer': peer.color, '--peer-ink': readableInkOn(peer.color) }) as CSSProperties;

/**
 * Subscribes to presence itself: pointers move up to 20 times a second, and only this layer and the
 * header avatars need to redraw for that, not the workspace around them.
 */
export function PresenceLayer({ session, gantt, look }: PresenceLayerProps) {
  const [mounted, setMounted] = useState<{ gantt: Gantt; layer: HTMLElement } | null>(null);
  const snapshot = usePresenceSnapshot(session);

  // Plug the Gantt in once it exists; unplug on unmount or when the session changes.
  useEffect(() => {
    let frame = 0;
    let cleanup: (() => void) | null = null;
    const attach = () => {
      const instance = gantt();
      const host = (instance as unknown as { element?: HTMLElement } | undefined)?.element;
      if (!instance || !host?.isConnected) {
        frame = requestAnimationFrame(attach);
        return;
      }
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      const layer = document.createElement('div');
      layer.className = 'presence-layer';
      layer.dataset.testid = 'presence-layer';
      host.appendChild(layer);
      const viewport = createGanttViewport(instance, look?.() ?? null);
      session.attachViewport(viewport);
      const stopCursor = captureCursor(instance, (point) => session.moveCursor(point));
      const stopSelection = captureSelection(instance, ({ cells, active }) => session.setCellSelection(cells, active));
      const stopActivity = captureActivity(instance, (activity) => session.setActivity(activity));
      // What this plan shows, in the same words a frame uses: lets two windows be compared (and debugged).
      const describe = () => {
        const view = viewport.read();
        layer.dataset.viewPreset = view?.preset ?? '';
        layer.dataset.viewCenter = view?.center ?? '';
        const anchor = view?.anchor ?? null;
        layer.dataset.viewAnchor = anchor ? ('taskId' in anchor ? String(anchor.taskId) : `g:${anchor.group}`) : '';
        layer.dataset.viewLook = view?.look ? lookKey(view.look) : '';
      };
      const offDescribe = viewport.onChange(describe);
      describe();
      const offShown = setShownPlan({ gantt: instance, viewport });
      setMounted({ gantt: instance, layer });
      cleanup = () => {
        offShown();
        offDescribe();
        stopActivity();
        stopSelection();
        stopCursor();
        session.attachViewport(null);
        viewport.dispose();
        layer.remove();
      };
    };
    attach();
    return () => {
      cancelAnimationFrame(frame);
      cleanup?.();
      setMounted(null);
    };
  }, [session, gantt, look]);

  // `?team=2`: simulated teammates on this page, for the walkthrough's opening and quick checks.
  useEffect(() => {
    const people = teamSizeFrom(window.location.search);
    if (!people) return undefined;
    let stop: (() => void) | null = null;
    let gone = false;
    void import('../crowd/in-page-team').then(({ startTeam }) => {
      if (!gone) stop = startTeam({ people }).stop;
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [session]);

  if (!mounted || !snapshot) return null;
  return createPortal(<Overlay session={session} snapshot={snapshot} gantt={mounted.gantt} layer={mounted.layer} />, mounted.layer);
}

/** Sessions whose cell flag shows their name: they moved to another cell a moment ago, or are doing something. */
function useOpenFlags(peers: readonly Peer[]): ReadonlySet<string> {
  const seen = useRef(new Map<string, { key: string; until: number }>());
  const [, setTick] = useState(0);
  const now = Date.now();
  let nextExpiry = Number.POSITIVE_INFINITY;
  const open = new Set<string>();
  for (const peer of peers) {
    const key = peer.active ? `${peer.active.taskId}:${peer.active.column}` : '';
    const known = seen.current.get(peer.session);
    if (!known || known.key !== key) seen.current.set(peer.session, { key, until: now + FLAG_MS });
    const until = seen.current.get(peer.session)!.until;
    if (peer.activity || until > now) open.add(peer.session);
    if (until > now) nextExpiry = Math.min(nextExpiry, until);
  }
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return undefined;
    const timer = setTimeout(() => setTick((tick) => tick + 1), Math.max(16, nextExpiry - Date.now()));
    return () => clearTimeout(timer);
  });
  return open;
}

interface Placeable {
  element: HTMLElement;
  box: { left: number; top: number; width: number; height: number } | null;
  cell?: CellBox | null;
}

/** A pointer between two of its positions, both placed on this screen and blended. */
function placeSpan(gantt: Gantt, span: PointerSpan<CursorPoint>, layer: HTMLElement): PlacedPoint | null {
  const from = placePoint(gantt, span.from, layer);
  const to = span.to === span.from || span.f <= 0 ? from : placePoint(gantt, span.to, layer);
  if (!from || !to) return to ?? from;
  const near = span.f < 0.5 ? from : to;
  return { x: lerp(from.x, to.x, span.f), y: lerp(from.y, to.y, span.f), edge: near.edge, folded: near.folded };
}

function Overlay({ session, snapshot, gantt, layer }: { session: PresenceSession; snapshot: PresenceSnapshot; gantt: Gantt; layer: HTMLElement }) {
  const peers = snapshot.peers;
  const byId = new Map(peers.map((peer) => [peer.session, peer]));
  const cursors = snapshot.cursors.filter((cursor) => byId.has(cursor.session));
  const points = useRef(new Map<string, CursorPoint>());
  points.current = new Map(cursors.map((cursor) => [cursor.session, cursor.point]));
  const openFlags = useOpenFlags(peers);

  // Every pointer update, as it arrives (not only those React renders), with when it was sent: pointers
  // are drawn a moment late, between two updates, so 5 to 20 updates a second glide instead of hopping.
  const playback = useRef(new PointerPlayback<CursorPoint>());
  useEffect(() => {
    const seen = new Map<string, number>();
    const feed = () => {
      const now = performance.now();
      const live = new Set<string>();
      for (const cursor of session.getSnapshot().cursors) {
        live.add(cursor.session);
        if (seen.get(cursor.session) === cursor.seq) continue;
        seen.set(cursor.session, cursor.seq);
        playback.current.push(cursor.session, cursor.point, now, cursor.t);
      }
      playback.current.retain(live);
      for (const key of [...seen.keys()]) if (!live.has(key)) seen.delete(key);
    };
    feed();
    return session.subscribe(feed);
  }, [session]);
  const names: Names = {
    task: (taskId) => ((gantt.project?.taskStore.getById(taskId) as TaskModel | undefined)?.name ?? null),
    column: (columnId) => columnLabel(gantt, columnId),
  };

  // Placement runs every frame while there is something to place: cheap for a handful of people.
  useEffect(() => {
    if (!layer.querySelector('[data-place]')) return undefined;
    let frame = 0;
    const place = () => {
      const layerRect = layer.getBoundingClientRect();
      const items: Placeable[] = [];
      // Read everything first, then write: no layout thrashing.
      for (const element of layer.querySelectorAll<HTMLElement>('[data-place]')) {
        const { place: kind, taskId, column, session: who } = element.dataset;
        const id = Number(taskId);
        if (kind === 'cursor') {
          const span = who ? playback.current.at(who, performance.now()) : null;
          const point = who ? points.current.get(who) : undefined;
          const placed = span ? placeSpan(gantt, span, layer) : point ? placePoint(gantt, point, layer) : null;
          items.push({ element, box: placed ? { left: placed.x, top: placed.y, width: 0, height: 0 } : null });
          element.dataset.edge = placed?.edge ?? '';
          element.dataset.folded = placed?.folded ? 'true' : '';
        } else if (kind === 'row') {
          items.push({ element, box: placeRow(gantt, id, layer) });
        } else if (kind === 'bar') {
          items.push({ element, box: placeBar(gantt, id, layer) });
        } else if (column) {
          const cell = placeCell(gantt, { taskId: id, column }, layer, layerRect);
          items.push({ element, box: cell, cell });
        }
      }
      // Outline each block of selected cells: an edge is drawn where the neighbor is not selected.
      const blocks = new Map<string, Set<string>>();
      for (const item of items) {
        const { place: kind, session: who } = item.element.dataset;
        if (!item.cell || (kind !== 'cell' && kind !== 'fill')) continue;
        const key = `${kind}:${who}`;
        const set = blocks.get(key) ?? new Set<string>();
        set.add(`${item.cell.row}:${item.cell.col}`);
        blocks.set(key, set);
      }
      for (const item of items) {
        const { element, box, cell } = item;
        element.hidden = !box;
        if (!box) continue;
        element.style.transform = `translate(${Math.round(box.left)}px, ${Math.round(box.top)}px)`;
        if (element.dataset.place !== 'cursor') {
          element.style.width = `${Math.round(box.width)}px`;
          element.style.height = `${Math.round(box.height)}px`;
        }
        if (cell && (element.dataset.place === 'cell' || element.dataset.place === 'fill')) {
          const set = blocks.get(`${element.dataset.place}:${element.dataset.session}`);
          const has = (row: number, col: number) => Boolean(set?.has(`${row}:${col}`));
          element.classList.toggle('edge-t', !has(cell.row - 1, cell.col));
          element.classList.toggle('edge-b', !has(cell.row + 1, cell.col));
          element.classList.toggle('edge-l', !has(cell.row, cell.col - 1));
          element.classList.toggle('edge-r', !has(cell.row, cell.col + 1));
        }
        if (element.dataset.place === 'cursor') {
          const icon = element.querySelector<HTMLElement>('.presence-edge-icon');
          const edge = element.dataset.edge as keyof typeof EDGE_ICONS | '';
          if (icon) icon.className = `presence-edge-icon fa fa-${edge ? EDGE_ICONS[edge] : 'arrow-up'}`;
        }
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  });

  // Pointing at someone's selected cells opens the name flag on their cell (the overlay itself takes
  // no pointer events, so the pointer is matched against the drawn boxes).
  useEffect(() => {
    let frame = 0;
    let pointed: string | null = null;
    let at: { x: number; y: number } | null = null;
    const mark = (who: string | null) => {
      if (who === pointed) return;
      for (const flagged of layer.querySelectorAll<HTMLElement>('.presence-active.is-pointed')) flagged.classList.remove('is-pointed');
      if (who) layer.querySelector<HTMLElement>(`.presence-active[data-session="${CSS.escape(who)}"]`)?.classList.add('is-pointed');
      pointed = who;
    };
    const check = () => {
      frame = 0;
      if (!at) return mark(null);
      const { x, y } = at;
      const hit = [...layer.querySelectorAll<HTMLElement>('.presence-active, .presence-cell:not(.is-fill)')].find((box) => {
        if (box.hidden) return false;
        const rect = box.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      });
      mark(hit?.dataset.session ?? null);
    };
    const move = (event: PointerEvent) => {
      at = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(check);
    };
    const leave = () => {
      at = null;
      if (!frame) frame = requestAnimationFrame(check);
    };
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', leave);
    return () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerleave', leave);
      cancelAnimationFrame(frame);
    };
  }, [layer]);

  const following = snapshot.following;
  return (
    <>
      {peers.map((peer) => {
        const activity = peer.activity;
        const label = activityText(activity, names);
        const icon = activity ? ACTIVITY_ICONS[activity.kind] : null;
        const flagOpen = openFlags.has(peer.session);
        // A follower's selection is the leader's, mirrored by follow mode: drawing it again as theirs would put the
        // follower's tag on the leader's own row, as if the follower had picked it.
        const mirrored = peer.following !== null;
        const hasCells = !mirrored && peer.cells.length > 0;
        const barActivity = activity && (activity.kind === 'moving' || activity.kind === 'resizing' || activity.kind === 'linking') && activity.taskId !== null ? activity : null;
        const editingCell = activity?.kind === 'editing' && activity.taskId !== null && activity.column ? activity : null;
        const panelEditing = activity?.kind === 'panel';
        return (
          <div key={peer.session} className="presence-peer" style={peerStyle(peer)} data-testid={`presence-peer-${peer.session}`}>
            {!mirrored && !hasCells && peer.taskId !== null && (
              <div className={`presence-row${panelEditing ? ' is-editing' : ''}`} hidden data-place="row" data-session={peer.session} data-task-id={peer.taskId} data-testid={`presence-row-${peer.session}`}>
                <span className="presence-row-tag">
                  {panelEditing ? <i className="fa fa-pen-to-square" aria-hidden="true" /> : initialsOf(peer.name)}
                </span>
                {panelEditing && <span className="presence-row-note">{firstName(peer.name)} is editing this in the panel</span>}
              </div>
            )}
            {(mirrored ? [] : peer.cells).flatMap((row) =>
              row.columns.map((column) => (
                <div
                  key={`cell-${row.taskId}-${column}`}
                  className="presence-cell"
                  hidden
                  data-place="cell"
                  data-session={peer.session}
                  data-task-id={row.taskId}
                  data-column={column}
                  data-testid={`presence-cell-${peer.session}`}
                />
              )),
            )}
            {(activity?.kind === 'filling' ? (activity.cells ?? []) : []).flatMap((row) =>
              row.columns.map((column) => (
                <div
                  key={`fill-${row.taskId}-${column}`}
                  className="presence-cell is-fill"
                  hidden
                  data-place="fill"
                  data-session={peer.session}
                  data-task-id={row.taskId}
                  data-column={column}
                  data-testid={`presence-fill-${peer.session}`}
                />
              )),
            )}
            {(editingCell ?? (mirrored ? null : peer.active)) && (
              <div
                className={`presence-active${editingCell ? ' is-editing' : ''}`}
                hidden
                data-place="active"
                data-session={peer.session}
                data-task-id={(editingCell ?? peer.active)!.taskId}
                data-column={(editingCell ?? peer.active)!.column}
                data-testid={`presence-active-${peer.session}`}
              >
                <span className={`presence-flag${flagOpen ? ' is-open' : ''}`} data-testid={`presence-flag-${peer.session}`}>
                  {icon && <i className={`fa fa-${icon}`} aria-hidden="true" />}
                  <span className="presence-flag-name">{firstName(peer.name)}</span>
                  {editingCell && <span className="presence-typing" aria-label="typing"><i /><i /><i /></span>}
                </span>
              </div>
            )}
            {barActivity && (
              <div className={`presence-bar-outline is-${barActivity.kind}`} hidden data-place="bar" data-session={peer.session} data-task-id={barActivity.taskId} data-testid={`presence-bar-${peer.session}`}>
                <span className="presence-flag is-open">
                  <i className={`fa fa-${ACTIVITY_ICONS[barActivity.kind]}`} aria-hidden="true" />
                  <span className="presence-flag-name">{firstName(peer.name)}</span>
                </span>
              </div>
            )}
            {points.current.has(peer.session) && (
              <div
                className={`presence-cursor${activity ? ' is-busy' : ''}`}
                hidden
                data-place="cursor"
                data-session={peer.session}
                data-testid={`presence-cursor-${peer.session}`}
                data-task-id={points.current.get(peer.session)!.taskId}
                data-kind={points.current.get(peer.session)!.kind}
              >
                <svg className="presence-arrow" width="18" height="20" viewBox="0 0 18 20" aria-hidden="true">
                  <path d="M1.5 1.5 L1.5 16.5 L5.6 12.6 L8.6 18.8 L11.4 17.5 L8.5 11.4 L14.2 11.4 Z" />
                </svg>
                <span className="presence-label">
                  <i className="presence-edge-icon fa fa-arrow-up" aria-hidden="true" />
                  <span>{firstName(peer.name)}</span>
                  {peer.simulated && <i className="presence-sim fa fa-robot" role="img" aria-label="simulated" title="Simulated person" data-testid={`presence-sim-${peer.session}`} />}
                  {label && (
                    <span className="presence-label-activity" data-testid={`presence-activity-${peer.session}`}>
                      {label}
                    </span>
                  )}
                </span>
              </div>
            )}
          </div>
        );
      })}
      {following && (
        <div className="presence-follow" style={peerStyle(following)} data-testid="follow-frame">
          <div className="presence-follow-banner" data-testid="follow-banner" data-following={following.session} data-frames={snapshot.framesApplied}>
            <i className="fa fa-eye" aria-hidden="true" />
            <span>
              Following <strong>{following.name}</strong>
              {snapshot.followWaiting ? ' · waiting for their view…' : ''}
            </span>
            <kbd className="kbd">Esc</kbd>
            <button type="button" className="button is-sm" data-testid="stop-following" onClick={() => session.stopFollowing('manual')}>
              Stop
            </button>
          </div>
        </div>
      )}
    </>
  );
}
