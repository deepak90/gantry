/**
 * Details (Bryntum's General tab, plus the deadline): start, finish, duration, progress, milestone,
 * deadline, color and the parts of a split task. Each field saves on its own when committed (a date
 * picked or typed and confirmed, a spinner settling, the slider released), as one change for everyone.
 *
 * A phase's dates follow the tasks inside it while it is scheduled automatically and are shown
 * read-only; a manually scheduled phase has its own dates, edited here like a task's. A phase's
 * progress always adds up its tasks. Effort is in the Scheduling tab, with what it affects.
 */
import { useState } from 'react';
import { BryntumDateField, BryntumNumberField, BryntumSlider } from '@bryntum/gantt-react';
import { EDIT_DATE_FORMAT } from '../../gantt/columns';
import { joinSegments, moveSegment, resizeSegment, setDeadline, setMilestone, setProgress, setScheduleField, setTaskColor, splitTask } from './apply';
import { TASK_COLORS, type SegmentView, type TaskView } from './model';
import { Notice, Pill, Row, Section, Switch, isDate, longDay, plural, shortDay, useLatest, usePanel, useStableDate, type FieldEvent } from './ui';

export function DetailsTab({ view }: { view: TaskView }) {
  return (
    <div className="ti-tab-body" data-testid="task-details">
      {view.isInactive && (
        <Notice icon="power-off" testId="task-inactive-notice">
          Inactive: this task takes no part in scheduling. Turn it back on in the Scheduling tab.
        </Notice>
      )}
      {view.canEditDates ? <EditableDates view={view} /> : <PhaseDates view={view} />}
      <Progress view={view} />
      <DeadlineAndColor view={view} />
      {view.segments.length > 0 ? <Parts view={view} /> : view.canEditDates && !view.isPhase && !view.isMilestone && view.days > 1 && <SplitTask view={view} />}
    </div>
  );
}

/** A task done in separate stretches: each part has its own start and days, as dragging it on the plan gives it. */
function Parts({ view }: { view: TaskView }) {
  return (
    <Section title={`Split into ${view.segments.length} parts`} testId="task-parts">
      <ol className="ti-parts">
        {view.segments.map((segment) => (
          <Part key={segment.index} view={view} segment={segment} last={segment.index === view.segments.length - 1} />
        ))}
      </ol>
    </Section>
  );
}

function Part({ view, segment, last }: { view: TaskView; segment: SegmentView; last: boolean }) {
  const { project, run } = usePanel();
  const start = useStableDate(segment.start);
  const id = view.id;
  const handlers = useLatest({
    start: ({ value, userAction }: FieldEvent) => {
      if (userAction && isDate(value)) void run(() => moveSegment(project, id, segment.index, value));
    },
    days: ({ value, userAction }: FieldEvent) => {
      if (userAction && typeof value === 'number' && Number.isFinite(value) && value > 0) void run(() => resizeSegment(project, id, segment.index, value));
    },
  });
  return (
    <li className="ti-part" data-testid="task-part">
      <span className="ti-segment-name">{segment.name}</span>
      <Row label="Start">
        <BryntumDateField
          cls="ti-field"
          ariaLabel={`${segment.name} start`}
          dataset={{ testid: 'task-part-start' }}
          format={EDIT_DATE_FORMAT}
          value={start ?? undefined}
          onChange={(event: FieldEvent) => handlers.current.start(event)}
        />
      </Row>
      <Row label="Days">
        <BryntumNumberField
          cls="ti-field"
          ariaLabel={`${segment.name} days`}
          dataset={{ testid: 'task-part-days' }}
          min={0.5}
          step={1}
          format="0.#"
          changeOnSpin={450}
          value={segment.days}
          onChange={(event: FieldEvent) => handlers.current.days(event)}
        />
      </Row>
      {!last && (
        <button type="button" className="button is-link ti-part-join" data-testid="task-part-join" onClick={() => void run(() => joinSegments(project, id, segment.index))}>
          <i className="fa fa-link" aria-hidden="true" /> Join with the next part
        </button>
      )}
    </li>
  );
}

