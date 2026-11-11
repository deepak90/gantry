/**
 * The project at a glance, kept out of the way: the header carries one quiet line (when it hands
 * over, how far along it is, how many things need a look) and the project name opens an overview
 * card with the rest: dates, progress, money for viewers who may see it, and what the watch list
 * raised (rules people made; the plan passes no verdict on itself), with a way to ask the assistant.
 * At the top of the card, the other projects this person is in: picking one opens it. Read from the
 * live ProjectModel; `revision` signals that the records changed.
 */
import type { CalendarModel, ProjectModel, TaskModel } from '@bryntum/gantt';
import type { CurrencyCode } from '@collab/shared';
import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { ASSISTANT_NAME } from '../assistant/identity';
import { RemyMark } from '../assistant/RemyMark';
import { onWorkingTime } from '../gantt/late-payment';
import { compactMoney, taskMoney } from '../gantt/look';
import { useDismiss } from './useDismiss';

export interface ProjectSummaryProps {
  name: string;
  project: ProjectModel;
  revision: number;
  canViewCosts: boolean;
  currency: CurrencyCode | null;
  /** What the watch list (rules people made) says needs a look; the plan itself passes no verdict. */
  alertCount?: number;
  /** Opens the Watch tab. */
  onOpenAlerts?: () => void;
  /** Asks the assistant what needs attention, in a new conversation. */
  onAsk?: () => void;
  /** Every project this person is a member of, and the one open now. */
  projects?: readonly { id: string; name: string }[];
  currentProjectId?: string;
  onOpenProject?: (projectId: string) => void;
}

interface Summary {
  handover: Date | null;
  progress: number;
  budget: number;
  expected: number;
  spent: number;
  paid: number;
}

function summarize(project: ProjectModel): Summary {
  const leaves = (project.taskStore.leaves as TaskModel[]).filter((task) => !task.isRoot);
  let handover: Date | null = null;
  let weight = 0;
  let weightedDone = 0;
  const totals = { budget: 0, expected: 0, spent: 0, paid: 0 };
  for (const task of leaves) {
    if (task.isMilestone && task.startDate instanceof Date && (!handover || task.startDate > handover)) {
      handover = task.startDate;
    }
    if (task.startDate instanceof Date && task.endDate instanceof Date) {
      const span = task.endDate.getTime() - task.startDate.getTime();
      weight += span;
      weightedDone += span * (task.percentDone ?? 0);
    }
    const money = taskMoney(task);
    totals.budget += money.budget;
    totals.expected += money.expected;
    totals.spent += money.spent;
    totals.paid += money.paid;
  }
  const end = handover ?? (project.endDate instanceof Date ? project.endDate : null);
  // Work that ends on a Friday evening before a long weekend hands over on the next working day, not on the Saturday.
  const calendar = (project as unknown as { calendar?: CalendarModel }).calendar;
  return { handover: end ? onWorkingTime(calendar, end) : null, progress: weight > 0 ? weightedDone / weight : 0, ...totals };
}

const dayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const longDayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

