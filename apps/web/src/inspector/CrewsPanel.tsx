/**
 * The crews tab of the side panel: every crew and piece of equipment on the project as one compact
 * row: its firm's name, its trade as a label (a big site has several crews of one trade, so trades
 * also filter the list), how many tasks it has and when, and whether two of its tasks fall on one
 * day. Rows are dragged onto the plan to put a crew on a task (gantt/crew-drop.ts); with a task
 * selected, the + on a row does the same from the keyboard.
 *
 * Crews are Bryntum resources, so every change here (add, rename, recolor, remove, assign) is an
 * ordinary store change in its own project transaction: one revision per edit, received by everyone
 * like any schedule edit. Removing a crew also takes it off its tasks (Bryntum drops the
 * assignments in the same transaction).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { AssignmentModel, Gantt, ProjectModel, ResourceModel, Store, TaskModel } from '@bryntum/gantt';
import { runProjectTransaction } from '../scenario/publish';
import { assignCrew, attachCrewDrag, crewDropVerdict, pulseTask } from '../gantt/crew-drop';
import { crewColor, crewIcon, lastWorkingDay, original } from '../gantt/look';
import { InspectorHeader } from './Inspector';
import '../styles/crews.css';

import { CREW_PALETTE, freeCrewColor } from './crew-palette';

export { CREW_PALETTE };

export const CREW_ICON_CHOICES = [
  'helmet-safety', 'hammer', 'bolt', 'faucet-drip', 'fan', 'paint-roller',
  'weight-hanging', 'industry', 'truck', 'clipboard-check', 'stethoscope', 'network-wired',
  'person-digging', 'trowel-bricks', 'screwdriver-wrench', 'toolbox', 'ruler-combined', 'plug',
] as const;

type CrewKind = 'labor' | 'equipment';
type KindFilter = 'all' | CrewKind;

const KIND_LABELS: Readonly<Record<CrewKind, string>> = { labor: 'Crews', equipment: 'Equipment' };

const DAY_MS = 86_400_000;

/** One week of a crew's workload: working days with at least one task, and whether two tasks overlap on a day. */
export interface WeekLoad {
  start: Date;
  days: number;
  clash: boolean;
}

interface CrewRow {
  resource: ResourceModel;
  key: string;
  name: string;
  company: string;
  /** What the crew does, or the kind of equipment: shown as a label. */
  trade: string;
  kind: CrewKind;
  color: string;
  icon: string;
  logo: string | null;
  tasks: TaskModel[];
  firstStart: Date | null;
  lastEnd: Date | null;
  load: WeekLoad[];
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const mondayOf = (date: Date) => {
  const day = startOfDay(date);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7));
};
const isDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());

/** The stretches a task actually works: its pieces when it is split, else start to end. */
function workSpans(task: TaskModel): [Date, Date][] {
  const segments = (task as TaskModel & { segments?: { startDate?: Date; endDate?: Date }[] | null }).segments;
  const spans = Array.isArray(segments) && segments.length ? segments.map((segment) => [segment.startDate, segment.endDate]) : [[task.startDate, task.endDate]];
  return spans.filter((span): span is [Date, Date] => isDate(span[0]) && isDate(span[1]));
}

/**
 * Week-by-week workload of a crew between `from` and `to`: how many weekdays it has work, and
 * whether two of its tasks fall on the same day (it is double-booked).
 */
export function weeklyLoad(tasks: readonly TaskModel[], from: Date, to: Date): WeekLoad[] {
  const first = mondayOf(from);
  const weeks = Math.max(1, Math.ceil((startOfDay(to).getTime() - first.getTime() + DAY_MS) / (7 * DAY_MS)));
  const perDay = new Map<number, number>();
  for (const task of tasks) {
    for (const [start, end] of workSpans(task)) {
      for (let day = startOfDay(start); day < end; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
        if (day.getDay() === 0 || day.getDay() === 6) continue;
        const index = Math.round((day.getTime() - first.getTime()) / DAY_MS);
        if (index >= 0 && index < weeks * 7) perDay.set(index, (perDay.get(index) ?? 0) + 1);
      }
    }
  }
  return Array.from({ length: weeks }, (_, week) => {
    let days = 0;
    let clash = false;
    for (let offset = 0; offset < 7; offset += 1) {
      const count = perDay.get(week * 7 + offset) ?? 0;
      if (count > 0) days += 1;
      if (count > 1) clash = true;
    }
    return { start: new Date(first.getFullYear(), first.getMonth(), first.getDate() + week * 7), days, clash };
  });
}

