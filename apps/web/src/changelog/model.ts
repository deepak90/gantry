/**
 * What one changelog entry says, and its form in Bryntum's changelog data model. An entry is plain
 * data (comparable, testable); `toTransactionData` turns it into the fields of a
 * ChangeLogTransactionModel whose `actions` are Bryntum's own ChangeLogAction / ChangeLogEntity /
 * ChangeLogPropertyUpdate objects, which is what VersionGrid renders.
 *
 * Property updates carry display strings: dates, money and names are formatted (and money masked for
 * viewers who may not see costs) when the entry is built, so the store never holds raw amounts.
 */
import {
  ChangeLogAction,
  ChangeLogAssignmentEntity,
  ChangeLogDependencyEntity,
  ChangeLogEntity,
  ChangeLogPropertyUpdate,
  ChangeLogTransactionModel,
} from '@bryntum/gantt';
import type { ModelFieldConfig } from '@bryntum/gantt';
import { firstName, initials } from './format';
import { ASSISTANT_NAME, REMY_GLYPH } from '../assistant/identity';

/** Filters in the panel: schedule edits, the fix being worked out, and money changing hands. */
export type ChangelogKind = 'plan' | 'fix' | 'payment';

export type ChangelogTone = 'neutral' | 'ok' | 'warn' | 'error' | 'paypal' | 'assistant';

export type ChangelogActor =
  | { type: 'member'; userId: string | null }
  /** The voice assistant, acting for `userId`. */
  | { type: 'assistant'; userId: string | null }
  | { type: 'paypal' }
  /** Something the workflow did by itself ("Fix checked"); the text is a whole sentence. */
  | { type: 'system' };

/** A piece of an entry's sentence: plain text, or a name worth highlighting (and opening, for tasks). */
export type TextPart = string | { name: string; taskId?: number };

/** `{ property, before, after }` as display strings; a fact (no before) has `before` undefined. */
export interface PropertyUpdateData {
  property: string;
  before?: string;
  after: string;
}

export interface EntityData {
  /** Bryntum model type name: TaskModel, DependencyModel, AssignmentModel, ResourceModel, ProjectModel, or a workflow noun. */
  type: string;
  id: string | number;
  name: string;
  /** DependencyModel: the linked tasks. */
  from?: EntityData;
  to?: EntityData;
  /** AssignmentModel: the task and the crew. */
  event?: EntityData;
  resource?: EntityData;
}

export interface ActionData {
  actionType: 'add' | 'remove' | 'update';
  entity: EntityData;
  /** Update actions only. */
  propertyUpdates?: PropertyUpdateData[];
  /** Part of what the person did, as opposed to a follow-on effect the scheduler worked out. */
  isUser?: boolean;
}

export interface ChangelogEntry {
  /** `rev-<revision_no>` or `wf-<what>-<row id>[-<stage>]`: stable, so an entry is never listed twice. */
  id: string;
  /** Server timestamp (ISO). */
  occurredAt: string;
  kind: ChangelogKind;
  tone: ChangelogTone;
  /** FontAwesome classes, e.g. `fa fa-arrows-left-right`. */
  icon: string;
  actor: ChangelogActor;
  /** The sentence after the actor's name (the whole sentence for `system`). */
  parts: TextPart[];
  /** Second line: follow-on effects, current status. */
  note?: string;
  revisionNo?: number;
  /** The task the entry is about; clicking its name selects it on the Gantt. */
  taskId?: number;
  /** The approved fix (`publications.id`) this revision carried out into the plan. */
  publicationId?: string;
  actions: ActionData[];
}

export interface Person {
  name: string;
  color: string | null;
}

export type People = ReadonlyMap<string, Person>;

/** Avatar colors for actors without a profile color (tokens: set inline as the avatar's background). */
// Remy's crane sits on ink, as on the tile beside her messages.
const ACTOR_COLORS = { assistant: 'var(--ink)', paypal: 'var(--paypal-navy)', system: 'var(--ink-soft)', unknown: 'var(--cat-none)' } as const;

