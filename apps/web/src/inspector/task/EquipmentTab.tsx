/**
 * Equipment: the machines on a task, each with the dates it is on site for this task, what those come to,
 * and a way to take it off. The same edits as the Equipment cell's popup on the plan, one change each, undone
 * with the plan. A machine's dates belong to it on this task: other tasks using it keep theirs. Dates with
 * money behind them lock while PayPal pays or a fix waits to be paid. A phase shows the machines inside it.
 */
import { useMemo } from 'react';
import { BryntumDateField } from '@bryntum/gantt-react';
import type { TaskModel } from '@bryntum/gantt';
import { addDays, parseDateOnly } from '@collab/shared';
import { applyRentalDates, removeEquipment, rentalDatesChange, rentalNote } from '../../gantt/cell-editors';
import { EDIT_DATE_FORMAT } from '../../gantt/columns';
import { wholeMoney } from '../../gantt/look';
import type { WorkflowSnapshot } from '../../workflow/api';
import { rentalEditsFor, rentalStanding, type RentalEdit } from '../../workflow/rental';
import { PayRental, type RentalPayEnv } from '../../editor/PayRental';
import { balanceOwner } from '../../payments/payout-sheet';
import { assignCrew, EditError } from './apply';
import { crewCandidates, type CrewView, type TaskView } from './model';
import { Picker } from './Picker';
import { CrewBadge, Notice, Row, Section, isDate, plural, shortDay, useLatest, usePanel, useStableDate, type FieldEvent } from './ui';
import { ASSISTANT_NAME } from '../../assistant/identity';

