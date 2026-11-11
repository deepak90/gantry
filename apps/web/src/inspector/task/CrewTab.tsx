/**
 * Crew (the people half of Bryntum's Resources tab; machines are in the Equipment tab): who does the
 * work and a picker to add one. Adding and removing are each one edit. A crew works the task full time:
 * how much of a crew's time a task takes (Bryntum's assignment units) only matters for effort-driven
 * scheduling, which this plan does not use, so it is not shown. A phase shows the crews working on the
 * tasks inside it.
 */
import { useMemo } from 'react';
import type { TaskModel } from '@bryntum/gantt';
import { assignCrew, setCrewSize, unassignCrew } from './apply';
import { crewCandidates, type CrewView, type TaskView } from './model';
import { Picker } from './Picker';
import { CrewBadge, Notice, Section, usePanel } from './ui';

export function CrewTab({ task, view }: { task: TaskModel; view: TaskView }) {
  const { project } = usePanel();
  const crew = view.crew.filter((member) => !member.equipment);
  const crewInside = view.crewInside.filter((member) => !member.equipment);
  const crewKey = view.crew.map((member) => member.resourceId).join(',');
  const options = useMemo(
    () =>
      view.isPhase
        ? []
        : crewCandidates(project, task)
            .filter((candidate) => !candidate.equipment)
            .map((candidate) => ({
              id: candidate.id,
              text: candidate.name,
              sub: ['Crew', candidate.company].filter(Boolean).join(' · '),
              icon: candidate.icon,
              color: candidate.color,
            })),
    [project, task, view.isPhase, crewKey],
  );

  if (view.isPhase) {
    return (
      <div className="ti-tab-body" data-testid="task-crew">
        <Notice icon="layer-group">Crews are put on the tasks inside a phase. These crews work somewhere in it.</Notice>
        <Section title="Working inside this phase" aside={crewInside.length > 0 ? String(crewInside.length) : undefined}>
          {crewInside.length === 0 ? (
            <p className="ti-empty-line">No crews on its tasks yet.</p>
          ) : (
            <ul className="ti-crew-list">
              {crewInside.map((member) => (
                <li key={String(member.resourceId)} className="ti-crew">
                  <CrewBadge color={member.color} icon={member.icon} />
                  <span className="ti-crew-text">
                    <strong>{member.name}</strong>
                    {member.company && <em>{member.company}</em>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    );
  }

  return (
    <div className="ti-tab-body" data-testid="task-crew">
      <Section title="On this task" aside={crew.length > 0 ? String(crew.length) : undefined}>
        {crew.length === 0 ? (
          <p className="ti-empty-line">Nobody yet. Pick a crew below, or drag one from the Crews tab onto the bar.</p>
        ) : (
          <ul className="ti-crew-list">
            {crew.map((member) => (
              <CrewRow key={String(member.assignmentId)} member={member} />
            ))}
          </ul>
        )}
        <Picker testId="task-crew-picker" placeholder="Add a crew…" options={options} onPick={(resourceId) => assignCrew(project, view.id, resourceId)} />
      </Section>
    </div>
  );
}

function CrewRow({ member }: { member: CrewView }) {
  const { project, run } = usePanel();
  return (
    <li className="ti-crew" data-testid="task-crew-row">
      <CrewBadge color={member.color} icon={member.icon} />
      <span className="ti-crew-text">
        <strong>{member.name}</strong>
        {member.company && <em>{member.company}</em>}
      </span>
      <label className="ti-crew-size" title={member.people === null ? `Not set: counts as the usual ${member.usualPeople} for this trade` : 'People on this task'}>
        <span>People</span>
        <input
          key={member.people ?? 'usual'}
          type="number"
          min={1}
          max={999}
          inputMode="numeric"
          data-testid="task-crew-people"
          defaultValue={member.people ?? ''}
          placeholder={String(member.usualPeople)}
          onBlur={(event) => {
            const typed = event.currentTarget.value.trim();
            const next = typed === '' ? null : Number(typed);
            if (next !== member.people) void run(() => setCrewSize(project, member.assignmentId, next));
          }}
        />
      </label>
      <button
        type="button"
        className="button is-quiet is-icon is-sm"
        aria-label={`Take ${member.name} off this task`}
        title="Take off this task"
        onClick={() => void run(() => unassignCrew(project, member.assignmentId))}
      >
        <i className="fa fa-xmark" aria-hidden="true" />
      </button>
    </li>
  );
}
