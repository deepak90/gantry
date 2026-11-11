/**
 * Checking a plan edit the model drafted, before anyone sees it: every task it names is in the plan
 * (or added earlier in the same edit), crews are the project's own (or a firm the edit adds), links do not duplicate an
 * existing one or close a loop, library pieces exist and have a place. Each operation becomes one
 * plain sentence for the card. What cannot work is refused with the reasons, so the model can fix the
 * draft; what is only worth knowing comes back as warnings.
 *
 * The browser that applies the edit checks again against the live plan (ids may have moved on).
 */
import { addDays, leavesOf, LINK_TYPE_WORDS, normalName, rentalDays, shortDay as formatDay, type PlanEditOp, type Snippet, type TaskRef } from '@collab/shared';
import type { PlanSnapshot, PlanTask } from '../plan/snapshot';
import { ToolRefusal } from './refusal';

export interface CheckedEdit {
  edit_id: string;
  title: string;
  operations: PlanEditOp[];
  lines: string[];
  warnings: string[];
}

const MODE_WORDS = {
  push: 'later work waits for it',
  fit: 'nothing else moves',
  alongside: 'starts with it',
  unlinked: 'no links',
} as const;

/** How the later task waits, per link type: "“B” starts after “A” finishes". */
const LINK_SENTENCE = {
  FS: (to: string, from: string) => `${to} starts after ${from} finishes`,
  SS: (to: string, from: string) => `${to} starts with ${from}`,
  FF: (to: string, from: string) => `${to} finishes with ${from}`,
  SF: (to: string, from: string) => `${to} finishes when ${from} starts`,
} as const;

const days = (count: number) => `${count} day${count === 1 ? '' : 's'}`;
const lagWords = (lag: number) => (lag > 0 ? `, ${days(lag)} lag` : lag < 0 ? `, ${days(-lag)} lead` : '');

