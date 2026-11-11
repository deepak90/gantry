/**
 * The toolbar above the Gantt. Stateless; the workspace owns the view state and applies it.
 *
 * Only what people reach for all the time sits on the bar: undo and redo, search, the Show filter
 * and zoom. How
 * the plan is drawn (grouping, colors, critical path, planned dates, expanding) lives in one View
 * menu. Columns (money among them) are chosen with the grid itself: the "+" in its header row.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { useDismiss } from '../app/useDismiss';
import { ASSISTANT_NAME, REMY_SPARK_GLYPH } from '../assistant/identity';
import { useCursorsShown } from '../presence/cursors-shown';
import type { ColorBy, GroupBy, QuickFilter } from './look';
import type { UndoState } from './undo';
import '../styles/toolbar.css';

export interface GanttToolbarProps {
  /** Only undo, redo, search, View and zoom on the bar. */
  quiet?: boolean;
  search: string;
  onSearch(value: string): void;
  quickFilter: QuickFilter;
  onQuickFilter(value: QuickFilter): void;
  groupBy: GroupBy;
  onGroupBy(value: GroupBy): void;
  /** Cost viewers can also group by budget. */
  canViewCosts: boolean;
  criticalPath: boolean;
  onCriticalPath(value: boolean): void;
  planned: boolean;
  onPlanned(value: boolean): void;
  colorBy: ColorBy;
  onColorBy(value: ColorBy): void;
  attentionCount: number;
  visibleCount: number;
  totalCount: number;
  /** Remy's filter, by what it keeps ("Volt Electric’s work · Jun 1 to Jun 30"); null when there is none. */
  planFilter?: string | null;
  onClearPlanFilter?(): void;
  onZoom(direction: 'in' | 'out' | 'fit'): void;
  onExpand(expand: boolean): void;
  /** What undo and redo would do (this person's own changes). */
  history: UndoState;
  /** The crew view open under the plan, if any (Crew workload or Crew schedule). */
  crewPane: CrewPane | null;
  onCrewPane(pane: CrewPane | null): void;
  /** The odds panel beside the chart (odds/OddsPanel.tsx): whether it is open, and the way to open or close it. */
  odds?: boolean;
  onOdds?(open: boolean): void;
  onUndo(): void;
  onRedo(): void;
}

export type CrewPane = 'workload' | 'schedule';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const UNDO_KEYS = MAC ? '⌘Z' : 'Ctrl+Z';
const REDO_KEYS = MAC ? '⇧⌘Z' : 'Ctrl+Shift+Z';

interface Choice<T extends string> {
  value: T;
  label: string;
  icon: string;
  title?: string;
}

function Segmented<T extends string>({ label, choices, value, onChange, testId }: { label: string; choices: Choice<T>[]; value: T; onChange(value: T): void; testId: string }) {
  return (
    <div className="segmented gt-segmented" role="radiogroup" aria-label={label} data-testid={testId}>
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="radio"
          aria-checked={value === choice.value}
          title={choice.title}
          onClick={() => onChange(choice.value)}
        >
          <i className={`fa fa-${choice.icon}`} aria-hidden="true" />
          <span>{choice.label}</span>
        </button>
      ))}
    </div>
  );
}

