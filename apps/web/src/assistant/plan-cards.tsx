/**
 * The assistant's plan cards: tasks (a list or one in detail), charts, what a schedule check found,
 * a drafted plan change with Apply, snippet drafts with "Save to library", and next-step chips. The
 * model chooses the card and names the tasks; everything about a task (dates, crews, links, slack)
 * and every chart value is read here from the live plan, so a card always agrees with the Gantt.
 *
 * A drafted change previews itself on a throwaway copy of the plan and is applied, as one change for
 * everyone, by whoever presses Apply; the thread then says who applied (or dismissed) it, so every
 * viewer sees the same state.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import {
  addDays,
  format,
  money as moneyOf,
  leavesOf,
  rentalDays,
  snippetSpan,
  type ChartCard as ChartCardProps,
  type CurrencyCode,
  type FindingsCard as FindingsCardProps,
  type FollowUps as FollowUpsProps,
  type PlanEditCard as PlanEditCardProps,
  type PlanEditOp,
  type SnippetDraft,
  type SnippetsCard as SnippetsCardProps,
  type TaskCard as TaskCardProps,
  type TasksCard as TasksCardProps,
} from '@collab/shared';
import { crewMatcher } from '../library/insert';
import { formatDay } from '../library/describe';
import { SnippetBuilder, builderCrews, folderOptions } from '../library/SnippetBuilder';
import { SnippetMiniTimeline } from '../library/SnippetTimeline';
import type { LibraryStore } from '../library/store';
import { useLibrarySnapshot } from '../library/useLibrary';
import { crewColor } from '../gantt/look';
import { CardShell, type CardEnv } from './cards';
import { liveLinks, liveTask, phaseFigures, tightestTasks, workloadGrid, type LiveTask } from './live-plan';
import { whenSaved } from '../scenario/publish';
import { applyPlanEdit, previewPlanEdit, tasksTouched, type EditPreview } from './plan-edit';
import { CostChart } from './cost-charts';
import { withheldText } from './rich-text';
import { ASSISTANT_NAME } from './identity';
import { RemyMark } from './RemyMark';
import { walkPlan } from '../gantt/walk';

/** What a card did after it was shown, read from the thread (the person's later message with its action). */
export interface CardOutcome {
  kind: 'applied' | 'dismissed' | 'saved';
  by: string;
  at: string;
  /** Applied by itself under the person's approval mode. */
  auto?: boolean;
}

export interface PlanCardEnv extends CardEnv {
  project: ProjectModel;
  library: LibraryStore | null;
  /** Moves whenever the plan changes, so live figures are read again. */
  dataVersion: number;
  /** Selects the tasks in the plan and brings the first into view. */
  showTasks(ids: readonly number[]): void;
  /** Remy's cursor goes to the first of these tasks, so a change just applied is seen. */
  pointAt?(ids: readonly number[]): void;
  /** Lights these tasks' rows in the Gantt while a chart mark is hovered; returns how to put them back. */
  markTasks?(ids: readonly number[]): () => void;
  /** Posts to the thread as the viewer (`context` replaces parts of what is sent along). */
  send(text: string, action?: import('@collab/shared').AgentAction | null, context?: Partial<import('@collab/shared').AgentMessageContext>): void;
  outcome: CardOutcome | null;
  /** The tool-use id of the card: what its buttons name in their action. */
  cardId: string;
  /**
   * How this tab may apply the change by itself: set only for a change that answers a question this
   * tab just sent, to the approval mode the person asked under ('ask' or absent: never).
   */
  autoApply?: import('@collab/shared').ApprovalMode | null;
  /** The rental booked on a task, for what a change to its dates comes to. */
  bookingOn?: (taskId: number) => import('@collab/shared').EquipmentBookingRow | null;
}

/** Changes the "ask if risky" mode always leaves to a person: anything that removes, unlinks, moves the handover or is big. */
export function isRiskyEdit(operations: readonly PlanEditOp[], preview: EditPreview | null): string | null {
  if (operations.some((operation) => operation.op === 'delete_task')) return 'it deletes tasks';
  if (operations.some((operation) => operation.op === 'unlink')) return 'it removes links';
  if (operations.some((operation) => operation.op === 'set_cost' && operation.payee !== undefined)) return 'it changes who is paid';
  if (operations.length > 10) return `it has ${operations.length} steps`;
  if (!preview || preview.error) return 'it could not be checked';
  if (preview.removed > 0) return 'it removes tasks';
  if (preview.handoverBefore && preview.handoverAfter && preview.handoverBefore.getTime() !== preview.handoverAfter.getTime()) return 'it moves the handover';
  if (preview.moved.length > 10) return `${preview.moved.length} tasks move`;
  return null;
}

