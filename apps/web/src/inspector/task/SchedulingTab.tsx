/**
 * Scheduling (Bryntum's Advanced tab): manually scheduled, scheduling mode and effort driven,
 * inactive, the constraint (type and date), the scheduling direction it ends up with, the calendar
 * and resource calendars, the project border, rollup and the WBS code. Every field uses the
 * scheduling term with a one-line hint, saves on its own and is one change for everyone; what the
 * engine did with it (a constraint ignored or not met, the direction or calendar inherited) shows
 * next to it.
 *
 * A phase takes the settings that make sense on a summary task: manually scheduled, inactive, the
 * constraint types the engine applies to summaries, calendar, project border and rollup.
 */
import { BryntumDateField } from '@bryntum/gantt-react';
import type { TaskModel } from '@bryntum/gantt';
import { EDIT_DATE_FORMAT } from '../../gantt/columns';
import {
  setCalendar,
  setConstraint,
  setEffort,
  setEffortDriven,
  setIgnoreResourceCalendar,
  setInactive,
  setManuallyScheduled,
  setProjectBorder,
  setRollup,
  setSchedulingMode,
} from './apply';
import {
  LAG_UNITS,
  PROJECT_BORDER_CHOICES,
  SCHEDULING_MODE_CHOICES,
  calendarChoices,
  constraintChoice,
  constraintChoicesFor,
  constraintDateFor,
  constraintNeedsDate,
  defaultConstraintDate,
  type ConstraintType,
  type TaskView,
} from './model';
import { DurationInput, Notice, Row, Section, Select, Switch, isDate, useLatest, usePanel, useStableDate, type FieldEvent } from './ui';

export function SchedulingTab({ task, view }: { task: TaskModel; view: TaskView }) {
  return (
    <div className="ti-tab-body" data-testid="task-scheduling">
      <SchedulingSection view={view} />
      <ConstraintSection task={task} view={view} />
      <CalendarSection view={view} />
      <MoreSection view={view} />
    </div>
  );
}

function SchedulingSection({ view }: { view: TaskView }) {
  const { project, run } = usePanel();
  const id = view.id;
  const mode = SCHEDULING_MODE_CHOICES.find((choice) => choice.mode === view.schedulingMode) ?? SCHEDULING_MODE_CHOICES[0]!;
  return (
    <Section title="How it is scheduled" testId="task-scheduling-section">
      <Switch
        label="Manually scheduled"
        hint={
          view.isPhase
            ? "Its dates no longer follow the tasks inside it; set them in Details. The tasks inside can't start before it."
            : 'Its dates stay where you put them: links and the constraint no longer move it.'
        }
        checked={view.isManual}
        testId="task-manual"
        onChange={(manual) => void run(() => setManuallyScheduled(project, id, manual))}
      />
      {!view.isPhase && (
        <Row label="Scheduling mode" hint={mode.hint} htmlFor="ti-scheduling-mode">
          <Select
            id="ti-scheduling-mode"
            testId="task-scheduling-mode"
            value={view.schedulingMode}
            options={SCHEDULING_MODE_CHOICES.map((choice) => ({ value: choice.mode, label: choice.label, title: choice.hint }))}
            onChange={(next) => void run(() => setSchedulingMode(project, id, next))}
          />
        </Row>
      )}
      {view.isPhase ? (
        <Row label="Effort" hint="Adds up the tasks inside it." testId="task-effort">
          <p className="ti-readout">
            {view.effort.value} {view.effort.unit}
            {view.effort.value === 1 ? '' : 's'}
          </p>
        </Row>
      ) : (
        <Row label="Effort" hint="The work in this task. Effort driven keeps it when crews change." testId="task-effort">
          <DurationInput
            magnitude={view.effort.value}
            unit={view.effort.unit}
            units={LAG_UNITS}
            ariaLabel="Effort"
            testId="task-effort-input"
            onCommit={(magnitude, unit) => void run(() => setEffort(project, id, magnitude, unit))}
          />
        </Row>
      )}
      {!view.isPhase && (
        <Switch
          label="Effort driven"
          hint="Keeps the effort when crews are added or removed, so the duration changes instead (Fixed Duration and Fixed Units)."
          checked={view.effortDriven}
          testId="task-effort-driven"
          onChange={(effortDriven) => void run(() => setEffortDriven(project, id, effortDriven))}
        />
      )}
      <Switch
        label="Inactive"
        hint="Takes no part in scheduling: its links stop moving other tasks and its effort and cost stop counting."
        checked={view.isInactive}
        testId="task-inactive"
        onChange={(inactive) => void run(() => setInactive(project, id, inactive))}
      />
    </Section>
  );
}

const DIRECTION_WORDS = { Forward: 'Forward (as soon as possible)', Backward: 'Backward (as late as possible)' } as const;