export function EquipmentTab({ task, view, workflow, rentalPay }: { task: TaskModel; view: TaskView; workflow: WorkflowSnapshot | null; rentalPay?: RentalPayEnv | undefined }) {
  const { project, canViewCosts } = usePanel();
  const machines = view.crew.filter((member) => member.equipment);
  const machineKey = view.crew.map((member) => member.resourceId).join(',');
  const options = useMemo(
    () =>
      view.isPhase
        ? []
        : crewCandidates(project, task)
            .filter((candidate) => candidate.equipment)
            .map((candidate) => ({ id: candidate.id, text: candidate.name, sub: candidate.company, icon: candidate.icon, color: candidate.color })),
    [project, task, view.isPhase, machineKey],
  );

  if (view.isPhase) {
    const inside = view.crewInside.filter((member) => member.equipment);
    return (
      <div className="ti-tab-body" data-testid="task-equipment">
        <Notice icon="layer-group">Machines are put on the tasks inside a phase. These work somewhere in it.</Notice>
        <Section title="Working inside this phase" aside={inside.length > 0 ? String(inside.length) : undefined}>
          {inside.length === 0 ? (
            <p className="ti-empty-line">No machines on its tasks yet.</p>
          ) : (
            <ul className="ti-crew-list">
              {inside.map((member) => (
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

  const rentals = typeof view.id === 'number' ? rentalEditsFor(workflow, project, view.id, canViewCosts) : [];
  return (
    <div className="ti-tab-body" data-testid="task-equipment">
      <Section title="On this task" aside={machines.length > 0 ? String(machines.length) : undefined}>
        {machines.length === 0 ? (
          <p className="ti-empty-line">No machines. Pick one below, or drag one from the Crews tab onto the bar.</p>
        ) : (
          <ul className="ti-machines">
            {machines.map((member) => {
              const rental = rentals.find((candidate) => candidate.assignmentId === member.assignmentId);
              return <Machine key={String(member.assignmentId)} task={task} member={member} rental={rental ?? null} workflow={workflow} rentalPay={rentalPay} />;
            })}
          </ul>
        )}
        <Picker testId="task-equipment-picker" placeholder="Add a machine…" options={options} onPick={(resourceId) => assignCrew(project, view.id, resourceId)} />
      </Section>
      {machines.length > 0 && <Notice icon="weight-hanging">Rented equipment is paid for every day it is booked, weekends too, whether or not anyone is working. Set the dates here, or ask {ASSISTANT_NAME}, say for a day either side of the work.</Notice>}
    </div>
  );
}

function Machine({ task, member, rental, workflow, rentalPay }: { task: TaskModel; member: CrewView; rental: RentalEdit | null; workflow: WorkflowSnapshot | null; rentalPay: RentalPayEnv | undefined }) {
  const { project, run } = usePanel();
  const locked = rental?.locked ?? null;
  return (
    <li className="ti-machine" data-testid="task-equipment-row" data-equipment={member.name}>
      <div className="ti-machine-head">
        <CrewBadge color={member.color} icon={member.icon} />
        <span className="ti-crew-text">
          <strong>{member.name}</strong>
          <em>{rental?.bookingId ? `Rental from ${rental.supplier}` : member.company || 'No rental booked for this task'}</em>
        </span>
        <button
          type="button"
          className="button is-quiet is-icon is-sm"
          aria-label={`Take ${member.name} off this task`}
          title={locked ?? 'Take off this task'}
          disabled={locked !== null}
          data-testid="task-equipment-remove"
          onClick={() => void run(() => removeEquipment(project, task, member.resourceId as number))}
        >
          <i className="fa fa-xmark" aria-hidden="true" />
        </button>
      </div>
      {rental && <RentalDates rental={rental} workflow={workflow} rentalPay={rentalPay} />}
    </li>
  );
}

function RentalDates({ rental, workflow, rentalPay }: { rental: RentalEdit; workflow: WorkflowSnapshot | null; rentalPay: RentalPayEnv | undefined }) {
  const { project, run } = usePanel();
  const start = useStableDate(parseDateOnly(rental.start));
  const lastDay = useStableDate(parseDateOnly(addDays(rental.end, -1)));
  const locked = rental.locked !== null;
  const save = (from: unknown, last: unknown): void => {
    const asked = rentalDatesChange(rental, from, last);
    void run(() => (typeof asked === 'string' ? Promise.reject(new EditError(asked)) : applyRentalDates(project, rental, asked)));
  };
  const handlers = useLatest({
    // A start past the last day takes the last day along with it, as the popup does.
    start: ({ value, userAction }: FieldEvent) => {
      if (userAction && isDate(value)) save(value, lastDay && value > lastDay ? value : lastDay);
    },
    lastDay: ({ value, userAction }: FieldEvent) => {
      if (userAction && isDate(value)) save(start, value);
    },
  });
  const days = rental.rentalDays(rental.start, rental.end);
  const idle = rental.idleDays(rental.start, rental.end);
  const idleDays = idle.before + idle.after;
  const offDays = rental.offDays(rental.start, rental.end);
  const buffer = rental.isBuffer(rental.start, rental.end);
  const booking = workflow?.bookings.find((candidate) => candidate.id === rental.bookingId) ?? null;
  const [workFirst, workLast] = [shortDay(parseDateOnly(rental.taskStart)), shortDay(parseDateOnly(addDays(rental.taskEnd, -1)))];
  const workDays = workFirst === workLast ? workFirst : `${workFirst} to ${workLast}`;
  return (
    <>
      <div className="ti-grid">
        <Row label="On rent from">
          <BryntumDateField
            cls="ti-field"
            ariaLabel="On rent from"
            dataset={{ testid: 'task-equipment-start' }}
            format={EDIT_DATE_FORMAT}
            disabled={locked}
            value={start ?? undefined}
            onChange={(event: FieldEvent) => handlers.current.start(event)}
          />
        </Row>
        <Row label="Last day on rent">
          <BryntumDateField
            cls="ti-field"
            ariaLabel="Last day on rent"
            dataset={{ testid: 'task-equipment-end' }}
            format={EDIT_DATE_FORMAT}
            disabled={locked}
            min={start ?? undefined}
            value={lastDay ?? undefined}
            onChange={(event: FieldEvent) => handlers.current.lastDay(event)}
          />
        </Row>
      </div>
      <dl className="ti-facts" data-testid="task-equipment-facts">
        <div>
          <dt>{rental.bookingId === null ? 'On site' : 'On rent'}</dt>
          <dd>{plural(days, 'day')}</dd>
        </div>
        {rental.rateMinor !== null && (
          <div>
            <dt>Cost</dt>
            <dd>{wholeMoney(rental.rateMinor * days, rental.currency)}</dd>
          </div>
        )}
        <div>
          <dt>The work</dt>
          <dd>{workDays}</dd>
        </div>
        {idleDays > 0 && (
          <div>
            <dt>{buffer ? 'Cover around the work' : 'No work planned'}</dt>
            <dd className={buffer ? undefined : 'is-warn'} data-testid="task-equipment-idle">
              {plural(idleDays, 'day')}: {idle.before} before, {idle.after} after
              {rental.rateMinor !== null && ` (${wholeMoney(rental.rateMinor * idleDays, rental.currency)})`}
            </dd>
          </div>
        )}
        {offDays > 0 && (
          <div>
            <dt>Days off inside the work</dt>
            <dd data-testid="task-equipment-off">
              {plural(offDays, 'day')}, still on rent
              {rental.rateMinor !== null && ` (${wholeMoney(rental.rateMinor * offDays, rental.currency)})`}
            </dd>
          </div>
        )}
      </dl>
      <p className={`field-hint${locked ? ' is-warn' : ''}`}>{rentalNote(rental)}</p>
      {booking && rentalPay && rental.rateMinor !== null && <PayRental standing={rentalStanding(workflow!, booking)} env={{ ...rentalPay, owner: balanceOwner(project) }} testId="task-equipment-pay" />}
    </>
  );
}