/** Cutting a task in two: where, and how long the work stops for. */
function SplitTask({ view }: { view: TaskView }) {
  const { project, run } = usePanel();
  const [open, setOpen] = useState(false);
  const middle = new Date((view.start!.getTime() + view.lastDay!.getTime()) / 2);
  middle.setHours(0, 0, 0, 0);
  const [from, setFrom] = useState<Date>(middle);
  const [gap, setGap] = useState(1);
  if (!open) {
    return (
      <button type="button" className="button is-link ti-split-open" data-testid="task-split-open" onClick={() => setOpen(true)}>
        <i className="fa fa-scissors" aria-hidden="true" /> Split this task…
      </button>
    );
  }
  return (
    <Section title="Split this task" testId="task-split-form">
      <div className="ti-grid">
        <Row label="Stop on">
          <BryntumDateField
            cls="ti-field"
            ariaLabel="Day the work stops"
            dataset={{ testid: 'task-split-from' }}
            format={EDIT_DATE_FORMAT}
            value={from}
            onChange={({ value, userAction }: FieldEvent) => {
              if (userAction && isDate(value)) setFrom(value);
            }}
          />
        </Row>
        <Row label="For (days)">
          <BryntumNumberField
            cls="ti-field"
            ariaLabel="Days the work stops for"
            dataset={{ testid: 'task-split-gap' }}
            min={0}
            step={1}
            format="0"
            value={gap}
            onChange={({ value, userAction }: FieldEvent) => {
              if (userAction && typeof value === 'number' && Number.isFinite(value)) setGap(value);
            }}
          />
        </Row>
      </div>
      <div className="ti-split-actions">
        <button
          type="button"
          className="button is-primary is-sm"
          data-testid="task-split"
          onClick={() =>
            void run(() => splitTask(project, view.id, from, gap)).then((done) => {
              if (done) setOpen(false);
            })
          }
        >
          Split
        </button>
        <button type="button" className="button is-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </Section>
  );
}

function PlannedFinish({ view }: { view: TaskView }) {
  const late = view.slip > 0 && view.status !== 'done';
  return (
    <p className={`ti-readout${late ? ' is-warn' : ''}`}>
      {view.plannedLastDay ? shortDay(view.plannedLastDay) : 'No plan saved'}
      {late && <em>{plural(view.slip, 'day')} late</em>}
    </p>
  );
}

/** Start, finish and duration of a task or a manually scheduled phase. */
function EditableDates({ view }: { view: TaskView }) {
  const { project, run } = usePanel();
  const start = useStableDate(view.start);
  const lastDay = useStableDate(view.lastDay);
  const id = view.id;

  // Bryntum keeps the handler it was given first; these read the latest props.
  const handlers = useLatest({
    start: ({ value, userAction }: FieldEvent) => {
      if (userAction && isDate(value)) void run(() => setScheduleField(project, id, 'start', value));
    },
    lastDay: ({ value, userAction }: FieldEvent) => {
      if (userAction && isDate(value)) void run(() => setScheduleField(project, id, 'lastDay', value));
    },
    days: ({ value, userAction }: FieldEvent) => {
      if (userAction && typeof value === 'number' && Number.isFinite(value) && value >= 0) void run(() => setScheduleField(project, id, 'days', value));
    },
  });

  return (
    <Section title="Dates" aside={view.isManual ? <Pill icon="thumbtack">Manually scheduled</Pill> : undefined} testId="task-dates">
      <div className="ti-grid">
        <Row label={view.isMilestone ? 'Date' : 'Start'}>
          <BryntumDateField
            cls="ti-field"
            ariaLabel={view.isMilestone ? 'Date' : 'Start'}
            dataset={{ testid: 'task-start' }}
            format={EDIT_DATE_FORMAT}
            value={start ?? undefined}
            onChange={(event: FieldEvent) => handlers.current.start(event)}
          />
        </Row>
        {!view.isMilestone && (
          <Row label="Finish">
            <BryntumDateField
              cls="ti-field"
              ariaLabel="Finish (last working day)"
              dataset={{ testid: 'task-finish' }}
              format={EDIT_DATE_FORMAT}
              value={lastDay ?? undefined}
              onChange={(event: FieldEvent) => handlers.current.lastDay(event)}
            />
          </Row>
        )}
        {!view.isMilestone && (
          <Row label="Duration (days)">
            <BryntumNumberField
              cls="ti-field"
              ariaLabel="Duration in days"
              dataset={{ testid: 'task-duration' }}
              min={0}
              step={1}
              format="0.#"
              changeOnSpin={450}
              value={view.days}
              onChange={(event: FieldEvent) => handlers.current.days(event)}
            />
          </Row>
        )}
        {!view.isMilestone && (
          <Row label="Planned finish">
            <PlannedFinish view={view} />
          </Row>
        )}
      </div>
      {view.isManual ? (
        <p className="field-hint">
          Manually scheduled: links and the constraint don't move it, and its duration counts every day, weekends included.
          {view.isPhase && ' The tasks inside it can no longer start before it.'}
        </p>
      ) : (
        <p className="field-hint">Finish is the last working day. Moving the start pins it there (a Start no earlier than constraint).</p>
      )}
      {!view.isPhase && (
        <Switch
          label="Milestone"
          hint="A single date with no duration, like a handover or a sign-off."
          checked={view.isMilestone}
          testId="task-milestone"
          onChange={(milestone) => void run(() => setMilestone(project, id, milestone))}
        />
      )}
    </Section>
  );
}

