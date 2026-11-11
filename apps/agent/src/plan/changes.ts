/**
 * The plan's change history in plain words: each revision since the loaded snapshot (who, when, by
 * hand or by the assistant, what changed: tasks added, removed, moved, re-dated, re-linked, crews
 * given or taken), replayed over the snapshot so a change can say what a value was before. The engine
 * moves that a person's edit set off travel in the same revision and are told as follow-on moves.
 * People's decisions about the assistant's drafted changes (applied, applied automatically, declined)
 * are listed with them, from agent_edit_decisions.
 */
import type { AgentEditDecisionRow } from '@collab/shared';
import { day, lastDay, usd } from './format';
import { asStoreChanges, flatten, isId, type FlatRecord, type FlatTask, type PlanRows, type RevisionRowInput } from './rows';
import type { PlanMember } from './snapshot';

export interface PlanChange {
  revision: number;
  at: string | null;
  by: string;
  origin: 'person' | 'assistant' | 'engine';
  lines: string[];
  /** Tasks the revision touched (for filtering and the cards). */
  task_ids: number[];
}

export interface EditDecision {
  at: string;
  by: string;
  decision: 'applied' | 'applied automatically' | 'declined';
  title: string;
  lines: string[];
}

const MAX_LINES = 8;

const dateOf = (value: unknown): string | null => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);
const nameOf = (task: FlatTask | undefined, id: unknown): string => (typeof task?.name === 'string' ? `“${task.name}”` : `task ${String(id)}`);
const LINK_WORDS: Record<number, string> = { 0: 'start-to-start', 1: 'start-to-finish', 2: 'finish-to-start', 3: 'finish-to-finish' };
const MONEY_FIELDS: Record<string, string> = { budgetMinor: 'budget', forecastMinor: 'forecast', incurredMinor: 'spent', paidMinor: 'paid' };

/** What a task update changed, in words, comparing the patch with the task as it was. */
function describeTaskUpdate(before: FlatTask, patch: Record<string, unknown>, tasks: Map<number, FlatTask>): { line: string | null; datesOnly: boolean } {
  const parts: string[] = [];
  let datesOnly = true;
  const startBefore = dateOf(before.startDate);
  const startAfter = dateOf(patch.startDate);
  if (startAfter && startBefore && startAfter !== startBefore) parts.push(`starts ${day(startAfter)} (was ${day(startBefore)})`);
  const endBefore = dateOf(before.endDate);
  const endAfter = dateOf(patch.endDate);
  if (endAfter && endBefore && endAfter !== endBefore) parts.push(`finishes ${day(lastDay(endAfter))} (was ${day(lastDay(endBefore))})`);
  const other = (text: string) => {
    parts.push(text);
    datesOnly = false;
  };
  if (typeof patch.name === 'string' && patch.name !== before.name) other(`renamed to “${patch.name}”`);
  if (typeof patch.duration === 'number' && typeof before.duration === 'number' && patch.duration !== before.duration) other(`${patch.duration} days long (was ${before.duration})`);
  if (typeof patch.percentDone === 'number' && patch.percentDone !== before.percentDone) other(`${Math.round(patch.percentDone)}% done (was ${Math.round(Number(before.percentDone ?? 0))}%)`);
  if ('constraintType' in patch && patch.constraintType !== before.constraintType) {
    other(patch.constraintType ? `pinned: ${String(patch.constraintType)}${dateOf(patch.constraintDate) ? ` ${day(dateOf(patch.constraintDate)!)}` : ''}` : 'no longer pinned to a date');
  }
  if (typeof patch.manuallyScheduled === 'boolean' && patch.manuallyScheduled !== Boolean(before.manuallyScheduled)) other(patch.manuallyScheduled ? 'set to manual dates' : 'scheduled automatically again');
  if (typeof patch.inactive === 'boolean' && patch.inactive !== Boolean(before.inactive)) other(patch.inactive ? 'switched off' : 'switched back on');
  if (typeof patch.note === 'string' && patch.note !== before.note) other('note changed');
  if (typeof patch.parentId === 'number' && patch.parentId !== before.parentId) other(`moved under ${nameOf(tasks.get(patch.parentId), patch.parentId)}`);
  for (const [field, label] of Object.entries(MONEY_FIELDS)) {
    if (typeof patch[field] === 'number' && patch[field] !== before[field]) other(`${label} ${usd(patch[field] as number)} (was ${usd(Number(before[field] ?? 0))})`);
  }
  return { line: parts.length ? `${nameOf(before, before.id)}: ${parts.join('; ')}` : null, datesOnly };
}

