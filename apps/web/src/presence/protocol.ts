/**
 * What collaborators tell each other about where they are, on one private Realtime channel per
 * project (`project:{id}:presence`): who is here (presence state), where their pointer is (cursor
 * broadcasts, at most 20 a second) and, for follow mode, what their plan shows (view frames, at most
 * 10 a second, sent only while somebody follows them). Nothing here is stored: it is the ephemeral
 * layer beside the revision log, and every payload is validated on arrival because any member may send.
 *
 * Positions are semantic, never pixels: a pointer is "over task 215, at 10:00 on Nov 17, 40% down
 * its row" and a view is "zoomed to days, centered on Nov 17, with task 215 in the middle", so they
 * land on the same task and date in a window of another size, zoom or scroll position.
 */
import { MemberRoleSchema } from '@collab/shared';
import { z } from 'zod';

export function presenceTopic(projectId: string): string {
  return `project:${projectId}:presence`;
}

/** Broadcast event names on the presence channel. */
export const PRESENCE_EVENTS = { cursor: 'cursor', frame: 'frame', frameRequest: 'frame-request', state: 'state' } as const;

/** A remote pointer disappears this long after its last move. */
export const CURSOR_TTL_MS = 5_000;
/** At most 20 pointer updates a second. */
export const CURSOR_INTERVAL_MS = 50;
/**
 * At most 20 view frames a second while followed. The follower draws in between (follow-motion.ts),
 * so the rate sets how far behind it runs, not how smooth it looks. While followed, the pointer rides
 * in the frames instead of in cursor messages, which keeps a person within the realtime budget.
 */
export const FRAME_INTERVAL_MS = 50;
/** A followed view is re-sent this often even when still, so a lost frame heals. */
export const FRAME_HEARTBEAT_MS = 2_000;

const sessionId = z.string().min(1).max(64);
/** Persisted task ids only: a phantom record's id means nothing to another client. */
const taskId = z.number().int().nonnegative();
const fraction = z.number().min(0).max(1);
/** Wall-clock date and time without a zone, like every date in this app (`YYYY-MM-DDTHH:mm:ss`). */
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

const columnId = z.string().min(1).max(64);

/** The selected cells of one row: the task and the columns selected in it. */
export const rowCellsSchema = z.object({ taskId, columns: z.array(columnId).min(1).max(40) });
export type RowCells = z.infer<typeof rowCellsSchema>;

/** At most this many cells are shared; a bigger selection is shared up to here (it still reads as a block). */
export const MAX_SHARED_CELLS = 300;
const cellsSchema = z.array(rowCellsSchema).max(MAX_SHARED_CELLS);

export const cellRefSchema = z.object({ taskId, column: columnId });
export type CellRef = z.infer<typeof cellRefSchema>;

export const ACTIVITY_KINDS = ['editing', 'filling', 'clearing', 'moving', 'resizing', 'linking', 'panel'] as const;

/** What somebody is doing right now, so the others can see it coming. */
export const activitySchema = z.object({
  kind: z.enum(ACTIVITY_KINDS),
  taskId: taskId.nullable(),
  column: columnId.nullable(),
  /** Filling: the cells the fill will write. */
  cells: cellsSchema.optional(),
});
export type Activity = z.infer<typeof activitySchema>;

/** One person's tab, as presence carries it. */
export const peerSchema = z.object({
  session: sessionId,
  user: z.string().min(1).max(64),
  name: z.string().max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  role: MemberRoleSchema,
  /** The task selected in their plan. */
  taskId: taskId.nullable(),
  /** The session they follow, if any. */
  following: sessionId.nullable(),
  /** When this tab joined (ms since epoch): orders the avatars. */
  since: z.number().int().nonnegative(),
  /** The cells selected in their grid, row by row. */
  cells: cellsSchema.default([]),
  /** The cell their keyboard is on. */
  active: cellRefSchema.nullable().default(null),
  activity: activitySchema.nullable().default(null),
  /** Counts this tab's changes of selection and activity: the newer of presence and a state broadcast wins. */
  rev: z.number().int().nonnegative().default(0),
  /** A simulated person (the busy-workplace demo, src/crowd): drawn with a robot badge. Absent for real people. */
  simulated: z.boolean().optional(),
  /**
   * The call this tab hosts, while Remy is on it, and the conversation it uses (null: the main thread). The
   * assistant service reads it to greet the call when she joins. Absent off a call.
   */
  call: z.object({ remy: z.boolean(), thread: z.string().uuid().nullable() }).optional(),
});
export type Peer = z.infer<typeof peerSchema>;