export interface ResolvedActor {
  /** Who to name in the sentence; empty for `system`. */
  label: string;
  /** Full name (tooltip). */
  title: string;
  initials: string;
  color: string;
  /** Icon instead of initials (assistant, PayPal, the workflow). */
  icon: string | null;
  /** The member the assistant acted for. */
  onBehalfOf: string | null;
}

export function resolveActor(actor: ChangelogActor, people: People): ResolvedActor {
  switch (actor.type) {
    case 'member': {
      const person = actor.userId ? people.get(actor.userId) : undefined;
      return {
        label: person ? firstName(person.name) : 'Someone',
        title: person?.name ?? 'Someone on the project',
        initials: person ? initials(person.name) : '?',
        color: person?.color ?? ACTOR_COLORS.unknown,
        icon: null,
        onBehalfOf: null,
      };
    }
    case 'assistant': {
      const person = actor.userId ? people.get(actor.userId) : undefined;
      return {
        label: ASSISTANT_NAME,
        title: person ? `${ASSISTANT_NAME}, for ${person.name}` : ASSISTANT_NAME,
        initials: 'AI',
        color: ACTOR_COLORS.assistant,
        icon: REMY_GLYPH,
        onBehalfOf: person ? firstName(person.name) : null,
      };
    }
    case 'paypal':
      return { label: 'PayPal', title: 'PayPal', initials: 'PP', color: ACTOR_COLORS.paypal, icon: 'fa-brands fa-paypal', onBehalfOf: null };
    case 'system':
      return { label: '', title: 'The cost review', initials: '', color: ACTOR_COLORS.system, icon: null, onBehalfOf: null };
  }
}

export function partsText(parts: readonly TextPart[]): string {
  return parts.map((part) => (typeof part === 'string' ? part : part.name)).join('');
}

/** The entry as one plain sentence: "Chris moved Pour concrete footings 2 days later". */
export function describeEntry(entry: Pick<ChangelogEntry, 'actor' | 'parts'>, people: People): string {
  const text = partsText(entry.parts);
  const { label } = resolveActor(entry.actor, people);
  if (!label) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return `${label} ${text}`;
}

const isConsequence = (entry: Pick<ChangelogEntry, 'actor'>) => (entry.actor.type === 'system' || entry.actor.type === 'paypal' ? 1 : 0);

/**
 * Newest first. Entries of the same instant (one database transaction) put the higher revision first,
 * and what followed from a person's step ("approval no longer counts") above the step itself.
 */
export function newestFirst(a: ChangelogEntry, b: ChangelogEntry): number {
  return Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || (b.revisionNo ?? 0) - (a.revisionNo ?? 0) || isConsequence(b) - isConsequence(a);
}

// -----------------------------------------------------------------------------------------
// Bryntum's changelog data model
// -----------------------------------------------------------------------------------------

/** The entry's own fields, next to Bryntum's description, occurredAt and actions. */
export class CollabChangeLogTransaction extends ChangeLogTransactionModel {
  static override $name = 'CollabChangeLogTransaction';

  static override fields: ModelFieldConfig[] = [
    { name: 'kind', type: 'string' },
    { name: 'tone', type: 'string' },
    { name: 'icon', type: 'string' },
    { name: 'actor', type: 'object' },
    { name: 'parts', type: 'array' },
    { name: 'note', type: 'string' },
    { name: 'revisionNo', type: 'number' },
    { name: 'taskId', type: 'number' },
    /** Whether it moved money: a cost, a budget, a rental's days or a payment (the Costs filter). */
    { name: 'money', type: 'boolean' },
    /** JSON of the entry the record was last written from: equal signatures mean nothing to update. */
    { name: 'signature', type: 'string', persist: false },
  ];

  declare kind: ChangelogKind;
  declare tone: ChangelogTone;
  declare icon: string;
  declare actor: ChangelogActor;
  declare parts: TextPart[];
  declare note: string | null;
  declare revisionNo: number | null;
  declare taskId: number | null;
  declare money: boolean;
  declare signature: string;
}