function ConstraintSection({ task, view }: { task: TaskModel; view: TaskView }) {
  const { project, run } = usePanel();
  const id = view.id;
  const { type, day, note } = view.constraint;
  const shownDay = useStableDate(day);
  const choice = constraintChoice(type) ?? constraintChoice(null)!;
  const dated = constraintNeedsDate(type);

  const pickType = (next: ConstraintType | null) => {
    if (!constraintNeedsDate(next)) {
      void run(() => setConstraint(project, id, next));
      return;
    }
    // The day shown stays the day meant; with none yet, the task's own start or finish.
    const date = day ? constraintDateFor(next, day) : defaultConstraintDate(next, task);
    void run(() => setConstraint(project, id, next, date));
  };
  const handlers = useLatest({
    date: ({ value, userAction }: FieldEvent) => {
      if (userAction && isDate(value) && type) void run(() => setConstraint(project, id, type, constraintDateFor(type, value)));
    },
  });

  const direction = view.direction;
  const directionText =
    direction.kind === 'own'
      ? `${DIRECTION_WORDS[direction.value]}, set by its constraint type`
      : `${DIRECTION_WORDS[direction.value]}, ${direction.kind === 'enforced' ? 'enforced by' : 'inherited from'} ${direction.source ?? 'the project'}`;

  return (
    <Section title="Constraint" testId="task-constraint-section">
      <div className="ti-grid">
        <Row label="Constraint type" htmlFor="ti-constraint-type">
          <Select
            id="ti-constraint-type"
            testId="task-constraint-type"
            value={type ?? ''}
            options={constraintChoicesFor(view.isPhase).map((entry) => ({ value: entry.type ?? '', label: entry.label, title: entry.hint }))}
            onChange={(next) => pickType(next === '' ? null : (next as ConstraintType))}
          />
        </Row>
        <Row label={choice.side === 'finish' ? 'Constraint date (finish)' : 'Constraint date'}>
          <BryntumDateField
            cls="ti-field"
            ariaLabel="Constraint date"
            dataset={{ testid: 'task-constraint-date' }}
            format={EDIT_DATE_FORMAT}
            disabled={!dated}
            placeholder={dated ? 'Pick a date' : 'No date'}
            // null clears the field when the type carries no date.
            value={(dated ? shownDay : null) as Date}
            onChange={(event: FieldEvent) => handlers.current.date(event)}
          />
        </Row>
      </div>
      <p className="field-hint" data-testid="task-constraint-hint">
        {choice.hint}
        {view.isPhase && ' A phase takes only the types that apply to summary tasks.'}
      </p>
      {note && (
        <Notice icon={note.tone === 'warn' ? 'triangle-exclamation' : 'circle-info'} tone={note.tone} testId="task-constraint-note">
          {note.text}
        </Notice>
      )}
      <Row label="Scheduling direction" testId="task-direction" hint="As soon as possible schedules forward, as late as possible backward; otherwise it follows its phase or the project.">
        <p className="ti-readout is-text">{directionText}</p>
      </Row>
    </Section>
  );
}

function CalendarSection({ view }: { view: TaskView }) {
  const { project, run } = usePanel();
  const id = view.id;
  const calendars = calendarChoices(project);
  const { calendar } = view;
  const options = [
    { value: '', label: `Project calendar${calendar.projectName ? ` (${calendar.projectName})` : ''}` },
    ...calendars.map((entry) => ({ value: String(entry.id), label: entry.name })),
  ];
  return (
    <Section title="Calendar" testId="task-calendar-section">
      <Row
        label="Calendar"
        htmlFor="ti-calendar"
        hint={
          calendar.countsEveryDay
            ? 'Manually scheduled: its duration counts every day, weekends included, whatever the calendar says.'
            : calendar.ownId === null
              ? `The working days it is scheduled on, together with its crews' calendars. Now: the project calendar, ${calendar.effectiveName || 'its default'}.`
              : `The working days it is scheduled on, together with its crews' calendars. Now: its own, ${calendar.effectiveName}.`
        }
      >
        <Select
          id="ti-calendar"
          testId="task-calendar"
          value={calendar.ownId === null ? '' : String(calendar.ownId)}
          options={options}
          onChange={(next) => {
            const picked = next === '' ? null : (calendars.find((entry) => String(entry.id) === next)?.id ?? next);
            void run(() => setCalendar(project, id, picked));
          }}
        />
      </Row>
      {!view.isPhase && (
        <Switch
          label="Ignore resource calendar"
          hint="Schedules on the task's calendar alone, even where its crews' own calendars say they are off."
          checked={view.ignoreResourceCalendar}
          testId="task-ignore-resource-calendar"
          onChange={(ignore) => void run(() => setIgnoreResourceCalendar(project, id, ignore))}
        />
      )}
    </Section>
  );
}

function MoreSection({ view }: { view: TaskView }) {
  const { project, run } = usePanel();
  const id = view.id;
  const border = PROJECT_BORDER_CHOICES.find((choice) => choice.value === view.projectBorder) ?? PROJECT_BORDER_CHOICES[0]!;
  return (
    <Section title="Project border, rollup and WBS" testId="task-more-section">
      <div className="ti-grid">
        <Row label="Project border" htmlFor="ti-project-border">
          <Select
            id="ti-project-border"
            testId="task-project-border"
            value={view.projectBorder}
            options={PROJECT_BORDER_CHOICES.map((choice) => ({ value: choice.value, label: choice.label, title: choice.hint }))}
            onChange={(next) => void run(() => setProjectBorder(project, id, next))}
          />
        </Row>
        <Row label="WBS code" testId="task-wbs">
          <p className="ti-readout ti-wbs">{view.wbsCode || '—'}</p>
        </Row>
      </div>
      <p className="field-hint">{border.hint} The WBS code is its place in the outline and follows the order of the plan.</p>
      <Switch
        label="Rollup"
        hint="Draws this task on its phase's bar when the plan shows rollups."
        checked={view.rollup}
        testId="task-rollup"
        onChange={(rollup) => void run(() => setRollup(project, id, rollup))}
      />
    </Section>
  );
}