/** Cards applied by themselves in this tab, so a re-render or a second card view never applies one twice. */
const autoApplied = new Set<string>();

const shortDay = (date: Date | null) => (date ? formatDay(date).replace(/, \d{4}$/, '') : '—');
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function TaskChip({ id, env }: { id: number; env: PlanCardEnv }) {
  const task = liveTask(env.project, id);
  return (
    <button type="button" className="pill is-label pc-chip" onClick={() => env.showTasks([id])} title={task ? `${task.path.join(' › ')} › ${task.name}` : `Task ${id}`}>
      {task?.critical && <i className="fa fa-bolt pc-critical-mark" aria-label="Sets the handover date" />}
      {task?.name ?? `Task ${id} (removed)`}
    </button>
  );
}

function CrewDots({ crews }: { crews: LiveTask['crews'] }) {
  return (
    <span className="pc-crews">
      {crews.slice(0, 3).map((crew) => (
        <span key={crew.name} className="pc-crew" title={`${crew.name}${crew.units !== 100 ? ` (${crew.units}%)` : ''}`}>
          <span className="pill-dot" style={{ '--pill-dot': crew.color } as CSSProperties} />
          {crew.name}
        </span>
      ))}
      {crews.length > 3 && <span className="pc-more">+{crews.length - 3}</span>}
    </span>
  );
}

// ---- tasks -------------------------------------------------------------------------------------

export function TasksCardView({ card, env }: { card: Partial<TasksCardProps>; env: PlanCardEnv }) {
  const ids = card.task_ids ?? [];
  const rows = useMemo(() => ids.map((id) => ({ id, task: liveTask(env.project, id) })), [ids.join(','), env.dataVersion]);
  return (
    <CardShell kind="tasks" icon="list-check" kicker="From the plan" env={env} testId="assistant-card-tasks">
      <h4 className="ac-title">{card.title ?? <span className="ac-skeleton" />}</h4>
      {card.note && <p className="ac-text">{withheldText(card.note)}</p>}
      <ol className="pc-task-list">
        {rows.map(({ id, task }) => (
          <li key={id} className={task?.critical ? 'is-critical' : undefined}>
            <button type="button" className="pc-task-name" onClick={() => env.showTasks([id])}>
              {task?.critical && <i className="fa fa-bolt pc-critical-mark" aria-label="Sets the handover date" />}
              <strong>{task?.name ?? `Task ${id} (removed)`}</strong>
              {task && task.path.length > 0 && <span className="pc-path">{task.path.at(-1)}</span>}
            </button>
            {task && (
              <span className="pc-task-facts">
                <span>
                  {shortDay(task.start)} → {shortDay(task.end)}
                </span>
                <span>{task.isMilestone ? 'milestone' : `${task.days}d`}</span>
                {task.percentDone > 0 && <span>{task.percentDone}%</span>}
                {task.slackDays !== null && !task.critical && task.slackDays <= 5 && <span className="pc-slack">{task.slackDays}d slack</span>}
                <CrewDots crews={task.crews} />
              </span>
            )}
          </li>
        ))}
      </ol>
      {ids.length > 1 && (
        <div className="ac-actions">
          <button type="button" className="button" onClick={() => env.showTasks(ids)}>
            <i className="fa fa-eye" aria-hidden="true" /> Show all {ids.length} in the plan
          </button>
        </div>
      )}
    </CardShell>
  );
}