/** One row of the View menu: a set of mutually exclusive options. */
function MenuChoices<T extends string>({ title, choices, value, onChange, testId }: { title: string; choices: Choice<T>[]; value: T; onChange(value: T): void; testId: string }) {
  return (
    <div className="gt-menu-section" role="group" aria-label={title}>
      <p className="section-label gt-menu-title">{title}</p>
      <div className="segmented gt-menu-choices" data-testid={testId}>
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            role="menuitemradio"
            aria-checked={value === choice.value}
            title={choice.title}
            onClick={() => onChange(choice.value)}
          >
            <i className={`fa fa-${choice.icon}`} aria-hidden="true" />
            <span>{choice.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MenuSwitch({ on, onChange, icon, label, hint, testId }: { on: boolean; onChange(value: boolean): void; icon: string; label: string; hint: string; testId: string }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={on} className={`menu-item gt-menu-switch${on ? ' is-on' : ''}`} data-testid={testId} onClick={() => onChange(!on)}>
      <i className={`fa fa-${icon}`} aria-hidden="true" />
      <span className="gt-menu-switch-text">
        <span>{label}</span>
        <small>{hint}</small>
      </span>
      <span className="gt-switch" aria-hidden="true" />
    </button>
  );
}

function ViewMenu(props: GanttToolbarProps) {
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [cursorsShown, showCursors] = useCursorsShown();
  const root = useRef<HTMLDivElement>(null);

  useDismiss(open, root, () => setOpen(false));

  // On a narrow window the bar wraps and View lands at its left, where a menu opening leftward would leave the screen.
  useLayoutEffect(() => {
    if (open && menu.current && menu.current.getBoundingClientRect().left < 0) menu.current.classList.add('is-from-left');
  }, [open]);

  const groupChoices: Choice<GroupBy>[] = [
    { value: 'phase', label: 'Phase', icon: 'layer-group' },
    { value: 'crew', label: 'Crew', icon: 'user-group' },
    { value: 'status', label: 'Status', icon: 'list-check' },
  ];
  if (props.canViewCosts) groupChoices.push({ value: 'budget', label: 'Budget', icon: 'scale-balanced' });
  const changed = props.groupBy !== 'phase' || props.colorBy !== 'phase' || props.criticalPath || !props.planned;

  return (
    <div className="gt-view" ref={root}>
      <button
        type="button"
        className="button is-quiet gt-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="gantt-view"
        title="Group, color and what to show"
        onClick={() => setOpen((value) => !value)}
      >
        <i className="fa fa-sliders" aria-hidden="true" />
        <span>View</span>
        {changed && <span className="gt-dot" aria-label="changed" />}
        <i className="fa fa-chevron-down gt-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="popover gt-menu" role="menu" aria-label="View" ref={menu}>
          <MenuChoices title="Group by" choices={groupChoices} value={props.groupBy} onChange={props.onGroupBy} testId="gantt-group" />
          <MenuChoices
            title="Color bars by"
            testId="gantt-color-by"
            value={props.colorBy}
            onChange={props.onColorBy}
            choices={[
              { value: 'phase', label: 'Phase', icon: 'layer-group' },
              { value: 'crew', label: 'Crew', icon: 'palette' },
            ]}
          />
          <div className="gt-menu-section">
            <MenuSwitch on={props.criticalPath} onChange={props.onCriticalPath} icon="route" label="Critical path" hint="The chain of tasks that sets the handover date" testId="toggle-critical" />
            <MenuSwitch on={props.planned} onChange={props.onPlanned} icon="clone" label="Planned dates" hint="A thin line under each bar where it was first planned" testId="toggle-planned" />
            <MenuSwitch on={cursorsShown} onChange={showCursors} icon="arrow-pointer" label="Others’ cursors" hint="The pointers and names of the people in the plan with you" testId="toggle-cursors" />
          </div>
          <div className="gt-menu-section" role="group" aria-label="Crew views">
            <p className="section-label gt-menu-title">Under the plan</p>
            <MenuSwitch
              on={props.crewPane === 'workload'}
              onChange={(on) => props.onCrewPane(on ? 'workload' : null)}
              icon="chart-simple"
              label="Crew workload"
              hint="Who is busy when, and who is double-booked"
              testId="toggle-crew-workload"
            />
            <MenuSwitch
              on={props.crewPane === 'schedule'}
              onChange={(on) => props.onCrewPane(on ? 'schedule' : null)}
              icon="calendar-week"
              label="Crew schedule"
              hint="Each crew's tasks on its own row"
              testId="toggle-crew-schedule"
            />
          </div>
          <div className="gt-menu-section gt-menu-row">
            <button type="button" className="button is-sm" onClick={() => props.onExpand(true)}>
              <i className="fa fa-angles-down" aria-hidden="true" /> Expand all
            </button>
            <button type="button" className="button is-sm" onClick={() => props.onExpand(false)}>
              <i className="fa fa-angles-up" aria-hidden="true" /> Collapse all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function GanttToolbar(props: GanttToolbarProps) {
  const filtered = props.visibleCount < props.totalCount;
  return (
    <div className="gt-bar" data-testid="gantt-toolbar">
      <div className="gt-history" role="group" aria-label="Undo and redo">
        <button
          type="button"
          className="button is-quiet is-icon"
          disabled={!props.history.canUndo}
          title={props.history.undoLabel ? `Undo ${props.history.undoLabel} (${UNDO_KEYS})` : 'Nothing to undo'}
          aria-label={props.history.undoLabel ? `Undo ${props.history.undoLabel}` : 'Undo'}
          onClick={props.onUndo}
          data-testid="gantt-undo"
        >
          <i className="fa fa-rotate-left" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="button is-quiet is-icon"
          disabled={!props.history.canRedo}
          title={props.history.redoLabel ? `Redo ${props.history.redoLabel} (${REDO_KEYS})` : 'Nothing to redo'}
          aria-label={props.history.redoLabel ? `Redo ${props.history.redoLabel}` : 'Redo'}
          onClick={props.onRedo}
          data-testid="gantt-redo"
        >
          <i className="fa fa-rotate-right" aria-hidden="true" />
        </button>
      </div>

      <label className="gt-search">
        <i className="fa fa-magnifying-glass" aria-hidden="true" />
        <input
          className="input"
          type="search"
          placeholder="Search tasks or crews"
          value={props.search}
          aria-label="Search tasks or crews"
          data-testid="gantt-search"
          onChange={(event) => props.onSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') props.onSearch('');
          }}
        />
        {props.search && (
          <button type="button" className="button is-quiet is-sm is-icon gt-clear" aria-label="Clear search" onClick={() => props.onSearch('')}>
            <i className="fa fa-xmark" aria-hidden="true" />
          </button>
        )}
      </label>

      {!props.quiet && <Segmented
        label="Show"
        testId="gantt-filter"
        value={props.quickFilter}
        onChange={props.onQuickFilter}
        choices={[
          { value: 'all', label: 'All', icon: 'border-all' },
          { value: 'active', label: 'In progress', icon: 'person-digging', title: 'Tasks that have started but are not finished' },
          { value: 'attention', label: `Attention${props.attentionCount > 0 ? ` ${props.attentionCount}` : ''}`, icon: 'triangle-exclamation', title: 'Running late, over budget, or with an open issue' },
        ]}
      />}

      {filtered && !props.planFilter && (
        <span className="pill is-info" data-testid="gantt-count">
          {props.visibleCount} of {props.totalCount}
        </span>
      )}

      {/* Remy's filter, with what it shows, in one pill: the bar keeps to one row. */}
      {props.planFilter && (
        <span className="pill is-info gt-plan-filter" data-testid="gantt-plan-filter" title={`${props.planFilter}: ${props.visibleCount} of ${props.totalCount} tasks, filtered by ${ASSISTANT_NAME}`}>
          <span className={REMY_SPARK_GLYPH} aria-hidden="true" />
          <span>
            <span data-testid="gantt-count">{props.visibleCount} of {props.totalCount}</span> · {props.planFilter}
          </span>
          <button type="button" className="button is-quiet is-sm is-icon gt-plan-filter-clear" aria-label="Clear this filter" data-testid="gantt-plan-filter-clear" onClick={props.onClearPlanFilter}>
            <i className="fa fa-xmark" aria-hidden="true" />
          </button>
        </span>
      )}

      {/* The 3D view puts its way in here, when it is up. */}
      <div className="gt-3d" data-fx3d-slot />
      {props.onOdds && (
        <button
          type="button"
          className="button is-quiet gt-odds"
          aria-pressed={Boolean(props.odds)}
          title="How likely the handover is by its date: the plan run a thousand times on the scheduling engine"
          data-testid="gantt-odds"
          onClick={() => props.onOdds?.(!props.odds)}
        >
          <i className="fa fa-dice" aria-hidden="true" />
          <span>On-time odds</span>
        </button>
      )}
      <div className="gt-spacer" />

      <ViewMenu {...props} />

      <div className="gt-zoom" role="group" aria-label="Zoom">
        <button type="button" className="button is-quiet is-icon" title="Zoom out" aria-label="Zoom out" onClick={() => props.onZoom('out')}>
          <i className="fa fa-minus" aria-hidden="true" />
        </button>
        <button type="button" className="button is-quiet is-icon" title="Fit the whole project" aria-label="Fit the whole project" data-testid="zoom-fit" onClick={() => props.onZoom('fit')}>
          <i className="fa fa-expand" aria-hidden="true" />
        </button>
        <button type="button" className="button is-quiet is-icon" title="Zoom in" aria-label="Zoom in" onClick={() => props.onZoom('in')}>
          <i className="fa fa-plus" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
