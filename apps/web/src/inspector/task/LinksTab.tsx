/**
 * Links (Bryntum's Predecessors and Successors tabs): what the task waits for and what waits for
 * it. Each link has its dependency type (all four: finish-to-start, start-to-start,
 * finish-to-finish, start-to-finish), its lag with a unit (negative: a lead, they overlap) and an
 * Active switch (an inactive link stays but no longer moves anything), with the result in one
 * sentence. Picking a task in the picker adds a finish-to-start link at once; every change is one
 * edit.
 */
import { useMemo } from 'react';
import type { TaskModel } from '@bryntum/gantt';
import { addLink, removeLink, setLinkActive, setLinkKind, setLinkLag } from './apply';
import { LAG_UNITS, LINK_TYPE_CHOICES, linkCandidates, type LinkType, type LinkView, type TaskView } from './model';
import { Picker } from './Picker';
import { DurationInput, Notice, Section, Select, Switch, usePanel } from './ui';

type Side = 'waits' | 'leads';

export function LinksTab({ task, view }: { task: TaskModel; view: TaskView }) {
  return (
    <div className="ti-tab-body" data-testid="task-links">
      <LinkSection task={task} view={view} side="waits" />
      <LinkSection task={task} view={view} side="leads" />
      <Notice icon="circle-info">
        Lag is counted in the waiting task's working time: type <strong>2d</strong>, <strong>1w</strong> or <strong>4h</strong>. A negative lag (a lead) lets them overlap:{' '}
        <strong>-1d</strong>.
      </Notice>
    </div>
  );
}

const SIDE_TEXT: Readonly<Record<Side, { title: string; empty: string; picker: string }>> = {
  waits: { title: 'Predecessors (waits for)', empty: 'None: it can start whenever its own dates say.', picker: 'Add a predecessor…' },
  leads: { title: 'Successors (lead to)', empty: 'Nothing waits for this task.', picker: 'Add a successor…' },
};

function LinkSection({ task, view, side }: { task: TaskModel; view: TaskView; side: Side }) {
  const { project } = usePanel();
  const links = side === 'waits' ? view.waitsFor : view.leadsTo;
  const text = SIDE_TEXT[side];
  // Re-read the candidates whenever the links change (the other person's changes too).
  const linkKey = `${view.waitsFor.map((link) => link.otherId).join(',')}/${view.leadsTo.map((link) => link.otherId).join(',')}`;
  const options = useMemo(
    () => linkCandidates(project, task, side).map((option) => ({ id: option.id, text: option.name, sub: option.path, icon: option.icon, muted: option.isPhase })),
    [project, task, side, linkKey],
  );
  return (
    <Section title={text.title} aside={links.length > 0 ? String(links.length) : undefined} testId={`task-links-${side}`}>
      {links.length === 0 ? (
        <p className="ti-empty-line">{text.empty}</p>
      ) : (
        <ul className="ti-links">
          {links.map((link) => (
            <LinkRow key={String(link.id)} link={link} />
          ))}
        </ul>
      )}
      <Picker
        testId={`task-link-picker-${side}`}
        placeholder={text.picker}
        options={options}
        onPick={(otherId) =>
          side === 'waits' ? addLink(project, { fromId: otherId, toId: view.id, type: 2 }) : addLink(project, { fromId: view.id, toId: otherId, type: 2 })
        }
      />
    </Section>
  );
}

const TYPE_OPTIONS = LINK_TYPE_CHOICES.map((choice) => ({ value: choice.type, label: choice.label }));

function LinkRow({ link }: { link: LinkView }) {
  const { project, run, openTask } = usePanel();
  return (
    <li className={`ti-link${link.active ? '' : ' is-off'}`} data-testid="task-link" data-link-id={String(link.id)}>
      <div className="ti-link-head">
        <span className="ti-link-icon" aria-hidden="true">
          <i className={`fa fa-${link.otherIcon}`} />
        </span>
        <button
          type="button"
          className="ti-link-name"
          title="Show this task"
          disabled={!openTask || typeof link.otherId !== 'number'}
          onClick={() => typeof link.otherId === 'number' && openTask?.(link.otherId)}
        >
          <strong>{link.otherName}</strong>
          {link.otherPath.length > 0 && <span>{link.otherPath.join(' › ')}</span>}
        </button>
        <button
          type="button"
          className="button is-quiet is-icon is-sm ti-link-remove"
          aria-label={`Remove the link with ${link.otherName}`}
          title="Remove this link"
          onClick={() => void run(() => removeLink(project, link.id))}
        >
          <i className="fa fa-link-slash" aria-hidden="true" />
        </button>
      </div>
      <div className="ti-link-controls">
        <Select
          className="ti-link-type"
          ariaLabel={`Dependency type with ${link.otherName}`}
          testId="task-link-type"
          value={link.type as LinkType}
          options={TYPE_OPTIONS}
          onChange={(type) => void run(() => setLinkKind(project, link.id, type))}
        />
        <div className="ti-lag">
          <span className="ti-lag-label" aria-hidden="true">
            Lag
          </span>
          <DurationInput
            magnitude={link.lagValue}
            unit={link.lagUnit}
            units={LAG_UNITS}
            allowNegative
            ariaLabel={`Lag for the link with ${link.otherName}`}
            testId="task-link-lag"
            onCommit={(magnitude, unit) => void run(() => setLinkLag(project, link.id, magnitude, unit))}
          />
        </div>
        <Switch label="Active" checked={link.active} testId="task-link-active" onChange={(active) => void run(() => setLinkActive(project, link.id, active))} />
      </div>
      <p className={`ti-link-sentence${link.lagValue > 0 ? ' is-wait' : link.lagValue < 0 ? ' is-overlap' : ''}`} data-testid="task-link-sentence">
        {link.active ? (
          link.sentence
        ) : (
          <>
            <strong>Inactive, not applied:</strong> {link.sentence}
          </>
        )}
      </p>
    </li>
  );
}