/** What a task's money is made of, and the days a machine is paid for: changing any of them changes what is paid. */
const MONEY_FIELDS: ReadonlySet<string> = new Set(['budgetMinor', 'forecastMinor', 'incurredMinor', 'paidMinor', 'costLines', 'rentalStart', 'rentalEnd']);

/** Whether an entry moved money: a payment, a fix (new rental dates and what they cost), or an edit to a cost or a rental's days. */
export function movesMoney(entry: ChangelogEntry): boolean {
  if (entry.kind === 'payment' || entry.kind === 'fix') return true;
  return entry.actions.some((action) => action.propertyUpdates?.some((update) => MONEY_FIELDS.has(update.property)) ?? false);
}

// The public typings leave out the constructors of the immutable changelog value classes.
type EntityConstructor = new (config: { model: { id: string | number; name: string }; type: { $$name: string } }) => ChangeLogEntity;
type DependencyEntityConstructor = new (config: { model: { id: string | number; name: string }; fromTask: ChangeLogEntity; toTask: ChangeLogEntity }) => ChangeLogDependencyEntity;
type AssignmentEntityConstructor = new (config: { model: { id: string | number; name: string }; event: ChangeLogEntity; resource: ChangeLogEntity }) => ChangeLogAssignmentEntity;
type ActionConstructor = new (config: { entity: ChangeLogEntity; actionType: ActionData['actionType'] }) => ChangeLogAction;
type PropertyUpdateConstructor = new (config: { property: string; before?: unknown; after: unknown }) => ChangeLogPropertyUpdate;

const Entity = ChangeLogEntity as unknown as EntityConstructor;
const DependencyEntity = ChangeLogDependencyEntity as unknown as DependencyEntityConstructor;
const AssignmentEntity = ChangeLogAssignmentEntity as unknown as AssignmentEntityConstructor;
const Action = ChangeLogAction as unknown as ActionConstructor;
const PropertyUpdate = ChangeLogPropertyUpdate as unknown as PropertyUpdateConstructor;

/**
 * An update of one entity with its property updates: the shape of Bryntum's ChangeLogUpdateAction,
 * which the package does not export. VersionGrid reads `propertyUpdates` and `isUser` by name.
 */
export class CollabUpdateAction extends Action {
  declare readonly propertyUpdates: ChangeLogPropertyUpdate[];
  declare readonly isUser: boolean;

  constructor({ entity, propertyUpdates, isUser }: { entity: ChangeLogEntity; propertyUpdates: ChangeLogPropertyUpdate[]; isUser: boolean }) {
    super({ entity, actionType: 'update' });
    Object.assign(this, { propertyUpdates, isUser });
    Object.freeze(this);
  }
}

function toEntity(data: EntityData): ChangeLogEntity {
  const model = { id: data.id, name: data.name };
  if (data.from && data.to) {
    return new DependencyEntity({ model, fromTask: toEntity(data.from), toTask: toEntity(data.to) });
  }
  if (data.event && data.resource) {
    return new AssignmentEntity({ model, event: toEntity(data.event), resource: toEntity(data.resource) });
  }
  return new Entity({ model, type: { $$name: data.type } });
}

export function toChangeLogAction(data: ActionData): ChangeLogAction {
  const entity = toEntity(data.entity);
  if (data.actionType === 'update') {
    return new CollabUpdateAction({
      entity,
      propertyUpdates: (data.propertyUpdates ?? []).map((update) => new PropertyUpdate(update)),
      isUser: data.isUser ?? false,
    });
  }
  return new Action({ entity, actionType: data.actionType });
}

/** The record fields for an entry, with the sentence resolved against the people now known. */
export function toTransactionData(entry: ChangelogEntry, people: People, signature: string): Record<string, unknown> {
  return {
    id: entry.id,
    description: describeEntry(entry, people),
    occurredAt: new Date(entry.occurredAt),
    actions: entry.actions.map(toChangeLogAction),
    kind: entry.kind,
    tone: entry.tone,
    icon: entry.icon,
    actor: entry.actor,
    parts: entry.parts,
    note: entry.note ?? null,
    revisionNo: entry.revisionNo ?? null,
    taskId: entry.taskId ?? null,
    money: movesMoney(entry),
    signature,
  };
}