/**
 * What a tab is doing (selection, activity, whom it follows), broadcast as it changes, again when
 * somebody joins, and every few seconds. Presence carries only who a tab is: Realtime lets a client
 * update its presence 5 times in 30 seconds and closes the channel of one that does it more often.
 */
export const stateMessageSchema = z.object({
  session: sessionId,
  rev: z.number().int().nonnegative(),
  taskId: taskId.nullable(),
  cells: cellsSchema,
  active: cellRefSchema.nullable(),
  activity: activitySchema.nullable(),
  /** The session this tab follows, if any. */
  following: sessionId.nullable().default(null),
});
export type StateMessage = z.infer<typeof stateMessageSchema>;

export const cursorPointSchema = z.discriminatedUnion('kind', [
  /** Over the timeline: a task row and the date under the pointer. */
  z.object({ kind: z.literal('timeline'), taskId, date: localDateTime, dy: fraction }),
  /** Over a grid cell: the task row and the column, with the offset inside the cell. */
  z.object({ kind: z.literal('grid'), taskId, column: z.string().min(1).max(64), dx: fraction, dy: fraction }),
]);
export type CursorPoint = z.infer<typeof cursorPointSchema>;

/** `point: null` when the pointer left the plan. `seq` orders one sender's messages. */
export const cursorMessageSchema = z.object({
  session: sessionId,
  seq: z.number().int().nonnegative(),
  point: cursorPointSchema.nullable(),
  /** When the sender sent it (its own clock, ms): receivers draw the pointer's path at the pace it was made. */
  t: z.number().nonnegative().optional(),
});
export type CursorMessage = z.infer<typeof cursorMessageSchema>;

/** A group row while the plan is grouped (by crew, status…): it has no task id, only its group's name. */
const groupName = z.string().min(1).max(120);

/** The row in the middle of the plan: a task, or a group row, and how far down that row the middle is. */
export const anchorSchema = z.union([z.object({ taskId, dy: fraction }), z.object({ group: groupName, dy: fraction })]);
export type ViewAnchor = z.infer<typeof anchorSchema>;

/** A folded row in `ViewLook.collapsed`: `t:215` for a task, `g:Crane` for a group row. */
const rowKey = z.string().regex(/^(t:\d{1,15}|g:.{1,120})$/);

export const GROUP_BY = ['phase', 'crew', 'status', 'budget'] as const;
export const COLOR_BY = ['phase', 'crew'] as const;
export const QUICK_FILTERS = ['all', 'active', 'attention'] as const;

/**
 * How a plan is drawn, beyond where it is scrolled: grouping, colors, filters, sort order and which
 * rows are folded. None of it is shared data (each person keeps their own); a follower takes the
 * leader's for as long as they follow, so the same rows sit in the same order on both screens.
 */
export const viewLookSchema = z.object({
  groupBy: z.enum(GROUP_BY),
  colorBy: z.enum(COLOR_BY),
  filter: z.enum(QUICK_FILTERS),
  search: z.string().max(120),
  criticalPath: z.boolean(),
  planned: z.boolean(),
  sort: z.array(z.object({ field: z.string().min(1).max(64), ascending: z.boolean() })).max(4),
  collapsed: z.array(rowKey).max(400),
  /**
   * Whether "needs attention" counts tasks over budget: it does for cost viewers only, so a follower
   * takes the leader's rule, or the same filter would show them other rows.
   */
  attentionCosts: z.boolean().default(false),
});
export type ViewLook = z.infer<typeof viewLookSchema>;

/**
 * What a plan shows: the zoom level, the time span on screen, the date and the row in the middle, the
 * selection and how the plan is drawn. Dates and rows are semantic, so a window of another size shows
 * the same span of time around the same row.
 */
