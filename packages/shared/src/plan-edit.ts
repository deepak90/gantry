/**
 * Plan edits the assistant drafts and a person applies: a short list of operations on the live plan
 * (add, change, move, indent, outdent, copy or delete tasks; link and unlink; add a firm, give or take a crew; set a machine's rental dates; set
 * what a task costs and who is paid; drop a library piece, whole or without the work done once for the whole building).
 * The agent service checks a draft against its view of the plan and shows it as a card; whoever
 * presses "Apply" runs exactly these operations in their own browser, as one change for everyone
 * (one revision). Nothing is re-interpreted on the way: the card carries the operations.
 *
 * Tasks are named by their plan id; tasks the edit itself adds are named by a `ref` the edit gives
 * them (so a later operation can link to or assign a crew to a task that does not exist yet).
 * Durations, lags and leads are working days; a negative lag is a lead.
 */
import { z } from 'zod';
import { SnippetLinkType } from './library';

const taskId = z.int().positive().describe('Id of a task in the plan (from a tool result)');
const ref = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/)
  .describe('Name you give a task this edit adds, e.g. "moisture_test"; later operations can use it');
const days = z.number().min(0).max(500);

/** A task either already in the plan (`id`) or added earlier in the same edit (`ref`). */
export const TaskRef = z.union([z.object({ id: taskId }), z.object({ ref })]);
export type TaskRef = z.infer<typeof TaskRef>;

export const DROP_MODE_VALUES = ['push', 'fit', 'alongside', 'unlinked'] as const;

export const PlanEditOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_task'),
    ref,
    name: z.string().trim().min(1).max(160),
    /** The group it goes into; leave out for the top level. */
    parent: TaskRef.optional(),
    /** The sibling it goes after; leave out to add it at the end of the group. */
    after: TaskRef.optional(),
    days: days.describe('Working days; 0 makes a milestone'),
    note: z.string().max(600).optional(),
  }),
  z.object({
    op: z.literal('update_task'),
    task: taskId,
    name: z.string().trim().min(1).max(160).optional(),
    days: days.optional(),
    percent_done: z.number().min(0).max(100).optional(),
    note: z.string().max(600).optional(),
    /** Its new last working day (YYYY-MM-DD), to lengthen or shorten it to a date: its working days follow, on its own calendar. */
    last_day: z.iso.date().optional(),
    /** Pins the task to start no earlier than this date (YYYY-MM-DD); null removes the pin. */
    start_no_earlier_than: z.iso.date().nullable().optional(),
    manually_scheduled: z.boolean().optional(),
    inactive: z.boolean().optional(),
  }),
  z.object({ op: z.literal('delete_task'), task: taskId }),
  /** Into the task just above it in its group, which becomes a group (as Indent does). */
  z.object({ op: z.literal('indent_task'), task: taskId }),
  /** Out of its group, to just after the group (as Outdent does). */
  z.object({ op: z.literal('outdent_task'), task: taskId }),
  /**
   * A copy of a task, or of a group with everything in it, the links between them and the crews on them, as copy and
   * paste makes it: it starts fresh (no progress, nothing spent or paid). It goes just after the original, or after `after`.
   */
  z.object({
    op: z.literal('duplicate_task'),
    task: taskId,
    ref: ref.optional(),
    name: z.string().trim().min(1).max(160).optional().describe('The copy’s name; leave out for the original’s name with " - 2"'),
    after: TaskRef.optional().describe('The task it goes after; leave out for right after the original'),
  }),
  z.object({
    op: z.literal('move_task'),
    task: taskId,
    parent: TaskRef.optional().describe('Group to move it into; leave out for the top level'),
    after: TaskRef.optional().describe('Sibling to place it after; leave out for the end of the group'),
  }),
  z.object({
    op: z.literal('link'),
    from: TaskRef,
    to: TaskRef,
    type: SnippetLinkType.default('FS'),
    lag_days: z.int().min(-120).max(250).default(0).describe('Working days; negative is a lead'),
  }),
  z.object({ op: z.literal('unlink'), from: taskId, to: taskId }),
  z.object({
    op: z.literal('set_link'),
    from: taskId,
    to: taskId,
    type: SnippetLinkType.optional(),
    lag_days: z.int().min(-120).max(250).optional(),
  }),
  z.object({
    op: z.literal('add_crew'),
    name: z.string().trim().min(1).max(80).describe('The firm’s name as the person gave it, e.g. "Lumen & Co Lighting"'),
    trade: z.string().trim().min(1).max(40).describe('What the firm does, as a short label, e.g. "Lighting supply" or "Electrical"'),
  }),
  z.object({
    op: z.literal('assign_crew'),
    task: TaskRef,
    crew: z.string().trim().min(1).max(80).describe('Crew name as the project calls it'),
    units: z.int().min(10).max(1000).default(100).describe('Percent of the crew'),
  }),
  z.object({ op: z.literal('unassign_crew'), task: taskId, crew: z.string().trim().min(1).max(80) }),
  z.object({
    op: z.literal('set_rental'),
    task: taskId,
    machine: z.string().trim().min(1).max(80).describe('Machine name as the project calls it'),
    first_day: z.iso.date().describe('First day on rent'),
    last_day: z.iso.date().describe('Last day on rent, included'),
  }),
  z.object({
    op: z.literal('add_snippet'),
    snippet_id: z.string().min(1).max(64).describe('Library snippet id from list_library'),
    /** Where: after a task or group, at the end of a group (`inside`), or at the start of a group before a task (`before`). */
    after: taskId.optional(),
    inside: taskId.optional(),
    before: taskId.optional(),
    mode: z.enum(DROP_MODE_VALUES).default('push').describe('push: later work waits for it; fit: nothing moves; alongside: starts with the task; unlinked: no links'),
    repeats: z.int().min(1).max(8).default(1),
    name: z.string().trim().min(1).max(120).optional().describe('Name of the top task; leave out for the snippet name'),
    leave_out: z
      .array(z.string().trim().min(1).max(160))
      .min(1)
      .max(12)
      .optional()
      .describe('Names of the piece’s tasks to leave out here, such as the ordering and delivery done once for the whole building'),
    waits_for: taskId.optional().describe('A task in the plan the piece’s first tasks also wait for, such as the one delivery where the piece first went'),
  }),
  z.object({
    op: z.literal('set_cost'),
    task: taskId,
    amount: z.int().min(0).max(10_000_000).optional().describe('Whole dollars: what the task now costs in all; leave out to keep it'),
    label: z.string().trim().min(1).max(80).optional().describe('What the cost now pays for, e.g. "Light fixtures, levels 1 to 3"; leave out to keep it'),
    payee: z.string().trim().min(1).max(80).optional().describe('Who the cost is now paid to: a crew or a supplier, e.g. "Lumen & Co Lighting"; leave out to keep it'),
  }),
]);
export type PlanEditOp = z.infer<typeof PlanEditOp>;

export const PlanEdit = z.object({
  title: z.string().trim().min(1).max(90),
  operations: z.array(PlanEditOp).min(1).max(40),
});
export type PlanEdit = z.infer<typeof PlanEdit>;

/** The id a TaskRef names, or the ref string. */
export function taskRefKey(task: TaskRef): string {
  return 'id' in task ? `#${task.id}` : `@${task.ref}`;
}
