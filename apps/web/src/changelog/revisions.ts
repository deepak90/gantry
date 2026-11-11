/**
 * One `project_revisions` row as a changelog entry. The revision's `$input` is what the person did
 * (a task moved, a link added); everything else in it is what the scheduler worked out as a result
 * (later tasks moving, phases growing). The sentence describes the person's part, the note sums up
 * the follow-on effects, and the actions list both, the person's first, for the expandable details.
 * Revisions with no person-made change (engine corrections) produce no entry.
 */
import { format, money, type CurrencyCode, type ProjectRevisionRow } from '@collab/shared';
import {
  dayShift,
  formatDay,
  formatDuration,
  formatFinish,
  formatPercent,
  plainExcerpt,
  plural,
  shiftPhrase,
} from './format';
import { COST_FIELDS as TASK_COST_FIELDS } from '../gantt/project';
import type { ActionData, ChangelogActor, ChangelogEntry, EntityData, PropertyUpdateData, TextPart } from './model';
import type { ProjectShadow, RecordChange, RecordId, RecordStoreName, ShadowRecord } from './shadow';

export interface RevisionContext {
  canViewCosts: boolean;
  currency: CurrencyCode;
  /** Names from the live project, for records the folded copy has never seen. */
  liveName?: (store: RecordStoreName, id: RecordId) => string | null;
}

/** Friendly labels for the fields people meet in the Gantt (column titles where there is one). */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'Name',
  startDate: 'Start',
  endDate: 'Finish',
  duration: 'Days',
  percentDone: 'Progress',
  effort: 'Effort',
  budgetMinor: 'Budget',
  forecastMinor: 'Forecast',
  incurredMinor: 'Spent',
  paidMinor: 'Paid',
  costCode: 'Cost code',
  note: 'Notes',
  parentId: 'Phase',
  constraintType: 'Constraint type',
  constraintDate: 'Constraint date',
  deadlineDate: 'Deadline',
  manuallyScheduled: 'Manually scheduled',
  inactive: 'Inactive',
  segments: 'Split',
  calendar: 'Calendar',
  fromEvent: 'From',
  toEvent: 'To',
  from: 'From',
  to: 'To',
  type: 'Link type',
  lag: 'Gap',
  active: 'Active',
  event: 'Task',
  resource: 'Crew',
  units: 'Share',
  kind: 'Kind',
  company: 'Company',
  rentalStart: 'On rent from',
  rentalEnd: 'Last day on rent',
  headcount: 'People',
};

/** A label for a stored property name; workflow facts already carry their label. */
export function fieldLabel(property: string): string {
  const known = FIELD_LABELS[property];
  if (known) return known;
  if (/^[A-Z]/.test(property) || property.includes(' ')) return property;
  const words = property.replace(/Minor$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The task's money fields (shown only to people who can see costs). */
const COST_FIELDS: ReadonlySet<string> = new Set(TASK_COST_FIELDS);
/** Ordering bookkeeping and links back to decisions: changes, but nothing a person would read. */
const HIDDEN_FIELDS = new Set(['parentIndex', 'orderedParentIndex', 'decisionRef', 'baselines', 'cls', 'eventColor', 'iconCls', 'effortUnit', 'durationUnit', 'lagUnit']);
/** Fields of a follow-on change that are still worth listing; the rest is the scheduler's arithmetic. */
const FOLLOW_ON_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  tasks: new Set(['startDate', 'endDate', 'duration', 'percentDone']),
  project: new Set(['startDate', 'endDate']),
};
const ORDER_FIELDS = new Set(['parentIndex', 'orderedParentIndex']);
/** What a phase works out from its tasks; Bryntum lists it as input when tasks are added under it. */
const ROLLUP_FIELDS = new Set(['startDate', 'endDate', 'duration', 'effort', 'percentDone', ...ORDER_FIELDS]);
const DATE_FIELDS = new Set(['startDate', 'endDate', 'duration']);

const CONSTRAINT_LABELS: Readonly<Record<string, string>> = {
  startnoearlierthan: 'Start no earlier than',
  startnolaterthan: 'Start no later than',
  finishnoearlierthan: 'Finish no earlier than',
  finishnolaterthan: 'Finish no later than',
  muststarton: 'Must start on',
  mustfinishon: 'Must finish on',
  assoonaspossible: 'As soon as possible',
  aslateaspossible: 'As late as possible',
};

const LINK_TYPES: Readonly<Record<number, string>> = {
  0: 'Start → start',
  1: 'Start → finish',
  2: 'Finish → start',
  3: 'Finish → finish',
};

const ENTITY_TYPES: Readonly<Record<RecordStoreName | 'project', string>> = {
  tasks: 'TaskModel',
  dependencies: 'DependencyModel',
  assignments: 'AssignmentModel',
  resources: 'ResourceModel',
  calendars: 'CalendarModel',
  project: 'ProjectModel',
};

const MASK = '•••';

function refId(value: unknown): RecordId | null {
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'id' in value) return refId((value as { id: unknown }).id);
  return null;
}