/** Ids of the records the person's own edit named (`$input`); null when the revision does not say. */
function ownIds(value: unknown): Set<number> | null {
  const input = (value as { $input?: unknown } | null)?.$input;
  const bags = asStoreChanges(input);
  if (!bags) return null;
  return new Set([...(bags.added ?? []), ...(bags.updated ?? []), ...(bags.removed ?? [])].map((record) => record.id).filter(isId));
}

function originOf(revision: RevisionRowInput): PlanChange['origin'] {
  return revision.origin === 'agent' ? 'assistant' : revision.origin === 'engine' ? 'engine' : 'person';
}

/**
 * Every revision since the snapshot, newest first, as plain lines. `members` names the people;
 * `filter` keeps the revisions that touched one of the tasks or were made on or after a day.
 */
export function planChanges(rows: PlanRows, members: readonly PlanMember[], filter: { taskIds?: readonly number[]; since?: string } = {}): PlanChange[] {
  const tasks = new Map<number, FlatTask>();
  flatten(rows.project.snapshot?.tasksData ?? [], null, tasks);
  const links = new Map<number, FlatRecord>();
  for (const link of rows.project.snapshot?.dependenciesData ?? []) if (isId(link.id)) links.set(link.id, { ...(link as Record<string, unknown>), id: link.id });
  const crews = new Map<number, string>();
  for (const resource of rows.project.snapshot?.resourcesData ?? []) if (isId(resource.id)) crews.set(resource.id, resource.name);
  const assignments = new Map<number, FlatRecord>();
  for (const assignment of rows.project.snapshot?.assignmentsData ?? []) if (isId(assignment.id)) assignments.set(assignment.id, { ...(assignment as Record<string, unknown>), id: assignment.id! });

  const who = (userId: string | null | undefined) => members.find((member) => member.userId === userId)?.name ?? (userId ? 'a member' : 'someone');
  const out: PlanChange[] = [];
  for (const revision of [...rows.revisions].sort((a, b) => a.revision_no - b.revision_no)) {
    const lines: string[] = [];
    const touched = new Set<number>();
    const knockOn: string[] = [];
    const own = ownIds(revision.changes.tasks);
    const taskChanges = asStoreChanges(revision.changes.tasks);
    if (taskChanges) {
      for (const added of taskChanges.added ?? []) {
        if (!isId(added.id)) continue;
        const parentId = typeof added.parentId === 'number' ? added.parentId : null;
        tasks.set(added.id, { ...added, id: added.id, parentId });
        touched.add(added.id);
        const start = dateOf(added.startDate);
        lines.push(`Added ${nameOf(tasks.get(added.id), added.id)}${parentId !== null ? ` under ${nameOf(tasks.get(parentId), parentId)}` : ''}${start ? `, starting ${day(start)}` : ''}`);
      }
      for (const patch of taskChanges.updated ?? []) {
        const before = isId(patch.id) ? tasks.get(patch.id) : undefined;
        if (!before) continue;
        const { line, datesOnly } = describeTaskUpdate(before, patch, tasks);
        Object.assign(before, patch, { id: before.id, parentId: typeof patch.parentId === 'number' ? patch.parentId : before.parentId });
        if (!line) continue;
        touched.add(before.id);
        // A task that only moved, and that the person's edit did not name, moved because of it.
        if (datesOnly && own && !own.has(before.id)) knockOn.push(nameOf(before, before.id));
        else lines.push(line);
      }
      for (const removed of taskChanges.removed ?? []) {
        if (!isId(removed.id)) continue;
        touched.add(removed.id);
        lines.push(`Removed ${nameOf(tasks.get(removed.id), removed.id)}`);
        tasks.delete(removed.id);
      }
    }
    const linkChanges = asStoreChanges(revision.changes.dependencies);
    if (linkChanges) {
      const describe = (link: Record<string, unknown>) => {
        const type = typeof link.type === 'number' ? link.type : 2;
        const lag = typeof link.lag === 'number' && link.lag !== 0 ? ` with ${link.lag > 0 ? `${link.lag} day(s) lag` : `${-link.lag} day(s) lead`}` : '';
        return `${nameOf(tasks.get(link.fromEvent as number), link.fromEvent)} → ${nameOf(tasks.get(link.toEvent as number), link.toEvent)} (${LINK_WORDS[type] ?? 'finish-to-start'}${lag})`;
      };
      for (const added of linkChanges.added ?? []) {
        if (isId(added.id)) links.set(added.id, { ...added, id: added.id });
        for (const end of [added.fromEvent, added.toEvent]) if (isId(end)) touched.add(end);
        lines.push(`Linked ${describe(added)}`);
      }
      for (const patch of linkChanges.updated ?? []) {
        const before = isId(patch.id) ? links.get(patch.id) : undefined;
        if (!before) continue;
        Object.assign(before, patch, { id: before.id });
        for (const end of [before.fromEvent, before.toEvent]) if (isId(end)) touched.add(end);
        lines.push(`Changed the link ${describe(before)}`);
      }
      for (const removed of linkChanges.removed ?? []) {
        const before = isId(removed.id) ? links.get(removed.id) : undefined;
        if (!before) continue;
        for (const end of [before.fromEvent, before.toEvent]) if (isId(end)) touched.add(end);
        lines.push(`Unlinked ${describe(before)}`);
        links.delete(before.id);
      }
    }
    const resourceChanges = asStoreChanges(revision.changes.resources);
    for (const added of resourceChanges?.added ?? []) if (isId(added.id) && typeof added.name === 'string') crews.set(added.id, added.name);
    const assignmentChanges = asStoreChanges(revision.changes.assignments);
    if (assignmentChanges) {
      const crewOf = (record: Record<string, unknown>) => (isId(record.resource) ? (crews.get(record.resource) ?? `crew ${record.resource}`) : 'a crew');
      for (const added of assignmentChanges.added ?? []) {
        if (isId(added.id)) assignments.set(added.id, { ...added, id: added.id });
        if (isId(added.event)) touched.add(added.event);
        lines.push(`Gave ${crewOf(added)} to ${nameOf(tasks.get(added.event as number), added.event)}`);
      }
      for (const removed of assignmentChanges.removed ?? []) {
        const before = isId(removed.id) ? assignments.get(removed.id) : undefined;
        if (!before) continue;
        if (isId(before.event)) touched.add(before.event);
        lines.push(`Took ${crewOf(before)} off ${nameOf(tasks.get(before.event as number), before.event)}`);
        assignments.delete(before.id);
      }
    }
    if (knockOn.length > 0) lines.push(`Follow-on: ${knockOn.length} task(s) moved with it (${knockOn.slice(0, 3).join(', ')}${knockOn.length > 3 ? ', …' : ''})`);
    const shown = lines.length > MAX_LINES + 1 ? [...lines.slice(0, MAX_LINES), `…and ${lines.length - MAX_LINES} more change(s)`] : lines;
    out.push({ revision: revision.revision_no, at: revision.created_at ?? null, by: who(revision.actor_user_id), origin: originOf(revision), lines: shown.length ? shown : ['No visible change (layout or bookkeeping)'], task_ids: [...touched] });
  }
  return out
    .filter((change) => !filter.taskIds?.length || change.task_ids.some((id) => filter.taskIds!.includes(id)))
    .filter((change) => !filter.since || (change.at ?? '') >= filter.since)
    .reverse();
}

const DECISION_WORDS = { applied: 'applied', auto_applied: 'applied automatically', declined: 'declined' } as const;

export function editDecisions(rows: readonly AgentEditDecisionRow[], members: readonly PlanMember[], since?: string): EditDecision[] {
  return [...rows]
    .filter((row) => !since || row.created_at >= since)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((row) => ({
      at: row.created_at,
      by: members.find((member) => member.userId === row.decided_by)?.name ?? 'a member',
      decision: DECISION_WORDS[row.decision],
      title: row.title,
      lines: row.lines.slice(0, 6),
    }));
}