export function TaskCardView({ card, env }: { card: Partial<TaskCardProps>; env: PlanCardEnv }) {
  const id = card.task_id;
  const task = useMemo(() => (id ? liveTask(env.project, id) : null), [id, env.dataVersion]);
  const links = useMemo(() => (id ? liveLinks(env.project, id) : { waitsFor: [], waitedOnBy: [] }), [id, env.dataVersion]);
  return (
    <CardShell kind="task" icon="square-check" kicker={task?.path.join(' › ') || 'Task'} env={env} testId="assistant-card-task">
      <h4 className="ac-title">
        {task?.critical && <i className="fa fa-bolt pc-critical-mark" aria-label="Sets the handover date" />}
        {task?.name ?? (id ? `Task ${id} (removed)` : <span className="ac-skeleton" />)}
      </h4>
      {card.note && <p className="ac-text">{withheldText(card.note)}</p>}
      {task && (
        <>
          <dl className="pc-facts">
            <div>
              <dt>When</dt>
              <dd>
                {shortDay(task.start)} → {shortDay(task.end)}
              </dd>
            </div>
            <div>
              <dt>Takes</dt>
              <dd>{task.isMilestone ? 'milestone' : plural(task.days, 'working day')}</dd>
            </div>
            <div>
              <dt>Done</dt>
              <dd>
                <span className="pc-progress" style={{ '--pc': `${task.percentDone}%` } as CSSProperties} />
                {task.percentDone}%
              </dd>
            </div>
            <div>
              <dt>Slack</dt>
              <dd>{task.slackDays === null ? '—' : task.slackDays <= 0 ? 'none: sets the handover' : plural(task.slackDays, 'day')}</dd>
            </div>
          </dl>
          {task.crews.length > 0 && <CrewDots crews={task.crews} />}
          {(links.waitsFor.length > 0 || links.waitedOnBy.length > 0) && (
            <div className="pc-links">
              {links.waitsFor.length > 0 && (
                <p>
                  <span className="pc-links-label">Waits for</span>
                  {links.waitsFor.map((link) => (
                    <span key={`in-${link.taskId}`} className="pc-link">
                      <TaskChip id={link.taskId} env={env} />
                      <small>
                        {link.words.toLowerCase()}
                        {link.lagDays ? `, ${link.lagDays > 0 ? `${link.lagDays}d lag` : `${-link.lagDays}d lead`}` : ''}
                      </small>
                    </span>
                  ))}
                </p>
              )}
              {links.waitedOnBy.length > 0 && (
                <p>
                  <span className="pc-links-label">Then</span>
                  {links.waitedOnBy.map((link) => (
                    <span key={`out-${link.taskId}`} className="pc-link">
                      <TaskChip id={link.taskId} env={env} />
                    </span>
                  ))}
                </p>
              )}
            </div>
          )}
          {task.note && <p className="note pc-note">{task.note}</p>}
          <div className="ac-actions">
            <button type="button" className="button" onClick={() => env.showTasks([task.id])}>
              <i className="fa fa-crosshairs" aria-hidden="true" /> Show in the plan
            </button>
          </div>
        </>
      )}
    </CardShell>
  );
}

// ---- charts ------------------------------------------------------------------------------------

/** Workload shades, lightest to darkest: the plan's muted blue (--cat-0) mixed into the surface. */
const HEAT = [12, 28, 44, 62, 80, 100].map((share) => `color-mix(in oklch, var(--cat-0) ${share}%, var(--surface))`);

function money(minor: number, currency: CurrencyCode): string {
  return format(moneyOf(minor, currency)).replace(/\.00$/, '');
}

export function ChartCardView({ card, env }: { card: Partial<ChartCardProps>; env: PlanCardEnv }) {
  const [hover, setHover] = useState<string | null>(null);
  const kind = card.kind;
  return (
    <CardShell kind="chart" icon="chart-column" kicker="From the live plan" env={env} testId="assistant-card-chart">
      <h4 className="ac-title">{card.title ?? <span className="ac-skeleton" />}</h4>
      {card.note && <p className="ac-text">{withheldText(card.note)}</p>}
      {kind === 'crew_workload' && <WorkloadChart card={card} env={env} hover={hover} onHover={setHover} />}
      {kind === 'phase_progress' && <PhaseBars env={env} measure="progress" />}
      {kind === 'phase_cost' && <PhaseBars env={env} measure="cost" />}
      {kind === 'task_float' && <SlackBars env={env} />}
      {(kind === 'cost_section' || kind === 'cost_ledger' || kind === 'cash_flow') && <CostChart kind={kind} card={card} env={env} />}
    </CardShell>
  );
}