class Describer {
  constructor(
    private readonly shadow: ProjectShadow,
    private readonly ctx: RevisionContext,
  ) {}

  name(store: RecordStoreName, id: RecordId | null): string {
    if (id === null) return 'a task';
    const fallback = store === 'tasks' ? 'a task' : store === 'resources' ? 'a crew' : 'an item';
    return this.shadow.name(store, id) ?? this.ctx.liveName?.(store, id) ?? fallback;
  }

  task(id: RecordId | null): TextPart {
    const name = this.name('tasks', id);
    return typeof id === 'number' && this.shadow.exists('tasks', id) ? { name, taskId: id } : { name };
  }

  /** The record a dependency or assignment was, for a removed one its last known state. */
  record(change: RecordChange): ShadowRecord {
    return change.after ?? change.before ?? {};
  }

  dependencyEnds(change: RecordChange): { from: RecordId | null; to: RecordId | null } {
    const record = this.record(change);
    return { from: refId(record.fromEvent ?? record.from), to: refId(record.toEvent ?? record.to) };
  }

  assignmentEnds(change: RecordChange): { task: RecordId | null; crew: RecordId | null } {
    const record = this.record(change);
    return { task: refId(record.event ?? record.eventId), crew: refId(record.resource ?? record.resourceId) };
  }

  entity(change: RecordChange): EntityData {
    const type = ENTITY_TYPES[change.store];
    switch (change.store) {
      case 'dependencies': {
        const { from, to } = this.dependencyEnds(change);
        const fromEntity: EntityData = { type: 'TaskModel', id: from ?? '?', name: this.name('tasks', from) };
        const toEntity: EntityData = { type: 'TaskModel', id: to ?? '?', name: this.name('tasks', to) };
        return { type, id: change.id, name: `${fromEntity.name} → ${toEntity.name}`, from: fromEntity, to: toEntity };
      }
      case 'assignments': {
        const ends = this.assignmentEnds(change);
        const event: EntityData = { type: 'TaskModel', id: ends.task ?? '?', name: this.name('tasks', ends.task) };
        const resource: EntityData = { type: 'ResourceModel', id: ends.crew ?? '?', name: this.name('resources', ends.crew) };
        return { type, id: change.id, name: `${resource.name} on ${event.name}`, event, resource };
      }
      case 'project':
        return { type, id: 'project', name: 'Project' };
      default:
        return { type, id: change.id, name: this.name(change.store, change.id) };
    }
  }