export function ProjectSummary({ name, project, revision, canViewCosts, currency, alertCount = 0, onOpenAlerts, onAsk, projects = [], currentProjectId, onOpenProject }: ProjectSummaryProps) {
  const summary = useMemo(() => summarize(project), [project, revision]);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const progress = Math.round(summary.progress);
  const over = summary.expected - summary.budget;
  const money = canViewCosts && currency;

  useDismiss(open, root, () => setOpen(false));

  const act = (run: () => void) => {
    setOpen(false);
    run();
  };

  return (
    <div className="project-summary" ref={root}>
      <button
        type="button"
        className={`project-title${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="project-overview-button"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="project-title-name">
          <h1>{name}</h1>
          <i className="fa fa-chevron-down" aria-hidden="true" />
        </span>
        <span className="project-headline" data-testid="project-headline">
          <span>Handover {summary.handover ? dayFormat.format(summary.handover) : '—'}</span>
          <span aria-hidden="true">·</span>
          <span>{progress}% built</span>
          {alertCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span
                className="project-headline-alert"
                data-testid="attention-count"
                role={onOpenAlerts ? 'link' : undefined}
                title={onOpenAlerts ? 'Open the alerts' : undefined}
                onClick={
                  onOpenAlerts
                    ? (event) => {
                        event.stopPropagation();
                        onOpenAlerts();
                      }
                    : undefined
                }
              >
                <i className="fa fa-circle-exclamation" aria-hidden="true" /> {plural(alertCount, 'thing')} to look at
              </span>
            </>
          )}
        </span>
      </button>

      {open && (
        <div className="popover project-overview" role="dialog" aria-label="Project overview" data-testid="project-overview">
          {projects.length > 1 && onOpenProject && (
            <section className="po-section po-projects" aria-label="Projects">
              <h3 className="section-label">Projects</h3>
              <ul className="po-project-list" data-testid="project-list">
                {projects.map((entry) => {
                  const current = entry.id === currentProjectId;
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className={`po-project${current ? ' is-current' : ''}`}
                        aria-current={current ? 'page' : undefined}
                        disabled={current}
                        onClick={() => act(() => onOpenProject(entry.id))}
                        data-testid={`project-option-${entry.id}`}
                      >
                        <i className={`fa fa-${current ? 'circle-check' : 'helmet-safety'}`} aria-hidden="true" />
                        <span>{entry.name}</span>
                        {current && <span className="po-project-here">Open</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <div className="po-facts" data-testid="project-summary">
            <div className="po-fact">
              <span className="po-icon">
                <i className="fa fa-flag-checkered" aria-hidden="true" />
              </span>
              <span>
                <span className="po-label">Handover</span>
                <span className="po-value">{summary.handover ? longDayFormat.format(summary.handover) : 'Not scheduled'}</span>
              </span>
            </div>
            <div className="po-fact">
              <span className="po-ring" style={{ '--po-progress': `${progress}%` } as CSSProperties}>
                <span>{progress}%</span>
              </span>
              <span>
                <span className="po-label">Built so far</span>
                <span className="po-value">{progress}% of the work done</span>
              </span>
            </div>
          </div>

          {money && (
            <section className="po-section" aria-label="Costs">
              <h3 className="section-label">Costs</h3>
              <dl className="po-money">
                <div>
                  <dt>Budget</dt>
                  <dd>{compactMoney(summary.budget, currency)}</dd>
                </div>
                <div>
                  <dt>Forecast</dt>
                  <dd>
                    {compactMoney(summary.expected, currency)}
                    {over !== 0 && <span className={`po-delta ${over > 0 ? 'is-over' : 'is-under'}`}>{`${over > 0 ? '+' : '−'}${compactMoney(Math.abs(over), currency)}`}</span>}
                  </dd>
                </div>
                <div>
                  <dt>Spent</dt>
                  <dd>{compactMoney(summary.spent, currency)}</dd>
                </div>
                <div>
                  <dt>Paid out</dt>
                  <dd>{compactMoney(summary.paid, currency)}</dd>
                </div>
              </dl>
            </section>
          )}

          <section className="po-section" aria-label="Needs attention">
            <h3 className="section-label">Needs attention</h3>
            {alertCount > 0 ? (
              <p className="po-empty">
                <i className="fa fa-bell" aria-hidden="true" /> {plural(alertCount, 'alert')} from the watch list.
                {onOpenAlerts && (
                  <button type="button" className="button is-link" onClick={() => act(onOpenAlerts)}>
                    Open alerts
                  </button>
                )}
              </p>
            ) : (
              <p className="po-empty">
                <i className="fa fa-circle-check" aria-hidden="true" /> Nothing on the watch list right now.
              </p>
            )}
            {onAsk && (
              <button type="button" className="button is-sm" data-testid="overview-ask" onClick={() => act(onAsk)}>
                <RemyMark motion="still" className="remy-inline" /> Ask {ASSISTANT_NAME} what needs attention
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