function WorkloadChart({ card, env, hover, onHover }: { card: Partial<ChartCardProps>; env: PlanCardEnv; hover: string | null; onHover(key: string | null): void }) {
  const grid = useMemo(
    () => workloadGrid(env.project, { crews: card.crews ?? null, from: card.from ? new Date(`${card.from}T00:00:00`) : null, to: card.to ? new Date(`${card.to}T00:00:00`) : null }),
    [env.dataVersion, card.crews?.join(','), card.from, card.to],
  );
  if (grid.crews.length === 0) return <p className="ac-muted">No crew is booked in that window.</p>;
  const shade = (value: number) => (value <= 0 ? 'transparent' : HEAT[Math.min(HEAT.length - 1, Math.ceil((value / Math.max(5, grid.max)) * (HEAT.length - 1)))]);
  const compact = grid.weeks.length > 12;
  const monthOf = (date: Date) => date.toLocaleString('en-US', { month: 'short' });
  return (
    <div className="pc-heat-wrap">
      <table className={`pc-heat${compact ? ' is-compact' : ''}`} aria-label="Crew-days booked per week">
        <thead>
          <tr className="pc-heat-months">
            <th scope="col" />
            {grid.weeks.map((week, index) => (
              <th key={week.getTime()} scope="col">
                {index === 0 || monthOf(week) !== monthOf(grid.weeks[index - 1]!) ? monthOf(week) : ''}
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col">Crew</th>
            {grid.weeks.map((week) => (
              <th key={week.getTime()} scope="col" title={`Week of ${shortDay(week)}`}>
                {compact ? '' : week.getDate()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.crews.map((crew) => (
            <tr key={crew.name}>
              <th scope="row">
                <span className="pill-dot" style={{ '--pill-dot': crew.color } as CSSProperties} />
                {crew.name}
              </th>
              {crew.cells.map((value, index) => {
                const key = `${crew.name}:${index}`;
                const over = value > 5;
                return (
                  <td
                    key={key}
                    className={`${over ? 'is-over' : ''}${hover === key ? ' is-hover' : ''}`}
                    style={{ background: over ? 'var(--warning-fill)' : shade(value), color: !over && value / Math.max(5, grid.max) > 0.6 ? 'var(--ink-inverse)' : undefined }}
                    onMouseEnter={() => onHover(key)}
                    onMouseLeave={() => onHover(null)}
                    title={`${crew.name}, week of ${shortDay(grid.weeks[index]!)}: ${value} crew-day${value === 1 ? '' : 's'}${over ? ' (more than one crew can do in a week)' : ''}`}
                  >
                    {over ? <i className="fa fa-triangle-exclamation" aria-label="overbooked" /> : value > 0 && hover === key ? value : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pc-legend">
        <span className="pc-ramp" aria-hidden="true">
          {HEAT.slice(1).map((color) => (
            <i key={color} style={{ background: color }} />
          ))}
        </span>
        crew-days per week (5 = one full crew) · <i className="fa fa-triangle-exclamation" aria-hidden="true" /> more than one crew can do
      </p>
    </div>
  );
}

function PhaseBars({ env, measure }: { env: PlanCardEnv; measure: 'progress' | 'cost' }) {
  const phases = useMemo(() => phaseFigures(env.project), [env.dataVersion]);
  if (measure === 'progress') {
    return (
      <ul className="pc-bars" aria-label="Percent done per phase">
        {phases.map((phase) => (
          <li key={phase.id} title={`${phase.name}: ${phase.percentDone}% done`}>
            <button type="button" className="pc-bar-label" onClick={() => env.showTasks([phase.id])}>
              {phase.name}
            </button>
            <span className="pc-bar-track">
              <span className="pc-bar" style={{ width: `${Math.max(phase.percentDone, 0.5)}%` }} />
            </span>
            <span className="pc-bar-value">{phase.percentDone}%</span>
          </li>
        ))}
      </ul>
    );
  }
  const max = Math.max(1, ...phases.flatMap((phase) => [phase.budgetMinor, phase.forecastMinor]));
  return (
    <>
      <p className="pc-legend">
        <span className="pc-key is-budget" /> Budget <span className="pc-key is-forecast" /> Forecast
      </p>
      <ul className="pc-bars is-paired" aria-label="Budget and forecast per phase">
        {phases.map((phase) => {
          const over = phase.forecastMinor - phase.budgetMinor;
          return (
            <li key={phase.id} title={`${phase.name}: budget ${money(phase.budgetMinor, env.currency)}, forecast ${money(phase.forecastMinor, env.currency)}`}>
              <button type="button" className="pc-bar-label" onClick={() => env.showTasks([phase.id])}>
                {phase.name}
              </button>
              <span className="pc-bar-track">
                <span className="pc-bar is-budget" style={{ width: `${(phase.budgetMinor / max) * 100}%` }} />
                <span className="pc-bar is-forecast" style={{ width: `${(phase.forecastMinor / max) * 100}%` }} />
              </span>
              <span className="pc-bar-value">
                {env.canViewCosts ? money(phase.forecastMinor, env.currency) : '•••'}
                {over > 0 && env.canViewCosts && (
                  <small className="pc-over">
                    <i className="fa fa-arrow-trend-up" aria-hidden="true" /> {money(over, env.currency)} over
                  </small>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function SlackBars({ env }: { env: PlanCardEnv }) {
  const tasks = useMemo(() => tightestTasks(env.project), [env.dataVersion]);
  const max = Math.max(5, ...tasks.map((task) => task.slackDays ?? 0));
  return (
    <ul className="pc-bars" aria-label="Working days each task can slip">
      {tasks.map((task) => (
        <li key={task.id} title={`${task.name}: ${task.slackDays} day(s) of slack`}>
          <button type="button" className="pc-bar-label" onClick={() => env.showTasks([task.id])}>
            {task.name}
          </button>
          <span className="pc-bar-track">
            <span className="pc-bar is-slack" style={{ width: `${Math.max(1.5, ((task.slackDays ?? 0) / max) * 100)}%` }} />
          </span>
          <span className="pc-bar-value">{task.slackDays! <= 0 ? <strong>sets the date</strong> : `${task.slackDays}d`}</span>
        </li>
      ))}
    </ul>
  );
}

// ---- findings ----------------------------------------------------------------------------------

const SEVERITY_ICON = { high: 'circle-exclamation', medium: 'triangle-exclamation', low: 'circle-info' } as const;

export function FindingsCardView({ card, env }: { card: Partial<FindingsCardProps>; env: PlanCardEnv }) {
  return (
    <CardShell kind="findings" icon="stethoscope" kicker="Schedule check" env={env} testId="assistant-card-findings">
      <h4 className="ac-title">{card.title ?? <span className="ac-skeleton" />}</h4>
      {card.summary && <p className="ac-text">{card.summary}</p>}
      <ul className="pc-findings">
        {(card.findings ?? []).map((finding, index) => (
          <li key={index} className={`is-${finding.severity ?? 'low'}`}>
            <i className={`fa fa-${SEVERITY_ICON[finding.severity ?? 'low']}`} aria-label={finding.severity} />
            <div>
              <p>{finding.text}</p>
              {(finding.task_ids?.length ?? 0) > 0 && (
                <p className="pc-chips">
                  {finding.task_ids!.slice(0, 6).map((id) => (
                    <TaskChip key={id} id={id} env={env} />
                  ))}
                  {finding.task_ids!.length > 6 && <span className="pc-more">+{finding.task_ids!.length - 6}</span>}
                  {finding.task_ids!.length > 1 && (
                    <button type="button" className="button is-link" onClick={() => env.showTasks(finding.task_ids!)}>
                      show all
                    </button>
                  )}
                </p>
              )}
              {finding.fix_message && env.active && !env.partial && (
                <button type="button" className="button is-sm pc-fix" onClick={() => env.send(finding.fix_message!)}>
                  <i className="fa fa-wrench" aria-hidden="true" /> Fix this
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </CardShell>
  );
}

// ---- plan edits --------------------------------------------------------------------------------

/** What new rental dates come to, from the booking as it stands: the service never prices a change it only drafts. */
export function RentalChanges({ operations, bookingOn, currency }: { operations: readonly PlanEditOp[]; bookingOn: NonNullable<PlanCardEnv['bookingOn']>; currency: CurrencyCode }) {
  // The days on rent when this card first showed: once applied, the booking already has the new dates.
  const before = useRef(new Map<unknown, number>());
  const lines = operations.flatMap((operation) => {
    if (operation.op !== 'set_rental') return [];
    const booking = bookingOn(operation.task);
    if (!booking) return [];
    const days = rentalDays(operation.first_day, addDays(operation.last_day, 1));
    if (!before.current.has(operation.task)) before.current.set(operation.task, rentalDays(booking.billable_start, booking.billable_end));
    const was = before.current.get(operation.task) ?? days;
    const rate = booking.rental_rate_minor;
    const change = (was - days) * rate;
    const words = (minor: number) => money(minor, currency).replace(/\.00$/, '');
    return [`${days} ${days === 1 ? 'day' : 'days'} on rent, ${change !== 0 ? `${words(was * rate)} → ` : ''}${words(days * rate)}${change > 0 ? `: saves ${words(change)}` : change < 0 ? `: ${words(-change)} more` : ''}`];
  });
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line) => (
        <p key={line} className="pc-rental-money" data-testid="assistant-edit-rental">
          <i className="fa fa-sack-dollar" aria-hidden="true" /> {line}
        </p>
      ))}
    </>
  );
}

/**
 * What a task's cost becomes, for the people who see costs: "Order light fixtures: $8,250 → $24,750", and
 * who it is paid to when that changes: "Order light fixtures: paid to Halden Electrical → Lumen & Co Lighting".
 */
export function CostChanges({ operations, project, currency }: { operations: readonly PlanEditOp[]; project: ProjectModel; currency: CurrencyCode }) {
  const words = (minor: number) => money(minor, currency).replace(/\.00$/, '');
  // What each task cost when this card first showed: once the change is applied, the task already has the new amount.
  const before = useRef(new Map<unknown, number>());
  const lines = operations.flatMap((operation) => {
    if (operation.op !== 'set_cost') return [];
    const task = project.taskStore.getById(operation.task) as (TaskModel & { budgetMinor?: number; costLines?: { payee: string }[] | null }) | undefined;
    if (!task) return [];
    const was = task.costLines?.[0]?.payee;
    if (!before.current.has(operation.task)) before.current.set(operation.task, task.budgetMinor ?? 0);
    const from = before.current.get(operation.task) ?? 0;
    const to = operation.amount !== undefined ? operation.amount * 100 : null;
    return [
      ...(to !== null ? [from === to ? `${task.name}: ${words(to)}` : `${task.name}: ${words(from)} → ${words(to)}`] : []),
      ...(operation.payee && operation.payee !== was ? [`${task.name}: paid to ${was ? `${was} → ` : ''}${operation.payee}`] : []),
    ];
  });
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line) => (
        <p key={line} className="pc-rental-money" data-testid="assistant-edit-cost">
          <i className="fa fa-sack-dollar" aria-hidden="true" /> {line}
        </p>
      ))}
    </>
  );
}

export function PlanEditCardView({ card, env }: { card: Partial<PlanEditCardProps>; env: PlanCardEnv }) {
  const operations = card.operations ?? [];
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(operations.map((_, index) => index)));
  const [preview, setPreview] = useState<EditPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const library = useLibrarySnapshot(env.library);
  const snippetOf = (id: string) => library.entries.find((entry) => entry.id === id)?.snippet;
  const picked = operations.filter((_, index) => chosen.has(index));
  const done = env.outcome !== null;

  useEffect(() => setChosen(new Set(operations.map((_, index) => index))), [operations.length]);
  // Preview what the chosen operations would move (on a copy), again whenever the plan or the choice changes.
  useEffect(() => {
    if (env.partial || done || picked.length === 0 || operations.length === 0) {
      setPreview(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      previewPlanEdit(env.project, picked, snippetOf).then(
        (result) => live && setPreview(result),
        (reason: unknown) => live && setPreview({ handoverBefore: null, handoverAfter: null, moved: [], added: 0, removed: 0, error: reason instanceof Error ? reason.message : String(reason) }),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [env.partial, done, env.dataVersion, [...chosen].join(','), operations.length, library.entries.length]);

  const apply = async (automatic = false) => {
    if (busy || picked.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const before = new Set(env.project.taskStore.allRecords);
      const touched = tasksTouched(env.project, picked as PlanEditOp[]);
      await applyPlanEdit(env.project, card.title ?? `Change from ${ASSISTANT_NAME}`, picked as PlanEditOp[], snippetOf, (taskId, resourceId) => {
        const booking = env.canViewCosts ? env.bookingOn?.(taskId) : null;
        return booking?.resource_id === resourceId ? booking.rental_rate_minor : null;
      });
      // The assistant hears about it next, and answers from the plan as the server has it.
      await whenSaved(env.project);
      // What went in, in plan order, then what changed: the plan scrolls to the first of it and Remy's cursor goes there,
      // so nobody has to hunt for it.
      const added: number[] = [];
      walkPlan(env.project, (record) => {
        const task = record as TaskModel;
        if (!task.isRoot && !before.has(task) && typeof task.id === 'number') added.push(task.id);
      });
      const shown = [...added, ...touched.filter((id) => !added.includes(id) && env.project.taskStore.getById(id))];
      if (shown.length > 0) {
        env.showTasks(shown);
        env.pointAt?.(shown);
      }
      const some = picked.length < operations.length ? ` (${picked.length} of ${operations.length})` : '';
      if (automatic) env.send(`Applied “${card.title ?? 'the change'}”${some} automatically.`, { kind: 'apply_edit', card_id: env.cardId }, { approval_mode: 'auto' });
      else env.send(`Applied “${card.title ?? 'the change'}”${some}.`, { kind: 'apply_edit', card_id: env.cardId });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  // Under "auto" (or "ask if risky", for a small change) the change goes in once its preview is checked.
  const risk = isRiskyEdit(picked as PlanEditOp[], preview);
  // Pieces from the library go in without watching the handover: a watch rule speaks up if it should.
  const onlyPieces =
    picked.length > 0 &&
    (picked as PlanEditOp[]).some((operation) => operation.op === 'add_snippet') &&
    (picked as PlanEditOp[]).every((operation) => operation.op === 'add_snippet' || operation.op === 'set_cost' || (operation.op === 'update_task' && Object.keys(operation).every((key) => key === 'op' || key === 'task' || key === 'name')));
  const automatic = !done && !env.partial && (env.autoApply === 'auto' || (env.autoApply === 'risky' && risk === null));
  useEffect(() => {
    if (!automatic || !preview || preview.error || autoApplied.has(env.cardId)) return;
    autoApplied.add(env.cardId);
    void apply(true);
  }, [automatic, preview]);

  const moved = preview && preview.handoverBefore && preview.handoverAfter ? Math.round((preview.handoverAfter.getTime() - preview.handoverBefore.getTime()) / 86_400_000) : 0;
  return (
    <CardShell kind="edit" icon="pen-ruler" kicker="Proposed change to the plan" env={{ ...env, active: env.active || !done }} testId="assistant-card-edit">
      <h4 className="ac-title">{card.title ?? <span className="ac-skeleton" />}</h4>
      {card.reason && <p className="ac-text">{card.reason}</p>}
      {operations.length === 0 ? (
        <p className="ac-muted">Laying out the change…</p>
      ) : (
        <ul className="pc-ops">
          {(card.lines ?? []).map((line, index) => (
            <li key={index}>
              {card.selectable && !done ? (
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(index)}
                    onChange={() =>
                      setChosen((current) => {
                        const next = new Set(current);
                        if (next.has(index)) next.delete(index);
                        else next.add(index);
                        return next;
                      })
                    }
                  />
                  {line}
                </label>
              ) : (
                <span>
                  <i className="fa fa-angle-right" aria-hidden="true" />
                  {line}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {env.canViewCosts && env.bookingOn && <RentalChanges operations={operations as PlanEditOp[]} bookingOn={env.bookingOn} currency={env.currency} />}
      {env.canViewCosts && <CostChanges operations={operations as PlanEditOp[]} project={env.project} currency={env.currency} />}
      {(card.warnings ?? []).map((warning) => (
        <p key={warning} className="pc-warning">
          <i className="fa fa-triangle-exclamation" aria-hidden="true" /> {warning}
        </p>
      ))}
      {!done && preview && (
        <div className={`note pc-impact ${preview.error ? 'is-danger' : moved > 0 ? 'is-warning' : 'is-success'}`} data-testid="assistant-edit-preview">
          {preview.error ? (
            <span>
              <i className="fa fa-circle-xmark" aria-hidden="true" /> It cannot be applied as it is: {preview.error}
            </span>
          ) : (
            <>
              {!onlyPieces && (
              <span>
                <i className="fa fa-flag-checkered" aria-hidden="true" /> Handover {moved === 0 ? `stays ${shortDay(preview.handoverAfter)}` : `${shortDay(preview.handoverBefore)} → ${shortDay(preview.handoverAfter)} (${moved > 0 ? '+' : ''}${moved} ${Math.abs(moved) === 1 ? 'day' : 'days'})`}
              </span>
              )}
              <span>
                {preview.added > 0 && `${plural(preview.added, 'new task')} · `}
                {preview.moved.length === 0 ? 'nothing else moves' : `${plural(preview.moved.length, 'task')} move`}
                {preview.removed > 0 && ` · ${plural(preview.removed, 'task')} removed`}
              </span>
              {preview.moved.length > 0 && (
                <button type="button" className="button is-link" onClick={() => env.showTasks(preview.moved.map((task) => task.id))}>
                  show what moves
                </button>
              )}
            </>
          )}
        </div>
      )}
      {error && <p className="pc-warning is-error">{error}</p>}
      {!done && env.autoApply === 'risky' && risk && preview && (
        <p className="note is-warning pc-hold" data-testid="assistant-edit-held">
          <i className="fa fa-hand" aria-hidden="true" /> Waiting for you: {risk}.
        </p>
      )}
      {done ? (
        <p className={`pc-outcome is-${env.outcome!.kind}`}>
          {env.outcome!.kind === 'applied' && env.outcome!.auto ? (
            <RemyMark motion="still" className="remy-inline" />
          ) : (
            <i className={`fa fa-${env.outcome!.kind === 'applied' ? 'circle-check' : 'circle-minus'}`} aria-hidden="true" />
          )}
          {env.outcome!.kind === 'applied' ? (env.outcome!.auto ? 'Applied automatically for' : 'Applied by') : 'Declined by'} {env.outcome!.by}
        </p>
      ) : automatic ? (
        <p className="pc-outcome is-applying" data-testid="assistant-edit-auto">
          <i className="fa fa-spinner fa-spin" aria-hidden="true" /> Checking, then applying automatically…
        </p>
      ) : (
        !env.partial &&
        operations.length > 0 && (
          <div className="ac-actions">
            <button type="button" className="button is-primary" disabled={busy || picked.length === 0 || Boolean(preview?.error)} onClick={() => void apply()} data-testid="assistant-edit-apply">
              <i className={`fa fa-${busy ? 'spinner fa-spin' : 'check'}`} aria-hidden="true" /> Apply{picked.length < operations.length ? ` ${picked.length} of ${operations.length}` : ''}
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => env.send('Declined this change.', { kind: 'dismiss_edit', card_id: env.cardId })} data-testid="assistant-edit-decline">
              Decline
            </button>
          </div>
        )
      )}
    </CardShell>
  );
}

// ---- snippet drafts ----------------------------------------------------------------------------

export function SnippetsCardView({ card, env }: { card: Partial<SnippetsCardProps>; env: PlanCardEnv }) {
  const library = useLibrarySnapshot(env.library);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ draftId: string; snippet: SnippetDraft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const matchCrew = crewMatcher(env.project);
  const colorOf = (name: string) => {
    const crew = matchCrew(name);
    return crew ? crewColor(crew) : undefined;
  };

  const save = async (draftId: string, snippet: SnippetDraft, folder: string | null) => {
    if (!env.library) return;
    setError(null);
    try {
      await env.library.saveSnippet(snippet, { folderId: folder, origin: 'assistant' });
      setSaved((current) => ({ ...current, [draftId]: snippet.name }));
      env.send(`Saved “${snippet.name}” to the library.`, { kind: 'save_snippet', card_id: env.cardId });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <CardShell kind="snippets" icon="cubes" kicker="For the library" env={env} testId="assistant-card-snippets">
      <h4 className="ac-title">{card.title ?? <span className="ac-skeleton" />}</h4>
      {!env.partial && env.library && library.folders.length > 0 && Object.keys(saved).length < (card.drafts?.length ?? 0) && (
        <label className="pc-folder">
          File in
          <select className="input" value={folderId ?? ''} onChange={(event) => setFolderId(event.target.value || null)}>
            <option value="">Library (top level)</option>
            {folderOptions(library.folders).map(({ folder, depth }) => (
              <option key={folder.id} value={folder.id}>
                {`${'  '.repeat(depth)}${folder.name}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {(card.drafts ?? []).map((draft) =>
        draft?.snippet ? (
          <section key={draft.draft_id} className="pc-snippet">
            <header>
              <span className="pc-snippet-icon" aria-hidden="true">
                <i className={`fa fa-${draft.snippet.icon}`} />
              </span>
              <div>
                <strong>{draft.snippet.name}</strong>
                <small>
                  {plural(leavesOf(draft.snippet.children).length, 'task')} · {plural(snippetSpan(draft.snippet), 'working day')}
                  {(draft.snippet.timeRanges?.length ?? 0) > 0 && ` · ${plural(draft.snippet.timeRanges!.length, 'time range')}`}
                </small>
              </div>
            </header>
            <p className="ac-text">{draft.why}</p>
            <SnippetMiniTimeline body={draft.snippet} crewColor={colorOf} />
            {(draft.source_task_ids?.length ?? 0) > 0 && (
              <p className="pc-chips">
                <span className="pc-links-label">Found at</span>
                {draft.source_task_ids!.slice(0, 4).map((id) => (
                  <TaskChip key={id} id={id} env={env} />
                ))}
              </p>
            )}
            {saved[draft.draft_id] || env.outcome?.kind === 'saved' ? (
              <p className="pc-outcome is-saved">
                <i className="fa fa-circle-check" aria-hidden="true" /> In the library{env.outcome && !saved[draft.draft_id] ? ` (saved by ${env.outcome.by})` : ''}
              </p>
            ) : (
              !env.partial &&
              env.library && (
                <div className="ac-actions">
                  <button type="button" className="button is-primary" onClick={() => void save(draft.draft_id, draft.snippet, folderId)} data-testid="assistant-save-snippet">
                    <i className="fa fa-cubes" aria-hidden="true" /> Save to library
                  </button>
                  <button type="button" className="button" onClick={() => setEditing({ draftId: draft.draft_id, snippet: draft.snippet })} data-testid="assistant-edit-snippet">
                    <i className="fa fa-pen-ruler" aria-hidden="true" /> Edit first
                  </button>
                </div>
              )
            )}
          </section>
        ) : (
          <p key={draft?.draft_id ?? 'pending'} className="ac-muted">
            Drafting…
          </p>
        ),
      )}
      {error && <p className="pc-warning is-error">{error}</p>}
      {editing && env.library && (
        <SnippetBuilder
          initial={editing.snippet}
          title={`Draft from ${ASSISTANT_NAME}`}
          folders={library.folders}
          folderId={folderId}
          crews={builderCrews(env.project)}
          onClose={() => setEditing(null)}
          onSave={async (draft, folder) => {
            await save(editing.draftId, draft, folder);
            setEditing(null);
          }}
        />
      )}
    </CardShell>
  );
}

// ---- next steps --------------------------------------------------------------------------------

export function FollowUpsView({ card, env }: { card: Partial<FollowUpsProps>; env: PlanCardEnv }): ReactNode {
  if (!env.active || env.partial) return null;
  return (
    <div className="pc-followups" data-testid="assistant-followups">
      {(card.suggestions ?? []).map((suggestion) => (
        <button key={suggestion.label} type="button" className="button is-sm" onClick={() => env.send(suggestion.message)}>
          {suggestion.label}
        </button>
      ))}
    </div>
  );
}
