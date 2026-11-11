/**
 * The browser side of paying for rentals in one project session. It keeps the workflow snapshot
 * fresh (database broadcasts on project:<id>:workflow, a re-read on reconnect and every 30 s), and
 * pays: it writes the record of what is approved for the dates as they stand, checks it on an
 * isolated copy of the live project, and sends and follows the PayPal payout. Every step re-reads
 * the snapshot afterwards; the database is the source of truth, this class only orchestrates.
 */
import type { ProjectModel } from '@bryntum/gantt';
import type { EquipmentBookingRow, ProposalVersionRow } from '@collab/shared';
import { captureProjectState, evaluateScenario, type EvaluationBooking, type ProjectState } from '../scenario/evaluate';
import { whenSaved } from '../scenario/publish';
import type { RevisionSync } from '../sync/revision-sync';
import {
  approveFix,
  authorizePayment,
  cancelProposal,
  createProposal,
  executePayout,
  loadWorkflow,
  reconcilePayout,
  recordEvaluation,
  WorkflowError,
  type PayoutResponse,
  type WorkflowClient,
  type WorkflowSnapshot,
} from './api';
import { paymentsInFlight, proposalForBooking } from './model';

export type WorkflowAction = 'pay' | 'refresh-payment';

export interface WorkflowViewState {
  status: 'loading' | 'ready' | 'error';
  snapshot: WorkflowSnapshot | null;
  loadError: string | null;
  /** The step in progress in this browser. */
  busy: WorkflowAction | null;
  /**
   * The last step that failed here, with the server's reason and its code (PAYEE_REFUSED, QUOTA_REACHED and
   * PAYMENTS_OFF say nothing reached PayPal), and the rentals it was paying, when it was paying some.
   */
  failure: { action: WorkflowAction; message: string; code?: string | null; bookingIds?: readonly string[] } | null;
  /** The outcome of the last step worth telling the user about. */
  notice: string | null;
}

/** The I/O the controller performs, injectable so tests drive it without a server or an engine. */
export interface WorkflowDeps {
  client: WorkflowClient;
  projectId: string;
  /** This browser's `sessions.id`: the executor identity for publications. */
  sessionId: string;
  project: ProjectModel;
  revisions: RevisionSync;
  handoverTaskId: number | null;
  /** Calls `onChange` for every workflow broadcast and after (re)subscribing; returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
  /** Defaults to the real engine adapter; tests substitute it. */
  capture?: (project: ProjectModel) => Promise<ProjectState>;
  evaluate?: typeof evaluateScenario;
  /** Payout status polling period while an operation is in flight (default 10 s; 0 disables). */
  pollMs?: number;
  /** Periodic re-read of the workflow (default 30 s; 0 disables). */
  refreshMs?: number;
}

const DEFAULT_POLL_MS = 10_000;
const DEFAULT_REFRESH_MS = 30_000;
/** Stop polling PayPal for an operation this old; the Refresh button still works. */
const POLL_WINDOW_MS = 15 * 60_000;
const CATCH_UP_TIMEOUT_MS = 10_000;

export class WorkflowController {
  private readonly deps: WorkflowDeps;
  private readonly listeners = new Set<() => void>();
  private current: WorkflowViewState = { status: 'loading', snapshot: null, loadError: null, busy: null, failure: null, notice: null };
  private unsubscribe: (() => void) | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private loading: Promise<void> | null = null;
  private reloadAgain = false;
  private polling = false;
  private disposed = false;

  constructor(deps: WorkflowDeps) {
    this.deps = deps;
  }

  get state(): WorkflowViewState {
    return this.current;
  }

  start(): void {
    this.unsubscribe = this.deps.subscribe(() => this.scheduleReload());
    const refreshMs = this.deps.refreshMs ?? DEFAULT_REFRESH_MS;
    if (refreshMs > 0) {
      this.refreshTimer = setInterval(() => void this.reload(), refreshMs);
    }
    void this.reload();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    clearInterval(this.refreshTimer);
    clearTimeout(this.pollTimer);
    clearTimeout(this.reloadTimer);
    this.listeners.clear();
  }