export const viewBodySchema = z.object({
  preset: z.string().min(1).max(64),
  /** Width of one tick of the time axis, in the sender's pixels. */
  tick: z.number().positive().max(100_000).optional(),
  /** Width of the sender's visible timeline, in pixels: with `tick`, how much time is on screen. */
  width: z.number().positive().max(100_000).optional(),
  /** The sender's whole time axis (what can be scrolled to). */
  axisStart: localDateTime.optional(),
  axisEnd: localDateTime.optional(),
  center: localDateTime,
  anchor: anchorSchema.nullable(),
  selected: z.array(taskId).max(50),
  look: viewLookSchema.optional(),
  /** The sender's pointer, while followed (instead of cursor messages): `seq` is the cursor sequence. */
  pointer: z.object({ seq: z.number().int().nonnegative(), point: cursorPointSchema.nullable() }).optional(),
});
export type ViewBody = z.infer<typeof viewBodySchema>;

export const viewFrameSchema = viewBodySchema.extend({
  session: sessionId,
  seq: z.number().int().nonnegative(),
  /** The sender's last applied revision: a follower behind it may not have the anchor task yet. */
  revision: z.number().int().nonnegative(),
  /** When the sender read the view (its own clock, ms): the follower plays frames back at the pace they were taken. */
  t: z.number().nonnegative().optional(),
});
export type ViewFrame = z.infer<typeof viewFrameSchema>;

/** The task id of an anchor on a task row, or null for a group row. */
export function anchorTaskId(anchor: ViewAnchor | null | undefined): number | null {
  return anchor && 'taskId' in anchor ? anchor.taskId : null;
}

/** One string per look, to tell whether two looks are the same. */
export function lookKey(look: ViewLook | null | undefined): string {
  if (!look) return '';
  return JSON.stringify([look.groupBy, look.colorBy, look.filter, look.search, look.criticalPath, look.planned, look.attentionCosts, look.sort, [...look.collapsed].sort()]);
}

/** "Send me your view now": a new follower does not wait for the next change or heartbeat. */
export const frameRequestSchema = z.object({ session: sessionId, target: sessionId });
export type FrameRequest = z.infer<typeof frameRequestSchema>;

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** `2026-11-17T10:00:00` in local wall-clock time. */
export function toLocalDateTime(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The local Date of a `YYYY-MM-DDTHH:mm:ss` string, or null. */
export function fromLocalDateTime(text: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day, hours, minutes, seconds] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(year, month - 1, day, hours, minutes, seconds);
  return Number.isNaN(date.getTime()) || date.getDate() !== day ? null : date;
}

/** Keeps a selection within `MAX_SHARED_CELLS` cells, rows in order, columns de-duplicated. */
export function capCells(rows: readonly RowCells[]): RowCells[] {
  const capped: RowCells[] = [];
  let total = 0;
  for (const row of rows) {
    const columns = [...new Set(row.columns)].slice(0, 40);
    const room = MAX_SHARED_CELLS - total;
    if (room <= 0) break;
    const kept = columns.slice(0, room);
    if (kept.length === 0) continue;
    capped.push({ taskId: row.taskId, columns: kept });
    total += kept.length;
  }
  return capped;
}

export function cellCount(rows: readonly RowCells[]): number {
  return rows.reduce((total, row) => total + row.columns.length, 0);
}

const anchorRow = (anchor: ViewAnchor | null) => (anchor ? ('taskId' in anchor ? `t:${anchor.taskId}` : `g:${anchor.group}`) : '');

/** Same view, so a still leader does not re-send it on every scroll event. */
export function sameView(a: ViewBody | null, b: ViewBody | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.preset === b.preset &&
    a.tick === b.tick &&
    a.width === b.width &&
    a.axisStart === b.axisStart &&
    a.axisEnd === b.axisEnd &&
    a.center === b.center &&
    anchorRow(a.anchor) === anchorRow(b.anchor) &&
    Math.abs((a.anchor?.dy ?? 0) - (b.anchor?.dy ?? 0)) < 0.02 &&
    a.selected.length === b.selected.length &&
    a.selected.every((id, index) => b.selected[index] === id) &&
    lookKey(a.look) === lookKey(b.look) &&
    a.pointer?.seq === b.pointer?.seq
  );
}