function crewRows(project: ProjectModel): CrewRow[] {
  const resources = project.resourceStore.allRecords as ResourceModel[];
  const from = isDate(project.startDate) ? project.startDate : null;
  const to = isDate(project.endDate) ? project.endDate : null;
  return resources.map((resource) => {
    const tasks = ((resource as ResourceModel & { assignments?: AssignmentModel[] }).assignments ?? [])
      .map((assignment) => assignment.event as TaskModel | null)
      .filter((task): task is TaskModel => Boolean(task));
    const starts = tasks.map((task) => task.startDate).filter(isDate);
    const ends = tasks.map((task) => lastWorkingDay(task)).filter(isDate);
    const record = resource as ResourceModel & { company?: string; kind?: string; trade?: string };
    return {
      resource,
      key: String(resource.id),
      name: resource.name ?? '',
      company: record.company ?? '',
      trade: record.trade?.trim() ?? '',
      kind: record.kind === 'equipment' ? 'equipment' : 'labor',
      color: crewColor(resource),
      icon: crewIcon(resource),
      logo: typeof resource.imageUrl === 'string' && resource.imageUrl ? resource.imageUrl : null,
      tasks,
      firstStart: starts.length ? new Date(Math.min(...starts.map((date) => date.getTime()))) : null,
      lastEnd: ends.length ? new Date(Math.max(...ends.map((date) => date.getTime()))) : null,
      load: from && to ? weeklyLoad(tasks, from, to) : [],
    };
  });
}

const shortDate = (date: Date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Re-renders when crews, their assignments or the schedule change (local edits and revisions alike). */
function useCrewVersion(project: ProjectModel): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((current) => current + 1);
    const detachers = [
      project.resourceStore.on('change', bump),
      project.assignmentStore.on('change', bump),
      project.on('dataReady', bump),
    ] as unknown as ((() => void) | undefined)[];
    return () => detachers.forEach((detach) => detach?.());
  }, [project]);
  return version;
}

/** The crew's logo over its colored icon: the icon shows when there is no logo or it fails to load. */
function CrewLogo({ row }: { row: Pick<CrewRow, 'icon' | 'logo' | 'color'> }) {
  return (
    <span className="crew-logo" aria-hidden="true" style={{ '--crew': row.color } as CSSProperties}>
      <i className={`fa fa-${row.icon}`} />
      {row.logo && <img src={row.logo} alt="" draggable={false} />}
    </span>
  );
}

/** The trade as a label, with the crew's color as its dot. */
function TradeLabel({ row }: { row: Pick<CrewRow, 'trade' | 'color' | 'kind'> }) {
  return (
    <span className="pill is-label is-sm crew-trade">
      <i className="pill-dot" style={{ '--pill-dot': row.color } as CSSProperties} />
      {row.trade || (row.kind === 'equipment' ? 'Equipment' : 'No trade yet')}
    </span>
  );
}

export interface CrewsPanelProps {
  project: ProjectModel;
  /** The Gantt that crews are dragged onto (undefined until it has rendered). */
  gantt(): Gantt | undefined;
  /** Filters the Gantt to one crew's tasks (sets the search box). */
  onShowTasks(name: string): void;
  /** The task selected in the plan: the + on a row puts that crew on it. */
  selectedTaskId?: number | null;
}