/** An automatically scheduled phase: dates that follow its tasks. */
function PhaseDates({ view }: { view: TaskView }) {
  return (
    <Section title="Dates" testId="task-dates">
      <Notice icon="layer-group">
        A phase's dates follow the tasks inside it. To set them yourself, turn on <strong>Manually scheduled</strong> in the Scheduling tab.
      </Notice>
      <dl className="ti-facts">
        <div>
          <dt>Start</dt>
          <dd>{longDay(view.start)}</dd>
        </div>
        <div>
          <dt>Finish</dt>
          <dd>{longDay(view.lastDay)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{plural(view.days, 'day')}</dd>
        </div>
        <div>
          <dt>Planned finish</dt>
          <dd className={view.slip > 0 ? 'is-warn' : undefined}>
            {view.plannedLastDay ? shortDay(view.plannedLastDay) : '—'}
            {view.slip > 0 && <em>{plural(view.slip, 'day')} late</em>}
          </dd>
        </div>
      </dl>
    </Section>
  );
}

/**
 * Progress: one value, typed or dragged. The number and the slider show the same % complete; either
 * saves it. A phase's progress adds up the tasks inside it and is shown, not edited.
 */
function Progress({ view }: { view: TaskView }) {
  const { project, run } = usePanel();
  const id = view.id;
  const handlers = useLatest({
    progress: ({ value, userAction }: FieldEvent) => {
      if (userAction && typeof value === 'number' && Number.isFinite(value)) void run(() => setProgress(project, id, value));
    },
  });

  if (view.isPhase) {
    return (
      <Section title="Progress" testId="task-progress-section">
        <div className="ti-progress" aria-label={`${view.progress}% complete`}>
          <span className="look-progress-track">
            <span className="look-progress-fill" style={{ width: `${view.progress}%` }} />
          </span>
          <span>{view.progress}%</span>
          {view.inside && <em>{`${view.inside.done} of ${plural(view.inside.tasks, 'task')} done`}</em>}
        </div>
        <p className="field-hint">A phase’s progress adds up the tasks inside it.</p>
      </Section>
    );
  }
  if (view.isMilestone) return null;

  return (
    <Section title="Progress" testId="task-progress-section">
      <div className="ti-progress-edit">
        <BryntumSlider
          cls="ti-slider"
          ariaLabel="Progress"
          dataset={{ testid: 'task-progress' }}
          min={0}
          max={100}
          step={5}
          showValue={false}
          showTooltip={false}
          value={view.progress}
          onChange={(event: FieldEvent) => handlers.current.progress(event)}
        />
        <span className="ti-progress-number">
          <BryntumNumberField
            cls="ti-field"
            ariaLabel="% complete"
            dataset={{ testid: 'task-percent-done' }}
            min={0}
            max={100}
            step={1}
            format="0"
            changeOnSpin={450}
            value={view.progress}
            onChange={(event: FieldEvent) => handlers.current.progress(event)}
          />
          <span aria-hidden="true">%</span>
        </span>
      </div>
    </Section>
  );
}

function DeadlineAndColor({ view }: { view: TaskView }) {
  const { project, run } = usePanel();
  const deadline = useStableDate(view.deadline);
  const id = view.id;
  const handlers = useLatest({
    deadline: ({ value, userAction }: FieldEvent) => {
      if (!userAction) return;
      if (value === null || value === undefined || value === '') void run(() => setDeadline(project, id, null));
      else if (isDate(value)) void run(() => setDeadline(project, id, value));
    },
  });
  const named = TASK_COLORS.some((entry) => entry.name === view.color);

  return (
    <Section title="Deadline and color" testId="task-marking">
      <Row label="Deadline" hint="The day it should finish by. It doesn't move the task; the plan marks the day.">
        <BryntumDateField
          cls="ti-field"
          ariaLabel="Deadline"
          dataset={{ testid: 'task-deadline' }}
          format={EDIT_DATE_FORMAT}
          clearable
          placeholder="No deadline"
          value={deadline ?? undefined}
          onChange={(event: FieldEvent) => handlers.current.deadline(event)}
        />
      </Row>
      {view.pastDeadline > 0 && (
        <Notice icon="triangle-exclamation" tone="warn" testId="task-deadline-warning">
          Finishes {shortDay(view.lastDay)}, {plural(view.pastDeadline, 'day')} after its deadline.
        </Notice>
      )}
      <Row label="Color" hint="Bryntum's task color, saved for everyone. The plan colors its bars by phase or crew.">
        <div className="ti-swatches" role="radiogroup" aria-label="Color" data-testid="task-color">
          <button
            type="button"
            role="radio"
            aria-checked={view.color === null}
            className={`ti-swatch is-none${view.color === null ? ' is-active' : ''}`}
            title="No color"
            onClick={() => void run(() => setTaskColor(project, id, null))}
          >
            <i className="fa fa-ban" aria-hidden="true" />
          </button>
          {TASK_COLORS.map((entry) => (
            <button
              key={entry.name}
              type="button"
              role="radio"
              aria-checked={view.color === entry.name}
              aria-label={entry.name}
              title={entry.name}
              className={`ti-swatch${view.color === entry.name ? ' is-active' : ''}`}
              style={{ background: entry.swatch }}
              onClick={() => void run(() => setTaskColor(project, id, entry.name))}
            />
          ))}
          {view.color && !named && (
            <span className="ti-swatch is-active" role="radio" aria-checked title={view.color} style={{ background: view.color }} />
          )}
        </div>
      </Row>
    </Section>
  );
}