  value(store: RecordChange['store'], field: string, value: unknown, record: ShadowRecord | null): string {
    if (value === undefined || value === null || value === '') {
      if (field === 'parentId') return 'Top level';
      if (field === 'constraintType') return 'None';
      return '—';
    }
    if (COST_FIELDS.has(field)) {
      return this.ctx.canViewCosts && typeof value === 'number' && Number.isSafeInteger(value) ? format(money(value, this.ctx.currency)) : MASK;
    }
    switch (field) {
      case 'startDate':
      case 'constraintDate':
      case 'deadlineDate':
        return formatDay(value);
      case 'endDate':
        return formatFinish(value, record?.startDate);
      case 'duration':
        return formatDuration(value, record?.durationUnit ?? 'day');
      case 'effort':
        return formatDuration(value, record?.effortUnit ?? 'hour');
      case 'percentDone':
        return formatPercent(value);
      case 'units':
        return formatPercent(value);
      case 'note':
        return plainExcerpt(value);
      case 'parentId':
        return this.name('tasks', refId(value));
      case 'constraintType':
        return CONSTRAINT_LABELS[String(value)] ?? String(value);
      case 'fromEvent':
      case 'toEvent':
      case 'from':
      case 'to':
      case 'event':
        return this.name('tasks', refId(value));
      case 'resource':
        return this.name('resources', refId(value));
      case 'type':
        return store === 'dependencies' ? (LINK_TYPES[Number(value)] ?? String(value)) : String(value);
      case 'lag':
        return formatDuration(value, record?.lagUnit ?? 'day');
      case 'kind':
        return value === 'equipment' ? 'Equipment' : 'Crew';
      case 'rentalStart':
        return formatDay(value);
      case 'rentalEnd':
        return formatFinish(value, record?.rentalStart);
    }
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'number') return String(Math.round(value * 100) / 100);
    if (typeof value === 'string') return plainExcerpt(value);
    return Array.isArray(value) ? plural(value.length, 'part') : '…';
  }

  propertyUpdates(change: RecordChange): PropertyUpdateData[] {
    const followOn = FOLLOW_ON_FIELDS[change.store];
    const input = new Set(change.inputFields);
    return change.fields
      .filter((field) => !HIDDEN_FIELDS.has(field) && (input.has(field) || followOn?.has(field)))
      .sort((a, b) => fieldOrder(a) - fieldOrder(b))
      .map((field) => ({
        property: field,
        before: this.value(change.store, field, change.before?.[field], change.before),
        after: this.value(change.store, field, change.after?.[field], change.after),
      }));
  }

  action(change: RecordChange, isUser: boolean): ActionData | null {
    const entity = this.entity(change);
    if (change.type !== 'update') {
      return { actionType: change.type, entity, isUser };
    }
    const propertyUpdates = this.propertyUpdates(change);
    return propertyUpdates.length > 0 ? { actionType: 'update', entity, propertyUpdates, isUser } : null;
  }
}

const FIELD_ORDER = ['name', 'startDate', 'endDate', 'duration', 'percentDone', 'parentId', 'constraintType', 'constraintDate'];
function fieldOrder(field: string): number {
  const index = FIELD_ORDER.indexOf(field);
  return index < 0 ? FIELD_ORDER.length : index;
}

/** New dates for a machine on a task, not a change of how much it works there. */
const isRentalEdit = (change: RecordChange) => change.inputFields.some((field) => field === 'rentalStart' || field === 'rentalEnd');

/** An update counts as the person's when it changed more than the ordering bookkeeping. */
function isPersonUpdate(change: RecordChange): boolean {
  return change.type === 'update' && change.inputFields.some((field) => !ORDER_FIELDS.has(field));
}

interface Clause {
  parts: TextPart[];
  icon: string;
  taskId?: number;
}

type TaskVerb = 'move' | 'resize' | 'regroup' | 'rename' | 'progress' | 'cost' | 'note' | 'edit';

const TASK_VERB_ICONS: Readonly<Record<TaskVerb, string>> = {
  move: 'fa fa-arrows-left-right',
  resize: 'fa fa-left-right',
  regroup: 'fa fa-folder-tree',
  rename: 'fa fa-pen',
  progress: 'fa fa-circle-half-stroke',
  cost: 'fa fa-coins',
  note: 'fa fa-note-sticky',
  edit: 'fa fa-pen-to-square',
};