  dismissNotice(): void {
    this.set({ notice: null, failure: null });
  }

  /** Re-reads the workflow; concurrent calls share one read and trigger one more afterwards. */
  reload(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.loading) {
      this.reloadAgain = true;
      return this.loading;
    }
    this.loading = (async () => {
      do {
        this.reloadAgain = false;
        try {
          const snapshot = await loadWorkflow(this.deps.client, this.deps.projectId);
          if (this.disposed) {
            return;
          }
          this.set({ status: 'ready', snapshot, loadError: null });
          this.schedulePoll();
        } catch (error) {
          if (this.disposed) {
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          this.set(this.current.snapshot ? { loadError: message } : { status: 'error', loadError: message });
        }
      } while (this.reloadAgain && !this.disposed);
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  // ---- steps ------------------------------------------------------------------------------------

  /**
   * Pays rentals as they stand, one PayPal payout each, stopping at the first refusal. The dates are whatever the plan says
   * by now; the record of what is approved and paid is written for them here, each step enforced by the database as usual.
   */
  payRentals(bookings: readonly EquipmentBookingRow[]): Promise<void> {
    return this.run(
      'pay',
      async () => {
        await whenSaved(this.deps.project);
        await this.reload();
        for (const { id } of bookings) {
          const versionId = await this.versionForDates(id);
          const authorization = await authorizePayment(this.deps.client, versionId);
          await this.reload();
          await executePayout(this.deps.client, authorization.id);
        }
        return null;
      },
      bookings.map((booking) => booking.id),
    );
  }

  refreshPayment(authorizationId: string): Promise<void> {
    return this.run('refresh-payment', async () => {
      const result = await reconcilePayout(this.deps.client, authorizationId);
      return describePayout(result);
    });
  }

  // ---- internals --------------------------------------------------------------------------------

  private version(versionId: string): ProposalVersionRow {
    const version = this.current.snapshot?.versions.find((candidate) => candidate.id === versionId);
    if (!version) {
      throw new WorkflowError(`Proposal version ${versionId} is not loaded`, 'P0002');
    }
    return version;
  }

  private async evaluateVersion(versionId: string): Promise<void> {
    const { snapshot } = this.current;
    const version = this.version(versionId);
    const proposal = snapshot?.proposals.find((candidate) => candidate.id === version.proposal_id);
    const booking = snapshot?.bookings.find((candidate) => candidate.id === proposal?.booking_id);
    if (!booking) {
      throw new WorkflowError('The booking of this proposal is not loaded', 'P0002');
    }
    if (this.deps.handoverTaskId === null) {
      throw new WorkflowError('The project has no handover milestone to measure the schedule impact against', 'P0002');
    }
    const state = await this.caughtUpTo(version.source_revision);
    const evaluate = this.deps.evaluate ?? evaluateScenario;
    const evaluation = await evaluate({
      data: state.data,
      sourceRevision: state.revision,
      handoverTaskId: this.deps.handoverTaskId,
      booking: toEvaluationBooking(booking),
      inputs: version.inputs,
      assumptions: version.assumptions,
    });
    await recordEvaluation(this.deps.client, version.id, evaluation);
    await this.reload();
  }

  /** The project as of a confirmed revision at or after `revision`; catches up first when behind. */
  private async caughtUpTo(revision: number): Promise<ProjectState> {
    const capture = this.deps.capture ?? captureProjectState;
    const deadline = Date.now() + CATCH_UP_TIMEOUT_MS;
    for (;;) {
      await this.deps.revisions.whenApplied();
      const state = await capture(this.deps.project);
      if (state.revision >= revision) {
        return state;
      }
      if (Date.now() > deadline) {
        throw new WorkflowError(
          `This browser is at project revision ${state.revision} and has not received revision ${revision} yet; check the sync badge and try again`,
          'REVISION_BEHIND',
        );
      }
      this.deps.revisions.resync();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** The approved record of a rental at its current dates: the one already there if those are its dates, else a new one. */
  private async versionForDates(bookingId: string): Promise<string> {
    const booking = this.current.snapshot?.bookings.find((candidate) => candidate.id === bookingId);
    if (!booking) throw new WorkflowError('This rental is not loaded', 'P0002');
    const view = proposalForBooking(this.current.snapshot!, booking.id);
    const inputs = { new_start: booking.billable_start, new_end: booking.billable_end };
    if (view && view.isOpen && view.active.payment && view.current.inputs.new_start === inputs.new_start && view.current.inputs.new_end === inputs.new_end) return view.current.id;
    // An earlier record for other dates, never paid: these dates replace it.
    if (view?.isOpen && view.proposal.state !== 'published') await cancelProposal(this.deps.client, view.proposal.id, 'The rental dates changed');
    const created = await createProposal(this.deps.client, booking.id, inputs, []);
    await this.reload();
    await this.evaluateVersion(created.version_id);
    await approveFix(this.deps.client, created.version_id);
    await this.reload();
    return created.version_id;
  }

  private async run(action: WorkflowAction, step: () => Promise<string | null>, bookingIds?: readonly string[]): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.current.busy !== null) {
      this.set({ failure: { action, message: 'Another step is still running in this browser; wait for it to finish.' } });
      return;
    }
    this.set({ busy: action, failure: null, notice: null });
    try {
      const notice = await step();
      if (!this.disposed) {
        this.set({ notice });
      }
    } catch (error) {
      if (!this.disposed) {
        this.set({
          failure: {
            action,
            message: error instanceof Error ? error.message : String(error),
            code: error instanceof WorkflowError ? (error.code ?? null) : null,
            ...(bookingIds ? { bookingIds } : {}),
          },
        });
      }
    } finally {
      if (!this.disposed) {
        this.set({ busy: null });
        void this.reload();
      }
    }
  }

  private scheduleReload(): void {
    if (this.disposed || this.reloadTimer !== undefined) {
      return;
    }
    // Broadcasts arrive in bursts (one per row a step touched); read once per burst.
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.reload();
    }, 150);
  }

  /** While a payout is in flight, asks PayPal for its status every `pollMs`. */
  private schedulePoll(): void {
    const pollMs = this.deps.pollMs ?? DEFAULT_POLL_MS;
    if (pollMs <= 0 || this.pollTimer !== undefined || this.polling || this.disposed) {
      return;
    }
    const due = paymentsInFlight(this.current.snapshot ?? emptySnapshot()).filter(
      (payment) => Date.now() - Date.parse(payment.created_at) < POLL_WINDOW_MS,
    );
    if (due.length === 0) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      this.polling = true;
      void Promise.allSettled(due.map((payment) => reconcilePayout(this.deps.client, payment.id))).finally(() => {
        this.polling = false;
        void this.reload();
      });
    }, pollMs);
  }

  private set(patch: Partial<WorkflowViewState>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

export function toEvaluationBooking(booking: EquipmentBookingRow): EvaluationBooking {
  return {
    taskId: booking.task_id,
    resourceId: booking.resource_id,
    // What the rental is measured against: the dates as first quoted.
    billableStart: booking.quoted_start ?? booking.billable_start,
    billableEnd: booking.quoted_end ?? booking.billable_end,
    rentalRateMinor: booking.rental_rate_minor,
    currency: booking.currency,
  };
}

function describePayout(result: PayoutResponse): string {
  const { authorization } = result;
  if (result.notice) {
    return result.notice;
  }
  switch (authorization.status) {
    case 'succeeded':
      return 'Paid: PayPal confirmed the payment.';
    case 'failed':
      return `PayPal could not make the payment${authorization.message ? `: ${authorization.message}` : ''}.`;
    case 'pending':
    case 'submitted':
      return 'Payment sent to PayPal; waiting for PayPal to confirm.';
    case 'unknown':
      return `PayPal's answer did not arrive${authorization.message ? ` (${authorization.message})` : ''}; the status is checked again automatically.`;
    default:
      return 'Payment approved.';
  }
}

function emptySnapshot(): WorkflowSnapshot {
  return {
    bookings: [], proposals: [], versions: [], reviews: [], approvals: [], payments: [], publications: [], confirmations: [], profiles: [],
    members: [], documents: [], invoices: [],
  };
}
