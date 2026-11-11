/**
 * The rentals on a project, in one list: which machine, for which work, on which dates, what those come to, and whether
 * it is paid. The dates are changed on the task, or by asking the assistant; here is where they are read and paid.
 */
import type { ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { addDays, format, money, shortDay, type CurrencyCode } from '@collab/shared';
import { useMemo } from 'react';
import type { WorkflowController, WorkflowViewState } from '../workflow/controller';
import { rentalStanding } from '../workflow/rental';
import { balanceOwner } from '../payments/payout-sheet';
import { PayRental } from './PayRental';
import { Note } from './ui';
import '../styles/editor.css';

export interface RentalsPanelProps {
  controller: WorkflowController | null;
  state: WorkflowViewState;
  currency: CurrencyCode;
  canViewCosts: boolean;
  project: ProjectModel;
  /** Moves whenever the plan changes. */
  dataVersion: number;
  selectedTaskId: number | null;
  onOpenTask(taskId: number): void;
  onOpenDocument?: (documentId: string) => void;
}

export function RentalsPanel({ controller, state, currency, canViewCosts, project, dataVersion, selectedTaskId, onOpenTask, onOpenDocument }: RentalsPanelProps) {
  const { snapshot } = state;
  const amount = (minor: number) => format(money(minor, currency));
  const rows = useMemo(
    () =>
      (snapshot?.bookings ?? [])
        .map((booking) => ({
          standing: rentalStanding(snapshot!, booking),
          machine: (project.resourceStore.getById(booking.resource_id) as ResourceModel | undefined)?.name ?? 'Machine',
          task: (project.taskStore.getById(booking.task_id) as TaskModel | undefined)?.name ?? `Task ${booking.task_id}`,
        }))
        .sort((a, b) => a.standing.booking.billable_start.localeCompare(b.standing.booking.billable_start)),
    [snapshot, project, dataVersion],
  );
  if (!controller || state.status === 'loading') {
    return (
      <aside className="context-panel" data-testid="rentals-panel" aria-busy="true">
        <p className="empty-state">Loading…</p>
      </aside>
    );
  }
  if (!snapshot) {
    return (
      <aside className="context-panel" data-testid="rentals-panel">
        <Note tone="error">Could not load the rentals: {state.loadError}</Note>
        <button type="button" className="button editor-retry" onClick={() => void controller.reload()}>
          Try again
        </button>
      </aside>
    );
  }
  const env = { controller, state, currency, onOpenDocument, owner: balanceOwner(project) };
  return (
    <aside className="context-panel" data-testid="rentals-panel" aria-label="Rentals">
      <header className="panel-head context-panel-header">
        <div className="panel-head-text">
          <p className="panel-head-sub context-panel-kicker">
            <i className="fa fa-weight-hanging" aria-hidden="true" /> Rented equipment
          </p>
          <h2 className="panel-head-title">What are we paying for?</h2>
        </div>
      </header>
      {state.failure && (
        <div className="note is-danger editor-banner" role="alert" data-testid="workflow-error">
          <i className="fa fa-circle-exclamation" aria-hidden="true" />
          <span>{state.failure.message}</span>
          <button type="button" className="button is-link" onClick={() => controller.dismissNotice()}>
            Dismiss
          </button>
        </div>
      )}
      <div className="context-panel-body">
        {rows.length === 0 && <p className="empty-state">Nothing is rented for this project.</p>}
        <ul className="rentals-list" data-testid="rentals-list">
          {rows.map(({ standing, machine, task }) => {
            const { booking } = standing;
            return (
              <li key={booking.id} className={`card rentals-row${booking.task_id === selectedTaskId ? ' is-selected' : ''}`} data-testid="rentals-row" data-equipment={machine}>
                <button type="button" className="rentals-row-head" title="Show this task" onClick={() => onOpenTask(booking.task_id)}>
                  <strong>{machine}</strong>
                  <span className="editor-muted"> · {task}</span>
                </button>
                <p className="rentals-row-facts">
                  {shortDay(booking.billable_start)} to {shortDay(addDays(booking.billable_end, -1))} · {booking.supplier_name}
                </p>
                {canViewCosts && standing.changed && standing.savedMinor !== 0 && (
                  <p className="rentals-row-saved" data-testid="rentals-row-saved">
                    {standing.savedMinor > 0 ? `${amount(standing.savedMinor)} less than quoted` : `${amount(-standing.savedMinor)} more than quoted`}
                  </p>
                )}
                {canViewCosts && <PayRental standing={standing} env={env} />}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