function taskVerb(change: RecordChange): TaskVerb {
  const fields = new Set(change.fields);
  const input = new Set(change.inputFields);
  if (input.has('parentId')) return 'regroup';
  if (fields.has('startDate') && (dayShift(change.before?.startDate, change.after?.startDate) ?? 0) !== 0) return 'move';
  if (fields.has('duration') || fields.has('endDate')) return 'resize';
  if (input.has('name')) return 'rename';
  if (input.has('percentDone')) return 'progress';
  if ([...input].some((field) => COST_FIELDS.has(field))) return 'cost';
  if (input.has('note')) return 'note';
  return 'edit';
}

function firstTaskId(parts: readonly TextPart[]): number | undefined {
  for (const part of parts) {
    if (typeof part !== 'string' && part.taskId !== undefined) return part.taskId;
  }
  return undefined;
}

/** "**A**", "**A** and 2 other tasks". */
function taskGroup(d: Describer, ids: readonly RecordId[]): TextPart[] {
  const [first, ...rest] = ids;
  const head = d.task(first ?? null);
  return rest.length === 0 ? [head] : [head, ` and ${plural(rest.length, 'other task')}`];
}

function taskUpdateClauses(d: Describer, updates: readonly RecordChange[], ctx: RevisionContext): Clause[] {
  const byVerb = new Map<TaskVerb, RecordChange[]>();
  for (const change of updates) {
    const verb = taskVerb(change);
    byVerb.set(verb, [...(byVerb.get(verb) ?? []), change]);
  }
  const clauses: Clause[] = [];
  for (const [verb, changes] of byVerb) {
    const ids = changes.map((change) => change.id);
    const icon = TASK_VERB_ICONS[verb];
    const single = changes.length === 1 ? changes[0]! : null;
    let parts: TextPart[];
    switch (verb) {
      case 'move': {
        const shifts = new Set(changes.map((change) => dayShift(change.before?.startDate, change.after?.startDate)));
        const [shift] = [...shifts];
        parts = ['moved ', ...taskGroup(d, ids), shifts.size === 1 && shift ? ` ${shiftPhrase(shift)}` : ''];
        break;
      }
      case 'resize': {
        const before = single?.before?.duration;
        const after = single?.after?.duration;
        if (single && typeof before === 'number' && typeof after === 'number' && before !== after) {
          const days = Math.round((after - before) * 100) / 100;
          parts = ['made ', d.task(single.id), ` ${plural(Math.abs(days), 'day')} ${days > 0 ? 'longer' : 'shorter'}`];
        } else {
          parts = ['changed the length of ', ...taskGroup(d, ids)];
        }
        break;
      }
      case 'regroup':
        parts = single
          ? ['moved ', d.task(single.id), ' under ', d.task(refId(single.after?.parentId))]
          : ['moved ', ...taskGroup(d, ids), ' to another phase'];
        break;
      case 'rename':
        parts = single
          ? ['renamed ', { name: d.value('tasks', 'name', single.before?.name, single.before) }, ' to ', d.task(single.id)]
          : ['renamed ', plural(changes.length, 'task')];
        break;
      case 'progress': {
        const done = single?.after?.percentDone;
        parts = !single
          ? ['updated progress on ', plural(changes.length, 'task')]
          : done === 100
            ? ['marked ', d.task(single.id), ' done']
            : ['set ', d.task(single.id), ` to ${formatPercent(done)} done`];
        break;
      }
      case 'cost': {
        const field = single?.inputFields.find((candidate) => COST_FIELDS.has(candidate));
        const label = field ? (FIELD_LABELS[field] ?? 'cost').toLowerCase() : 'costs';
        parts =
          single && field && ctx.canViewCosts && single.inputFields.filter((candidate) => COST_FIELDS.has(candidate)).length === 1
            ? ['set the ', label, ' of ', d.task(single.id), ` to ${d.value('tasks', field, single.after?.[field], single.after)}`]
            : ['updated the costs of ', ...taskGroup(d, ids)];
        break;
      }
      case 'note':
        parts = ['edited the notes of ', ...taskGroup(d, ids)];
        break;
      default:
        parts = ['edited ', ...taskGroup(d, ids)];
    }
    clauses.push({ parts, icon, taskId: firstTaskId(parts) });
  }
  return clauses;
}

