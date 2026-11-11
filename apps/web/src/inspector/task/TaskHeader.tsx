/**
 * The head of the task panel: where the task sits (phase › work package), its name (edited in
 * place, saved when the box is left or on Enter), its state in pills and the crews on it.
 */
import type { TaskModel } from '@bryntum/gantt';
import { phaseClass, STATUS_LABELS, type TaskBadge } from '../../gantt/look';
import { renameTask } from './apply';
import { TaskActions } from './TaskActions';
import type { TaskView } from './model';
import { CrewBadge, Pill, plural, useCommittedText, usePanel, type EditState, type Tone } from './ui';

const STATUS_TONES: Readonly<Record<TaskView['status'], Tone>> = { done: 'ok', active: 'busy', todo: 'neutral' };

export interface TaskHeaderProps {
  task: TaskModel;
  view: TaskView;
  badges: readonly TaskBadge[];
  /** Rented equipment paid for while the task cannot start yet. */
  edit: EditState;
  onDismissError(): void;
}

export function TaskHeader({ task, view, badges, edit, onDismissError }: TaskHeaderProps) {
  const { project, run } = usePanel();
  const name = useCommittedText(view.name, (next) => run(() => renameTask(project, view.id, next)));
  const crew = view.isPhase ? view.crewInside : view.crew;

  return (
    <header className={`ti-head ${phaseClass(task)}`}>
      <div className="ti-head-top">
        <span className="ti-head-icon" aria-hidden="true">
          <i className={`fa fa-${view.icon}`} />
        </span>
        {view.wbsCode && (
          <span className="pill ti-wbs" title="WBS code: its place in the outline">
            {view.wbsCode}
          </span>
        )}
        <nav className="ti-breadcrumb" aria-label="Where this task sits">
          {view.path.length === 0 ? (
            <span>{view.isPhase ? 'Phase' : 'Top of the plan'}</span>
          ) : (
            view.path.map((part, index) => (
              <span key={`${index}-${part}`} className="ti-crumb">
                {index > 0 && <i className="fa fa-chevron-right" aria-hidden="true" />}
                <span>{part}</span>
              </span>
            ))
          )}
        </nav>
        <TaskActions task={task} view={view} />
      </div>
      <input
        className="ti-name"
        aria-label="Task name"
        data-testid="task-name"
        value={name.draft}
        onFocus={name.onFocus}
        onChange={(event) => name.setDraft(event.target.value)}
        onBlur={(event) => void name.save(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            name.revert();
            event.currentTarget.blur();
          }
        }}
      />
      <div className="ti-pills">
        <Pill tone={STATUS_TONES[view.status]} icon={view.status === 'done' ? 'circle-check' : view.status === 'active' ? 'person-digging' : 'clock'}>
          {view.isPhase && view.inside ? `${view.inside.done} of ${plural(view.inside.tasks, 'task')} done` : `${STATUS_LABELS[view.status]}${view.status === 'active' ? ` · ${view.progress}%` : ''}`}
        </Pill>
        {view.isPhase && <Pill icon="layer-group">Phase</Pill>}
        {view.isMilestone && <Pill icon="diamond">Milestone</Pill>}
        {view.isManual && (
          <Pill icon="thumbtack" title="Links and the constraint no longer move it">
            Manually scheduled
          </Pill>
        )}
        {view.isInactive && (
          <Pill tone="warn" icon="power-off" title="Takes no part in scheduling">
            Inactive
          </Pill>
        )}
        {view.pastDeadline > 0 && (
          <Pill tone="alert" icon="flag" title="Finishes after its deadline">
            {plural(view.pastDeadline, 'day')} past deadline
          </Pill>
        )}
        {view.slip > 0 && view.status !== 'done' && (
          <Pill tone="warn" icon="clock" title="Later than the plan everyone agreed">
            {plural(view.slip, 'day')} late
          </Pill>
        )}
        {badges.map((badge) => (
          <Pill key={badge.text} tone={badge.tone} icon={badge.icon}>
            {badge.text}
          </Pill>
        ))}
      </div>
      {crew.length > 0 && (
        <ul className="ti-head-crew" aria-label={view.isPhase ? 'Crews working inside this phase' : 'Crews on this task'}>
          {crew.map((member) => (
            <li key={String(member.resourceId)} className="pill is-label ti-head-crew-chip" title={member.company ? `${member.name} · ${member.company}` : member.name}>
              <CrewBadge color={member.color} icon={member.icon} size="sm" />
              <span>{member.name}</span>
            </li>
          ))}
        </ul>
      )}
      <EditStatus edit={edit} onDismiss={onDismissError} />
    </header>
  );
}

function EditStatus({ edit, onDismiss }: { edit: EditState; onDismiss(): void }) {
  if (edit.kind === 'error') {
    return (
      <p className="note is-danger ti-status is-error" role="alert" data-testid="task-edit-error">
        <i className="fa fa-circle-exclamation" aria-hidden="true" />
        <span>Not saved: {edit.message}</span>
        <button type="button" className="button is-quiet is-icon is-sm" aria-label="Dismiss" onClick={onDismiss}>
          <i className="fa fa-xmark" aria-hidden="true" />
        </button>
      </p>
    );
  }
  return (
    <p className={`ti-status is-${edit.kind}`} aria-live="polite" data-testid="task-edit-status">
      {edit.kind === 'saving' && (
        <>
          <i className="fa fa-circle-notch fa-spin" aria-hidden="true" /> Saving…
        </>
      )}
      {edit.kind === 'saved' && (
        <>
          <i className="fa fa-check" aria-hidden="true" /> Saved for everyone
        </>
      )}
      {edit.kind === 'idle' && 'Changes save as you make them, for everyone.'}
    </p>
  );
}