export function CrewsPanel({ project, gantt, onShowTasks, selectedTaskId = null }: CrewsPanelProps) {
  const version = useCrewVersion(project);
  const rows = useMemo(() => crewRows(project), [project, version]);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [tradeFilter, setTradeFilter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ResourceModel | null>(null);
  // The group a row was in when its editor opened: switching it between crew and equipment moves it to
  // the other group only once the editor closes, not under the pointer while it is being edited.
  const [heldKind, setHeldKind] = useState<CrewKind | null>(null);
  useEffect(() => {
    setHeldKind(editing ? ((editing as ResourceModel & { kind?: string }).kind === 'equipment' ? 'equipment' : 'labor') : null);
  }, [editing]);
  const [confirming, setConfirming] = useState<ResourceModel | null>(null);
  const [focusNew, setFocusNew] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const ganttRef = useRef(gantt);
  ganttRef.current = gantt;

  // Rows are dragged with Bryntum's DragHelper; it reads the crew and the Gantt when a drag starts.
  useEffect(() => {
    const source = listRef.current;
    if (!source) return undefined;
    return attachCrewDrag({
      source,
      project,
      gantt: () => ganttRef.current(),
      crewFor: (card) => rowsRef.current.find((row) => row.key === card.dataset.crewId)?.resource ?? null,
      onError: (message) => setError(message),
    });
  }, [project]);

  const selectedTask = selectedTaskId === null ? null : ((project.taskStore.getById(selectedTaskId) as TaskModel | undefined) ?? null);

  const change = (title: string, apply: () => void) => {
    setError(null);
    return runProjectTransaction(project, title, apply).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const update = (resource: ResourceModel, values: Record<string, unknown>) => change('Edit crew', () => resource.set(values));

  const addCrew = () => {
    const color = freeCrewColor(rows.map((row) => row.color));
    let added: ResourceModel | undefined;
    setQuery('');
    setKindFilter('all');
    setTradeFilter(null);
    void change('Add crew', () => {
      // `kind`, `company` and `trade` are CollabResource fields the ResourceModel config type does not know.
      [added] = project.resourceStore.add({ name: 'New crew', kind: 'labor', company: '', trade: '', eventColor: color, iconCls: 'fa fa-helmet-safety' } as object) as ResourceModel[];
    }).then(() => {
      if (!added) return;
      setEditing(added);
      setFocusNew(true);
      window.requestAnimationFrame(() => listRef.current?.querySelector(`[data-crew-id="${CSS.escape(String(added?.id))}"]`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
    });
  };

  const removeCrew = (resource: ResourceModel) => {
    setConfirming(null);
    setEditing(null);
    void change('Remove crew', () => {
      project.resourceStore.remove(resource);
    });
  };

  const putOnSelected = (row: CrewRow) => {
    if (!selectedTask) return;
    setError(null);
    assignCrew(project, selectedTask, row.resource)
      .then((added) => {
        const instance = gantt();
        // The same confirmation as a drop, on the row the plan shows (a copy while grouped).
        const shown = (instance?.store as Store | undefined)?.getById(selectedTask.id) as TaskModel | undefined;
        if (added && instance && shown) pulseTask(instance, shown, row.resource);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const needle = query.trim().toLowerCase();
  const matchesQuery = (row: CrewRow) =>
    !needle || row.name.toLowerCase().includes(needle) || row.company.toLowerCase().includes(needle) || row.trade.toLowerCase().includes(needle);
  const placedKind = (row: CrewRow): CrewKind => (row.resource === editing && heldKind ? heldKind : row.kind);
  const ofKind = rows.filter((row) => kindFilter === 'all' || placedKind(row) === kindFilter);
  // Trades of what is shown, most crews first. Only trades with several firms filter the list (a big
  // site has many HVAC crews); a trade with one firm is found by searching.
  const trades = [...ofKind.reduce((map, row) => (row.trade ? map.set(row.trade, (map.get(row.trade) ?? 0) + 1) : map), new Map<string, number>())].sort(
    ([a, countA], [b, countB]) => countB - countA || a.localeCompare(b),
  );
  const tradeFilters = trades.filter(([, count]) => count > 1);
  const shown = ofKind.filter((row) => row.resource === editing || (matchesQuery(row) && (!tradeFilter || row.trade === tradeFilter)));
  const counts = { all: rows.length, labor: rows.filter((row) => row.kind === 'labor').length, equipment: rows.filter((row) => row.kind === 'equipment').length };
  const groups = (['labor', 'equipment'] as const).map((kind) => ({ kind, rows: shown.filter((row) => placedKind(row) === kind) })).filter((group) => group.rows.length > 0);

  return (
    <div className="inspector-body crews-panel" data-testid="crew-manager">
      <InspectorHeader
        icon="people-group"
        title="Crews"
        subtitle="Who does the work, and the equipment on site. Drag one onto a task to put it there."
        actions={
          <button type="button" className="button is-sm" data-testid="add-crew" onClick={addCrew}>
            <i className="fa fa-plus" aria-hidden="true" /> Add crew
          </button>
        }
      />
      <div className="crews-tools">
        <label className="input-icon crews-search">
          <i className="fa fa-magnifying-glass" aria-hidden="true" />
          <input className="input" type="search" value={query} placeholder="Find a firm, trade or machine" aria-label="Find a crew, trade or company" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="segmented crews-filter" role="radiogroup" aria-label="Show">
          {(['all', 'labor', 'equipment'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={kindFilter === kind}
              onClick={() => {
                setKindFilter(kind);
                setTradeFilter(null);
              }}
            >
              {kind === 'all' ? 'All' : KIND_LABELS[kind]} <span className="crews-filter-count">{counts[kind]}</span>
            </button>
          ))}
        </div>
        {tradeFilters.length > 0 && (
          <div className="crews-trades" role="group" aria-label="Trades with several firms">
            {tradeFilters.map(([trade, count]) => (
              <button
                key={trade}
                type="button"
                className={`pill is-sm ${tradeFilter === trade ? 'is-info' : 'is-label'}`}
                aria-pressed={tradeFilter === trade}
                onClick={() => setTradeFilter(tradeFilter === trade ? null : trade)}
              >
                {trade}
                <span className="crews-trade-count">{count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {error && (
        <p className="note is-danger crews-error" role="alert">
          <i className="fa fa-circle-exclamation" aria-hidden="true" /> Could not save: {error}
        </p>
      )}
      <div className="crews-groups" ref={listRef}>
        {groups.map((group) => (
          <section key={group.kind} className="crews-group" aria-label={KIND_LABELS[group.kind]}>
            {groups.length > 1 && (
              <p className="section-label crews-group-label">
                {KIND_LABELS[group.kind]} <span>{group.rows.length}</span>
              </p>
            )}
            <ul className="crews-list" aria-label={KIND_LABELS[group.kind]}>
              {group.rows.map((row) => {
                const isEditing = editing === row.resource;
                const verdict = selectedTask ? crewDropVerdict(selectedTask, row.resource, Boolean(gantt()?.readOnly)) : null;
                const doubleBooked = row.load.some((week) => week.clash);
                return (
                  <li key={row.key} className={`crew-row${isEditing ? ' is-editing' : ''}`} style={{ '--crew': row.color } as CSSProperties} data-crew-id={row.key} data-testid="crew-row">
                    <div className="crew-row-main" title={`Drag ${row.name || 'this crew'} onto a task in the plan`}>
                      <CrewLogo row={row} />
                      <div className="crew-row-text">
                        <span className="crew-row-name">{row.name || 'Unnamed crew'}</span>
                        <span className="crew-row-meta">
                          <TradeLabel row={row} />
                          {row.kind === 'equipment' && row.company && <span className="crew-row-company">{row.company}</span>}
                          <button type="button" className="button is-link crew-row-tasks" disabled={row.tasks.length === 0} onClick={() => onShowTasks(row.name)} title="Show its tasks in the plan">
                            {row.tasks.length === 0 ? 'No tasks yet' : plural(row.tasks.length, 'task')}
                          </button>
                          {row.firstStart && row.lastEnd && <span className="crew-row-dates num">{`${shortDate(row.firstStart)} – ${shortDate(row.lastEnd)}`}</span>}
                          {doubleBooked && (
                            <span className="pill is-warning is-sm" title="Two of its tasks fall on the same day">
                              Double-booked
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="crew-row-actions">
                        {verdict?.ok && selectedTask && (
                          <button
                            type="button"
                            className="button is-quiet is-icon is-sm crew-put"
                            title={`Put ${row.name} on “${original(selectedTask).name ?? 'the selected task'}”`}
                            aria-label={`Put ${row.name} on ${original(selectedTask).name ?? 'the selected task'}`}
                            onClick={() => putOnSelected(row)}
                          >
                            <i className="fa fa-plus" aria-hidden="true" />
                          </button>
                        )}
                        <button
                          type="button"
                          className="button is-quiet is-icon is-sm crew-edit"
                          aria-expanded={isEditing}
                          aria-label={`Edit ${row.name}`}
                          title="Edit"
                          onClick={() => {
                            setConfirming(null);
                            setEditing(isEditing ? null : row.resource);
                          }}
                        >
                          <i className={`fa fa-${isEditing ? 'chevron-up' : 'pen'}`} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    {isEditing && (
                      <CrewEditor
                        row={row}
                        trades={trades.map(([trade]) => trade)}
                        autoFocus={focusNew}
                        onFocused={() => setFocusNew(false)}
                        confirming={confirming === row.resource}
                        onUpdate={(values) => update(row.resource, values)}
                        onAskRemove={() => setConfirming(row.resource)}
                        onCancelRemove={() => setConfirming(null)}
                        onRemove={() => removeCrew(row.resource)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {shown.length === 0 && (
        <div className="empty-state">
          <p className="empty-state-title">{rows.length === 0 ? 'No crews yet' : 'Nothing matches'}</p>
          <p>{rows.length === 0 ? 'Add the firms working on site, then drag them onto their tasks.' : 'Try another name or trade, or show everything.'}</p>
        </div>
      )}
    </div>
  );
}

interface CrewEditorProps {
  row: CrewRow;
  /** Trades already on the project, offered as suggestions. */
  trades: readonly string[];
  autoFocus: boolean;
  onFocused(): void;
  confirming: boolean;
  onUpdate(values: Record<string, unknown>): void;
  onAskRemove(): void;
  onCancelRemove(): void;
  onRemove(): void;
}

/**
 * A crew's firm and trade (or a machine's name, kind and supplier), kind, color and icon; each
 * change is saved when it is made. A crew goes by its firm's name, so renaming the firm renames it.
 */
function CrewEditor({ row, trades, autoFocus, onFocused, confirming, onUpdate, onAskRemove, onCancelRemove, onRemove }: CrewEditorProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    nameRef.current?.focus();
    nameRef.current?.select();
    onFocused();
  }, [autoFocus, onFocused]);

  const commitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
  };
  const equipment = row.kind === 'equipment';
  const listId = `crew-trades-${row.key}`;

  return (
    <div className="crew-editor" data-no-drag>
      <label className="field">
        <span className="field-label">{equipment ? 'Name' : 'Firm'}</span>
        <input
          ref={nameRef}
          className="input"
          defaultValue={row.name}
          key={`name-${row.name}`}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (!value || value === row.name) {
              event.target.value = row.name;
              return;
            }
            // A crew is its firm: keep the company in step unless it was set to something else.
            onUpdate(!equipment && (row.company === row.name || !row.company) ? { name: value, company: value } : { name: value });
          }}
          onKeyDown={commitOnEnter}
        />
      </label>
      <label className="field">
        <span className="field-label">{equipment ? 'Kind of equipment' : 'Trade'}</span>
        <input
          className="input"
          list={listId}
          defaultValue={row.trade}
          key={`trade-${row.trade}`}
          placeholder={equipment ? 'Equipment rental, Lifting …' : 'Electrical, HVAC, Plumbing …'}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (value !== row.trade) onUpdate({ trade: value });
          }}
          onKeyDown={commitOnEnter}
        />
        <datalist id={listId}>
          {trades.map((trade) => (
            <option key={trade} value={trade} />
          ))}
        </datalist>
      </label>
      {equipment && (
        <label className="field">
          <span className="field-label">Rented from</span>
          <input
            className="input"
            defaultValue={row.company}
            key={`company-${row.company}`}
            placeholder="Who rents it out"
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value !== row.company) onUpdate({ company: value });
            }}
            onKeyDown={commitOnEnter}
          />
        </label>
      )}
      <div className="field">
        <span className="field-label" id={`crew-kind-${row.key}`}>
          Kind
        </span>
        <div className="segmented crew-kind" role="radiogroup" aria-labelledby={`crew-kind-${row.key}`}>
          {(['labor', 'equipment'] as const).map((kind) => (
            <button key={kind} type="button" role="radio" aria-checked={row.kind === kind} onClick={() => row.kind !== kind && onUpdate({ kind })}>
              {kind === 'labor' ? 'Crew' : 'Equipment'}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label" id={`crew-color-${row.key}`}>
          Color on the plan
        </span>
        <div className="crew-swatches" role="radiogroup" aria-labelledby={`crew-color-${row.key}`}>
          {CREW_PALETTE.map((color) => (
            <button key={color} type="button" role="radio" aria-checked={color === row.color} aria-label={color} style={{ background: color }} onClick={() => color !== row.color && onUpdate({ eventColor: color })} />
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label" id={`crew-icon-${row.key}`}>
          {row.logo ? 'Icon (on task names; the logo stays on badges)' : 'Icon'}
        </span>
        <div className="crew-icons" role="radiogroup" aria-labelledby={`crew-icon-${row.key}`}>
          {CREW_ICON_CHOICES.map((icon) => (
            <button key={icon} type="button" role="radio" aria-checked={icon === row.icon} aria-label={icon.replace(/-/g, ' ')} onClick={() => icon !== row.icon && onUpdate({ iconCls: `fa fa-${icon}` })}>
              <i className={`fa fa-${icon}`} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
      {confirming ? (
        <div className="note is-danger crew-confirm" role="alert">
          <span>
            Remove {row.name || 'this crew'}
            {row.tasks.length > 0 ? ` from ${plural(row.tasks.length, 'task')}` : ''}?
          </span>
          <button type="button" className="button is-danger is-primary is-sm" onClick={onRemove}>
            Remove
          </button>
          <button type="button" className="button is-sm" onClick={onCancelRemove}>
            Keep
          </button>
        </div>
      ) : (
        <button type="button" className="button is-danger is-sm crew-remove" onClick={onAskRemove}>
          <i className="fa fa-trash-can" aria-hidden="true" /> Remove
        </button>
      )}
    </div>
  );
}