function joinClauses(clauses: readonly Clause[]): TextPart[] {
  const [first, second] = clauses;
  if (!first) return [];
  if (!second) return first.parts;
  if (clauses.length === 2) return [...first.parts, ' and ', ...second.parts];
  return [...first.parts, ', ', ...second.parts, ` and ${plural(clauses.length - 2, 'more change')}`];
}

function actorOf(row: ProjectRevisionRow): ChangelogActor {
  return row.origin === 'agent' ? { type: 'assistant', userId: row.actor_user_id } : { type: 'member', userId: row.actor_user_id };
}

/**
 * Describes one revision right after it was folded into `shadow` (which then knows the records as the
 * revision left them, and the last state of the ones it removed). Null when there is nothing a person
 * did: engine corrections and revisions that only re-numbered rows.
 */
export function describeRevision(
  row: ProjectRevisionRow,
  changes: readonly RecordChange[],
  shadow: ProjectShadow,
  ctx: RevisionContext,
): ChangelogEntry | null {
  if (row.origin === 'engine') return null;
  const d = new Describer(shadow, ctx);
  const of = (store: RecordChange['store'], type: RecordChange['type']) =>
    changes.filter((change) => change.store === store && change.type === type && (type === 'update' ? isPersonUpdate(change) : change.isInput));

  const removedTaskIds = new Set(of('tasks', 'remove').map((change) => String(change.id)));
  const touchesRemovedTask = (...ids: (RecordId | null)[]) => ids.some((id) => id !== null && removedTaskIds.has(String(id)));

  const tasksAdded = of('tasks', 'add');
  // A removed phase takes its tasks along; name the phase, count the rest.
  const tasksRemoved = of('tasks', 'remove').filter((change) => !touchesRemovedTask(refId(change.before?.parentId)));
  let taskUpdates = of('tasks', 'update').filter((change) => !removedTaskIds.has(String(change.id)));
  // A phase growing around new or changed tasks is a result, unless the phase itself is all that changed.
  const isRollup = (change: RecordChange) => shadow.isParentTask(change.id) && change.inputFields.every((field) => ROLLUP_FIELDS.has(field));
  const rollups = new Set(taskUpdates.filter(isRollup));
  const otherInput = changes.some((change) => !rollups.has(change) && change.store !== 'project' && (change.type === 'update' ? isPersonUpdate(change) : change.isInput));
  if (otherInput) taskUpdates = taskUpdates.filter((change) => !rollups.has(change));
  const demoted = otherInput ? rollups : new Set<RecordChange>();
  // Links and crew assignments of removed tasks go with them; they are not separate decisions.
  const linksAdded = of('dependencies', 'add');
  const linksRemoved = of('dependencies', 'remove').filter((change) => {
    const { from, to } = d.dependencyEnds(change);
    return !touchesRemovedTask(from, to);
  });
  const linksChanged = of('dependencies', 'update');
  const crewAdded = of('assignments', 'add');
  const crewRemoved = of('assignments', 'remove').filter((change) => !touchesRemovedTask(d.assignmentEnds(change).task));
  const crewChanged = of('assignments', 'update').filter((change) => !isRentalEdit(change));
  const rentalEdits = of('assignments', 'update').filter(isRentalEdit);

  const clauses: Clause[] = [];

  if (tasksAdded.length === 1) {
    const [added] = tasksAdded;
    const parent = refId(added!.after?.parentId);
    const parentName = parent !== null ? shadow.name('tasks', parent) : null;
    clauses.push({ parts: ['added ', d.task(added!.id), ...(parentName ? [' under ', d.task(parent)] : [])], icon: 'fa fa-plus' });
  } else if (tasksAdded.length > 1) {
    const parents = new Set(tasksAdded.map((change) => String(refId(change.after?.parentId))));
    const parent = parents.size === 1 ? refId(tasksAdded[0]!.after?.parentId) : null;
    const parentName = parent !== null ? shadow.name('tasks', parent) : null;
    clauses.push({ parts: [`added ${plural(tasksAdded.length, 'task')}`, ...(parentName ? [' under ', d.task(parent)] : [])], icon: 'fa fa-plus' });
  }

  if (tasksRemoved.length > 0) {
    const inside = removedTaskIds.size - tasksRemoved.length;
    const parts: TextPart[] =
      tasksRemoved.length === 1
        ? ['removed ', d.task(tasksRemoved[0]!.id), inside > 0 ? ` and the ${plural(inside, 'task')} in it` : '']
        : [`removed ${plural(removedTaskIds.size, 'task')}`];
    clauses.push({ parts, icon: 'fa fa-trash-can' });
  }

  clauses.push(...taskUpdateClauses(d, taskUpdates, ctx));

  const linkParts = (change: RecordChange): TextPart[] => {
    const { from, to } = d.dependencyEnds(change);
    return [d.task(from), ' → ', d.task(to)];
  };
  const more = (list: readonly RecordChange[]) => (list.length > 1 ? ` and ${plural(list.length - 1, 'other link')}` : '');
  if (linksAdded.length > 0) clauses.push({ parts: ['linked ', ...linkParts(linksAdded[0]!), more(linksAdded)], icon: 'fa fa-link' });
  if (linksRemoved.length > 0) clauses.push({ parts: ['unlinked ', ...linkParts(linksRemoved[0]!), more(linksRemoved)], icon: 'fa fa-link-slash' });
  if (linksChanged.length > 0) clauses.push({ parts: ['changed the link ', ...linkParts(linksChanged[0]!), more(linksChanged)], icon: 'fa fa-link' });

  const crewParts = (change: RecordChange, connector: string): TextPart[] => {
    const { task, crew } = d.assignmentEnds(change);
    return [{ name: d.name('resources', crew) }, connector, d.task(task)];
  };
  if (crewAdded.length > 0) {
    clauses.push({ parts: ['put ', ...crewParts(crewAdded[0]!, ' on '), crewAdded.length > 1 ? ` and ${plural(crewAdded.length - 1, 'other crew')}` : ''], icon: 'fa fa-user-plus' });
  }
  if (crewRemoved.length > 0) {
    clauses.push({ parts: ['took ', ...crewParts(crewRemoved[0]!, ' off '), crewRemoved.length > 1 ? ` and ${plural(crewRemoved.length - 1, 'other crew')}` : ''], icon: 'fa fa-user-minus' });
  }
  if (crewChanged.length > 0) clauses.push({ parts: ['changed how much ', ...crewParts(crewChanged[0]!, ' works on ')], icon: 'fa fa-user-gear' });

  for (const change of rentalEdits) {
    clauses.push({ parts: ['changed the dates of ', ...crewParts(change, ' on ')], icon: 'fa fa-calendar-days' });
  }
  for (const [type, verb, icon] of [
    ['add', 'added the crew ', 'fa fa-people-group'],
    ['remove', 'removed the crew ', 'fa fa-people-group'],
    ['update', 'edited the crew ', 'fa fa-people-group'],
  ] as const) {
    const list = of('resources', type);
    if (list.length > 0) clauses.push({ parts: [verb, { name: d.name('resources', list[0]!.id) }, list.length > 1 ? ` and ${plural(list.length - 1, 'other')}` : ''], icon });
  }
  if (changes.some((change) => change.store === 'calendars' && (change.isInput || isPersonUpdate(change)))) {
    clauses.push({ parts: ['changed the working days'], icon: 'fa fa-calendar-days' });
  }

  // Re-numbering alone (a drag within a phase) is still something the person did.
  if (clauses.length === 0) {
    const reordered = changes.filter((change) => change.store === 'tasks' && change.type === 'update' && change.inputFields.length > 0);
    if (reordered.length === 0) return null;
    clauses.push({ parts: ['reordered ', ...taskGroup(d, reordered.map((change) => change.id))], icon: 'fa fa-arrow-down-short-wide' });
  }

  const userTaskIds = new Set([...tasksAdded, ...taskUpdates].map((change) => String(change.id)));
  const followOn = changes.filter(
    (change) =>
      change.store === 'tasks' &&
      change.type === 'update' &&
      !userTaskIds.has(String(change.id)) &&
      change.fields.some((field) => DATE_FIELDS.has(field)) &&
      !shadow.isParentTask(change.id),
  );
  const notes: string[] = [];
  const rentalEdit = rentalEdits.length === 1 ? rentalEdits[0]!.after : null;
  if (rentalEdit) notes.push(`Now ${formatDay(rentalEdit.rentalStart)} to ${formatFinish(rentalEdit.rentalEnd, rentalEdit.rentalStart)}`);
  if (followOn.length > 0) notes.push(`${plural(followOn.length, 'other task')} moved as a result`);
  const project = changes.find((change) => change.store === 'project' && change.fields.includes('endDate'));
  const projectShift = project ? dayShift(project.before?.endDate, project.after?.endDate) : null;
  if (project && projectShift) {
    notes.push(`project now finishes ${formatFinish(project.after?.endDate, project.after?.startDate)} (${shiftPhrase(projectShift)})`);
  }

  // Person-made changes first (VersionGrid sorts them first too), then the follow-on effects.
  const actions: ActionData[] = [];
  for (const change of changes) {
    if (change.store === 'project') continue;
    const isUser = change.type === 'update' ? isPersonUpdate(change) && !demoted.has(change) : change.isInput;
    const action = d.action(change, isUser);
    if (action) actions.push(action);
  }
  if (project) {
    const action = d.action(project, false);
    if (action) actions.push(action);
  }

  // The revision that carried out an approved fix: the task gets the decision reference with its new date rule.
  const publication = taskUpdates.find((change) => change.inputFields.includes('decisionRef') && typeof change.after?.decisionRef === 'string');
  const note = notes.length > 0 ? notes.join(' · ').replace(/^./, (first) => first.toUpperCase()) : undefined;
  const base = {
    id: `rev-${row.revision_no}`,
    occurredAt: row.created_at,
    actor: actorOf(row),
    revisionNo: row.revision_no,
    actions,
    ...(note ? { note } : {}),
  };

  if (publication) {
    const shift = dayShift(publication.before?.startDate, publication.after?.startDate);
    const parts: TextPart[] = [
      'applied the approved fix: ',
      d.task(publication.id),
      ` now starts ${formatDay(publication.after?.startDate)}`,
      shift ? ` (${shiftPhrase(shift)})` : '',
    ];
    return {
      ...base,
      kind: 'fix',
      tone: 'ok',
      icon: 'fa fa-circle-check',
      parts,
      taskId: firstTaskId(parts),
      publicationId: publication.after!.decisionRef as string,
    };
  }

  const parts = joinClauses(clauses);
  const taskId = clauses[0]?.taskId ?? firstTaskId(parts);
  return {
    ...base,
    kind: 'plan',
    tone: row.origin === 'agent' ? 'assistant' : 'neutral',
    icon: clauses[0]!.icon,
    parts,
    ...(taskId !== undefined ? { taskId } : {}),
  };
}