export function checkPlanEdit(plan: PlanSnapshot, library: readonly Snippet[], editId: string, title: string, operations: PlanEditOp[]): CheckedEdit {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const children = new Map<number, PlanTask[]>();
  for (const task of plan.tasks) if (task.parentId !== null) children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
  const isGroup = (id: number) => (children.get(id)?.length ?? 0) > 0;
  // A crew by its name (a firm), else by its trade (the first crew of that trade), as the browser matches.
  const crews = new Map<string, { id: number; name: string; trade?: string }>(plan.resources.map((resource) => [normalName(resource.name), resource]));
  for (const resource of plan.resources) {
    const trade = normalName(resource.trade ?? '');
    if (trade && !crews.has(trade)) crews.set(trade, resource);
  }
  /** Firms this edit adds (add_crew), by name. */
  const firms = new Set<string>();
  const added = new Map<string, { name: string; parent: string }>();
  const deleted = new Set<number>();
  const links = new Set(plan.dependencies.map((link) => `${link.from}>${link.to}`));
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines: string[] = [];

  const quoted = (name: string) => `“${name}”`;
  const named = (task: TaskRef): string | null => {
    if ('id' in task) {
      const found = byId.get(task.id);
      if (!found) {
        errors.push(`There is no task ${task.id} in the plan.`);
        return null;
      }
      if (deleted.has(task.id)) errors.push(`${quoted(found.name)} is deleted earlier in this edit.`);
      return quoted(found.name);
    }
    const found = added.get(task.ref);
    if (!found) {
      errors.push(`"${task.ref}" is used before an add_task operation gives that name.`);
      return null;
    }
    return quoted(found.name);
  };
  const nameOf = (id: number) => {
    const found = byId.get(id);
    if (!found) errors.push(`There is no task ${id} in the plan.`);
    return found ? quoted(found.name) : `task ${id}`;
  };
  /** Whether `from` can already be reached from `to` through the plan's links (a new link would close a loop). */
  const reaches = (start: number, goal: number): boolean => {
    const next = new Map<number, number[]>();
    for (const link of plan.dependencies) next.set(link.from, [...(next.get(link.from) ?? []), link.to]);
    const seen = new Set<number>();
    const stack = [start];
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (at === goal) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(next.get(at) ?? []));
    }
    return false;
  };

  /** The tasks of a group (or of the top level), in plan order. */
  const tasksIn = (parentId: number | null) =>
    plan.tasks.filter((task) => task.parentId === parentId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id);

  for (const op of operations) {
    switch (op.op) {
      case 'add_task': {
        if (added.has(op.ref)) errors.push(`Two add_task operations use the name "${op.ref}".`);
        const parent = op.parent ? named(op.parent) : 'the top level';
        const after = op.after ? named(op.after) : null;
        if (op.parent && 'id' in op.parent && !isGroup(op.parent.id) && byId.has(op.parent.id)) warnings.push(`${quoted(byId.get(op.parent.id)!.name)} becomes a group.`);
        added.set(op.ref, { name: op.name, parent: parent ?? '' });
        lines.push(`Add ${quoted(op.name)} (${op.days === 0 ? 'milestone' : days(op.days)}) in ${parent}${after ? `, after ${after}` : ''}`);
        break;
      }
      case 'update_task': {
        const task = byId.get(op.task);
        const changes: string[] = [];
        if (op.name !== undefined) changes.push(`rename to ${quoted(op.name)}`);
        if (op.days !== undefined) {
          if (task && isGroup(task.id)) errors.push(`${quoted(task.name)} is a group: it takes its dates from its tasks; change those instead.`);
          changes.push(`${days(op.days)}`);
        }
        if (op.last_day !== undefined) {
          if (task && isGroup(task.id)) errors.push(`${quoted(task.name)} is a group: it takes its dates from its tasks; change those instead.`);
          if (task && op.last_day < task.start) errors.push(`${quoted(task.name)} starts ${formatDay(task.start)}: it can’t finish before that.`);
          if (op.days !== undefined) errors.push(`Give ${quoted(task?.name ?? 'the task')} either days or a last_day, not both.`);
          changes.push(`finishing ${formatDay(op.last_day)}`);
        }
        if (op.percent_done !== undefined) changes.push(`${Math.round(op.percent_done)}% done`);
        if (op.note !== undefined) changes.push(op.note ? 'new note' : 'clear the note');
        if (op.start_no_earlier_than !== undefined) changes.push(op.start_no_earlier_than ? `start no earlier than ${op.start_no_earlier_than}` : 'remove its date pin');
        if (op.manually_scheduled !== undefined) changes.push(op.manually_scheduled ? 'schedule by hand' : 'schedule automatically');
        if (op.inactive !== undefined) changes.push(op.inactive ? 'make inactive' : 'make active');
        if (changes.length === 0) errors.push(`update_task for ${nameOf(op.task)} changes nothing.`);
        lines.push(`Change ${nameOf(op.task)}: ${changes.join(', ')}`);
        break;
      }
      case 'delete_task': {
        const task = byId.get(op.task);
        const inside = task ? plan.tasks.filter((other) => isUnder(plan, other, task.id)).length : 0;
        if (task && task.id === plan.handoverTaskId) warnings.push('This deletes the handover milestone.');
        if (task && (task.incurredMinor > 0 || task.percentDone > 0)) warnings.push(`${quoted(task.name)} has work done or money spent.`);
        deleted.add(op.task);
        lines.push(`Delete ${nameOf(op.task)}${inside > 0 ? ` and the ${inside} task${inside === 1 ? '' : 's'} in it` : ''}`);
        break;
      }
      case 'indent_task': {
        const task = byId.get(op.task);
        if (!task) {
          nameOf(op.task);
          break;
        }
        const group = tasksIn(task.parentId);
        const above = group[group.indexOf(task) - 1];
        if (!above) errors.push(`${quoted(task.name)} is first in its group: there is no task above it to go into.`);
        else if (above.isMilestone) errors.push(`${quoted(above.name)}, above it, is a milestone: a milestone can’t hold tasks.`);
        else if (links.has(`${above.id}>${task.id}`) || links.has(`${task.id}>${above.id}`)) {
          errors.push(`${quoted(task.name)} and ${quoted(above.name)}, the task above it, are linked: a group can’t wait for a task in it. Unlink them in the same edit first, or move it elsewhere.`);
        } else if (!isGroup(above.id)) warnings.push(`${quoted(above.name)} becomes a group.`);
        lines.push(`Indent ${quoted(task.name)}${above ? ` into ${quoted(above.name)}` : ''}`);
        break;
      }
      case 'outdent_task': {
        const task = byId.get(op.task);
        if (!task) {
          nameOf(op.task);
          break;
        }
        const parent = task.parentId === null ? undefined : byId.get(task.parentId);
        if (!parent) errors.push(`${quoted(task.name)} is already at the top level.`);
        else if (tasksIn(parent.id).length === 1) warnings.push(`${quoted(parent.name)} is left with nothing in it.`);
        lines.push(`Outdent ${quoted(task.name)}${parent ? `, out of ${quoted(parent.name)}` : ''}`);
        break;
      }
      case 'duplicate_task': {
        const task = byId.get(op.task);
        const name = op.name ?? (task ? `${task.name} - 2` : '');
        const inside = task ? plan.tasks.filter((other) => isUnder(plan, other, task.id)).length : 0;
        const after = op.after ? named(op.after) : null;
        if (op.ref) {
          if (added.has(op.ref)) errors.push(`Two operations use the name "${op.ref}".`);
          added.set(op.ref, { name, parent: '' });
        }
        lines.push(`Copy ${nameOf(op.task)}${inside > 0 ? ` with the ${inside} task${inside === 1 ? '' : 's'} in it` : ''} as ${quoted(name)}, ${after ? `after ${after}` : 'right after it'} (it starts fresh: nothing done, spent or paid)`);
        break;
      }
      case 'move_task': {
        const parent = op.parent ? named(op.parent) : 'the top level';
        if (op.parent && 'id' in op.parent && (op.parent.id === op.task || (byId.get(op.parent.id) && isUnder(plan, byId.get(op.parent.id)!, op.task)))) {
          errors.push(`${nameOf(op.task)} cannot go inside itself.`);
        }
        const after = op.after ? named(op.after) : null;
        lines.push(`Move ${nameOf(op.task)} into ${parent}${after ? `, after ${after}` : ', at the end'}`);
        break;
      }
      case 'link': {
        const from = named(op.from);
        const to = named(op.to);
        if ('id' in op.from && 'id' in op.to) {
          if (op.from.id === op.to.id) errors.push(`${from} cannot wait for itself.`);
          if (links.has(`${op.from.id}>${op.to.id}`)) errors.push(`${to} already waits for ${from}; use set_link to change that link.`);
          else if (reaches(op.to.id, op.from.id)) errors.push(`Linking ${from} to ${to} would make a loop: ${from} already waits for ${to}.`);
          links.add(`${op.from.id}>${op.to.id}`);
        }
        lines.push(`${LINK_SENTENCE[op.type](to ?? 'the task', from ?? 'the task')}${lagWords(op.lag_days)}`);
        break;
      }
      case 'unlink': {
        if (!links.has(`${op.from}>${op.to}`)) errors.push(`${nameOf(op.to)} does not wait for ${nameOf(op.from)}.`);
        // Gone for what comes after it in this edit (an indent into the task it linked to, say).
        links.delete(`${op.from}>${op.to}`);
        lines.push(`Remove the link ${nameOf(op.from)} → ${nameOf(op.to)}`);
        break;
      }
      case 'set_link': {
        if (!links.has(`${op.from}>${op.to}`)) errors.push(`${nameOf(op.to)} does not wait for ${nameOf(op.from)}; use link to add it.`);
        const parts = [op.type ? LINK_TYPE_WORDS[op.type].label.toLowerCase() : null, op.lag_days !== undefined ? (op.lag_days === 0 ? 'no gap' : lagWords(op.lag_days).slice(2)) : null].filter(Boolean);
        lines.push(`Change the link ${nameOf(op.from)} → ${nameOf(op.to)}: ${parts.join(', ') || 'no change'}`);
        break;
      }
      case 'add_crew': {
        const key = normalName(op.name);
        if (plan.resources.some((resource) => normalName(resource.name) === key) || firms.has(key)) {
          errors.push(`${op.name} is already on this project; use assign_crew to give them work.`);
        } else {
          // A firm the edit adds: later operations in it can give it work, by name or by its trade.
          const firm = { id: -1 - firms.size, name: op.name, trade: op.trade };
          firms.add(key);
          crews.set(key, firm);
          if (!crews.has(normalName(op.trade))) crews.set(normalName(op.trade), firm);
        }
        lines.push(`Add ${op.name} (${op.trade}) to the project’s firms`);
        break;
      }
      case 'assign_crew': {
        const crew = crews.get(normalName(op.crew));
        if (!crew) errors.push(`There is no crew called "${op.crew}" on this project (crews: ${plan.resources.map((resource) => (resource.trade ? `${resource.name} (${resource.trade})` : resource.name)).join(', ')}).`);
        lines.push(`Give ${named(op.task)} to ${crew?.name ?? op.crew}${op.units !== 100 ? ` (${op.units}%)` : ''}`);
        break;
      }
      case 'unassign_crew': {
        const crew = crews.get(normalName(op.crew));
        if (!crew || !plan.assignments.some((assignment) => assignment.taskId === op.task && assignment.resourceId === crew.id)) {
          errors.push(`${nameOf(op.task)} has no crew called "${op.crew}".`);
        }
        lines.push(`Take ${crew?.name ?? op.crew} off ${nameOf(op.task)}`);
        break;
      }
      case 'set_rental': {
        const crew = crews.get(normalName(op.machine));
        const task = byId.get(op.task);
        if (!crew || !plan.assignments.some((assignment) => assignment.taskId === op.task && assignment.resourceId === crew.id)) {
          errors.push(`${nameOf(op.task)} has no machine called "${op.machine}".`);
        }
        if (op.last_day < op.first_day) errors.push('A rental cannot end before it starts.');
        if (task && (op.first_day > task.start || addDays(op.last_day, 1) < task.end)) warnings.push(`${crew?.name ?? op.machine} would not be there for all of ${quoted(task.name)}.`);
        const onRent = rentalDays(op.first_day, addDays(op.last_day, 1));
        lines.push(`${crew?.name ?? op.machine} on rent ${formatDay(op.first_day)} to ${formatDay(op.last_day)} (${onRent} ${onRent === 1 ? 'day' : 'days'}), for ${nameOf(op.task)}`);
        break;
      }
      case 'add_snippet': {
        const snippet = library.find((candidate) => candidate.id === op.snippet_id);
        if (!snippet) errors.push(`There is no library snippet ${op.snippet_id}; use list_library for the ids.`);
        const places = [op.after, op.inside, op.before].filter((value) => value !== undefined);
        if (places.length !== 1) errors.push('add_snippet needs exactly one of after, inside or before.');
        if (op.inside !== undefined && byId.has(op.inside) && !isGroup(op.inside)) errors.push(`${nameOf(op.inside)} is a task, not a group; use after.`);
        if (op.before !== undefined && byId.get(op.before)?.parentId === null) warnings.push(`${nameOf(op.before)} is at the top level.`);
        const where = op.after !== undefined ? `after ${nameOf(op.after)}` : op.inside !== undefined ? `at the end of ${nameOf(op.inside)}` : op.before !== undefined ? `before ${nameOf(op.before)}` : '';
        const name = op.name ?? snippet?.name ?? op.snippet_id;
        // Work done once for the whole building (ordering, delivery) can stay where the piece first went.
        let without = '';
        if (op.leave_out && snippet) {
          const tasks = new Map(leavesOf(snippet.children).map((task) => [normalName(task.name), task.name]));
          const unknown = op.leave_out.filter((left) => !tasks.has(normalName(left)));
          if (unknown.length > 0) errors.push(`${quoted(snippet.name)} has no task called ${unknown.map(quoted).join(' or ')}; its tasks are ${[...tasks.values()].map(quoted).join(', ')}.`);
          else if (new Set(op.leave_out.map(normalName)).size >= tasks.size) errors.push(`leave_out would leave nothing of ${quoted(snippet.name)}.`);
          else without = `, without ${op.leave_out.map((left) => quoted(tasks.get(normalName(left))!)).join(' and ')},`;
        }
        // A place that already comes after it (floors one after another) gets no extra link.
        const already = op.waits_for !== undefined && op.after !== undefined && (op.after === op.waits_for || waitsThrough(plan, op.waits_for, op.after));
        const waits = op.waits_for !== undefined && !already ? `, waiting for ${nameOf(op.waits_for)}` : '';
        if (op.waits_for !== undefined && deleted.has(op.waits_for)) errors.push(`${nameOf(op.waits_for)} is deleted earlier in this edit.`);
        lines.push(`Add ${quoted(name)}${op.repeats > 1 ? ` × ${op.repeats}` : ''}${without} from the library ${where}${waits} (${MODE_WORDS[op.mode]})`);
        break;
      }
      case 'set_cost': {
        const task = byId.get(op.task);
        const name = nameOf(op.task);
        if (task && !task.isLeaf) errors.push(`${name} is a group; what it costs comes from its tasks.`);
        if (task && task.paidMinor > 0) errors.push(`${name} is already paid for; its cost can't change.`);
        if (op.amount === undefined && op.label === undefined && op.payee === undefined) errors.push(`set_cost for ${name} changes nothing: give an amount, a label or a payee.`);
        // No amounts here: the card shows them to the people who see costs.
        if (op.amount !== undefined) lines.push(`New cost for ${name}${op.label ? `: ${op.label}` : ''}${op.payee ? `, paid to ${op.payee}` : ''}`);
        else if (op.payee) lines.push(`Pay ${op.payee} for ${name}${op.label ? ` (${op.label})` : ''}`);
        else lines.push(`Relabel the cost of ${name}: ${op.label ?? ''}`);
        break;
      }
    }
  }
  if (errors.length > 0) throw new ToolRefusal(`The edit was not drafted:\n- ${[...new Set(errors)].join('\n- ')}`);
  return { edit_id: editId, title, operations, lines, warnings: [...new Set(warnings)].slice(0, 8) };
}

/** Whether `to` already waits for `from` through the plan's links, however many steps away. */
function waitsThrough(plan: PlanSnapshot, from: number, to: number): boolean {
  const next = new Map<number, number[]>();
  for (const link of plan.dependencies) next.set(link.from, [...(next.get(link.from) ?? []), link.to]);
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    for (const after of next.get(queue.shift()!) ?? []) {
      if (after === to) return true;
      if (!seen.has(after)) {
        seen.add(after);
        queue.push(after);
      }
    }
  }
  return false;
}

function isUnder(plan: PlanSnapshot, task: PlanTask, ancestorId: number): boolean {
  const byId = new Map(plan.tasks.map((other) => [other.id, other]));
  const seen = new Set<number>();
  for (let at = task.parentId; at !== null && !seen.has(at); at = byId.get(at)?.parentId ?? null) {
    if (at === ancestorId) return true;
    seen.add(at);
  }
  return false;
}
