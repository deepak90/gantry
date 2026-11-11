/**
 * The cost review's own history as changelog entries: a fix proposed, checked against the live plan,
 * corrected, approved, carried into the plan, the PayPal payment sent and confirmed, the supplier's
 * confirmation. Everything comes from the workflow snapshot the editor already loads (the same rows
 * for every member), so the entries are a pure function of it and can be recomputed on each reload.
 *
 * Money follows the editor's rule: amounts appear only for viewers who may see costs; everyone else
 * reads the same events without figures.
 */
import {
  format,
  money,
  type ApprovalRow,
  type CurrencyCode,
  type EquipmentBookingRow,
  type PaymentAuthorizationRow,
  type PaymentStatus,
  type ProposalRow,
  type ProposalVersionRow,
  type ReviewRow,
} from '@collab/shared';
import type { WorkflowSnapshot } from '../workflow/api';
import { INPUT_LABELS, describeInputValue } from '../workflow/model';
import { firstName, formatDay, formatFinish, plainExcerpt, plural } from './format';
import type { ActionData, ChangelogActor, ChangelogEntry, PropertyUpdateData, TextPart } from './model';

export interface WorkflowContext {
  canViewCosts: boolean;
  currency: CurrencyCode;
  /** The rented equipment's name (a project resource), e.g. "Crane". */
  resourceName(resourceId: number): string | null;
  /** Approved fixes already listed through the revision that carried them into the plan. */
  shownPublications?: ReadonlySet<string>;
}

const MASK = '•••';
/** Amounts people type into reasons and notes: `$300`, `$1,200.00`, `300 USD`. */
const MONEY_IN_TEXT = /(?:US)?[$€£]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|dollars?)\b/gi;

/** What the "sent" entry says about where the payment is now. */
export const PAYMENT_PROGRESS: Readonly<Record<PaymentStatus, string>> = {
  authorized: 'Waiting to be sent to PayPal',
  submitted: 'Sent to PayPal, waiting for PayPal to confirm',
  pending: 'PayPal is processing the payment',
  unknown: 'Checking with PayPal',
  succeeded: 'Paid',
  failed: 'PayPal could not make the payment',
};

const SCOPE_NOUNS = { schedule: 'schedule change', payment: 'payment' } as const;

function member(userId: string | null, via: 'human' | 'agent' = 'human'): ChangelogActor {
  return via === 'agent' ? { type: 'assistant', userId } : { type: 'member', userId };
}

function fact(property: string, after: string): PropertyUpdateData {
  return { property, after };
}

class WorkflowDescriber {
  private readonly names: Map<string, string>;

  constructor(
    private readonly snapshot: WorkflowSnapshot,
    private readonly ctx: WorkflowContext,
  ) {
    this.names = new Map(snapshot.profiles.map((profile) => [profile.user_id, profile.display_name]));
  }

  money(minor: number | null | undefined): string | null {
    return this.ctx.canViewCosts && typeof minor === 'number' && Number.isSafeInteger(minor) ? format(money(minor, this.ctx.currency)) : null;
  }

  masked(minor: number | null | undefined): string {
    return this.money(minor) ?? (this.ctx.canViewCosts ? '—' : MASK);
  }

  /** Free text (reasons, comments, PayPal's messages), with typed amounts hidden from viewers without costs. */
  text(value: string, max = 140): string {
    const excerpt = plainExcerpt(value, max);
    return this.ctx.canViewCosts ? excerpt : excerpt.replace(MONEY_IN_TEXT, MASK);
  }

  firstName(userId: string | null): string {
    const name = userId ? this.names.get(userId) : undefined;
    return name ? firstName(name) : 'Someone';
  }

  /** "Crane rental", linking to the booked activity. */
  rental(booking: EquipmentBookingRow): TextPart {
    const equipment = this.ctx.resourceName(booking.resource_id) ?? 'equipment';
    return { name: `${equipment} rental`, taskId: booking.task_id };
  }

  supplier(booking: EquipmentBookingRow): TextPart {
    return { name: booking.supplier_name };
  }

  inputFacts(version: ProposalVersionRow): PropertyUpdateData[] {
    return Object.entries(INPUT_LABELS).map(([field, label]) =>
      fact(label, describeInputValue((version.inputs as Record<string, unknown>)[field])),
    );
  }

  action(type: string, id: string, name: string, propertyUpdates: PropertyUpdateData[]): ActionData[] {
    return propertyUpdates.length > 0 ? [{ actionType: 'update', entity: { type, id, name }, propertyUpdates, isUser: true }] : [];
  }

  proposal(proposal: ProposalRow, booking: EquipmentBookingRow): ChangelogEntry[] {
    const entries: ChangelogEntry[] = [];
    const versions = this.snapshot.versions.filter((version) => version.proposal_id === proposal.id).sort((a, b) => a.version_no - b.version_no);
    const versionIds = new Set(versions.map((version) => version.id));
    const versionNo = new Map(versions.map((version) => [version.id, version.version_no]));
    const several = versions.length > 1;
    const rental = this.rental(booking);
    const supplier = this.supplier(booking);
    const base = { taskId: booking.task_id };

    const first = versions.find((version) => version.version_no === 1);
    if (first) {
      entries.push({
        ...base,
        id: `wf-proposal-${proposal.id}`,
        occurredAt: first.created_at,
        kind: 'fix',
        tone: first.created_via === 'agent' ? 'assistant' : 'neutral',
        icon: 'fa fa-lightbulb',
        actor: member(first.created_by, first.created_via),
        parts: ['proposed a fix for the ', rental],
        note: `New booking ${formatDay(first.inputs.new_start)} to ${formatFinish(first.inputs.new_end, first.inputs.new_start)}`,
        actions: this.action('Fix', first.id, 'The proposed fix', this.inputFacts(first)),
      });
    }

    for (const version of versions) {
      const { evaluation } = version;
      if (!evaluation) continue;
      const { handover } = evaluation.schedule_impact;
      const cost = evaluation.cost_comparison;
      const saving = cost.saving_minor;
      const moreDays = evaluation.booking_days.revised_billable_days - evaluation.booking_days.published_billable_days;
      const handoverText =
        handover.delta_days === 0
          ? 'handover date kept'
          : `handover ${plural(Math.abs(handover.delta_days), 'day')} ${handover.delta_days > 0 ? 'later' : 'earlier'}`;
      const savingText = this.money(Math.abs(saving));
      const parts: TextPart[] = [`${several ? `Fix version ${version.version_no}` : 'Fix'} checked against the plan: `];
      if (savingText) parts.push(saving >= 0 ? 'saves ' : 'costs ', { name: savingText }, saving >= 0 ? ', ' : ' more, ');
      parts.push(handoverText);
      const open = evaluation.unresolved_assumptions.length;
      const facts = [
        { property: 'Handover', before: formatDay(handover.published_end), after: formatDay(handover.proposed_end) },
        fact(moreDays > 0 ? 'Extra rental days' : 'Rental days saved', plural(Math.abs(moreDays), 'day')),
        fact('Rental as booked', this.masked(cost.booked_rental_minor)),
        fact('Paid to the supplier', this.masked(cost.supplier_payment_minor)),
        fact(saving >= 0 ? 'Saving' : 'Extra cost', this.masked(Math.abs(saving))),
      ];
      entries.push({
        ...base,
        id: `wf-check-${version.id}`,
        occurredAt: evaluation.evaluated_at,
        kind: 'fix',
        tone: handover.delta_days > 0 || saving < 0 ? 'warn' : 'ok',
        icon: 'fa fa-clipboard-check',
        actor: { type: 'system' },
        parts,
        ...(open > 0 ? { note: `${plural(open, 'question')} still open` } : {}),
        actions: this.action('Check', version.id, 'What the check found', facts),
      });
    }

    for (const review of this.snapshot.reviews.filter((candidate) => versionIds.has(candidate.proposal_version_id))) {
      entries.push(this.review(review, versionNo, base));
    }

    for (const approval of this.snapshot.approvals.filter((candidate) => versionIds.has(candidate.proposal_version_id))) {
      entries.push(...this.approval(approval, booking, several ? versionNo.get(approval.proposal_version_id) : undefined));
    }

    const shown = this.ctx.shownPublications ?? new Set<string>();
    for (const publication of this.snapshot.publications.filter((candidate) => versionIds.has(candidate.proposal_version_id))) {
      if (publication.status === 'published' && publication.published_at && !shown.has(publication.id)) {
        entries.push({
          ...base,
          id: `wf-pub-${publication.id}`,
          occurredAt: publication.published_at,
          kind: 'fix',
          tone: 'ok',
          icon: 'fa fa-circle-check',
          actor: member(publication.claimed_by),
          parts: ['applied the approved fix to the plan'],
          actions: [],
        });
      } else if (publication.status === 'failed') {
        entries.push({
          ...base,
          id: `wf-pub-${publication.id}-failed`,
          occurredAt: publication.claimed_at,
          kind: 'fix',
          tone: 'error',
          icon: 'fa fa-triangle-exclamation',
          actor: { type: 'system' },
          parts: ['Applying the fix to the plan did not work'],
          ...(publication.error ? { note: this.text(publication.error) } : {}),
          actions: [],
        });
      }
    }

    for (const payment of this.snapshot.payments.filter((candidate) => versionIds.has(candidate.proposal_version_id))) {
      entries.push(...this.payment(payment, booking, supplier));
    }

    const confirmation = this.snapshot.confirmations.find((candidate) => candidate.proposal_id === proposal.id);
    if (confirmation?.status === 'confirmed' && confirmation.confirmed_at) {
      entries.push({
        ...base,
        id: `wf-supplier-${proposal.id}`,
        occurredAt: confirmation.confirmed_at,
        kind: 'fix',
        tone: 'ok',
        icon: 'fa fa-handshake',
        actor: member(confirmation.confirmed_by),
        parts: ['recorded that ', supplier, ' confirmed the new dates'],
        ...(confirmation.note ? { note: this.text(confirmation.note) } : {}),
        actions: [],
      });
    }

    if (proposal.state === 'cancelled') {
      entries.push({
        ...base,
        id: `wf-proposal-${proposal.id}-dropped`,
        occurredAt: proposal.updated_at,
        kind: 'fix',
        tone: 'neutral',
        icon: 'fa fa-ban',
        actor: { type: 'system' },
        parts: ['The fix for the ', rental, ' was dropped'],
        actions: [],
      });
    }
    return entries;
  }

  review(review: ReviewRow, versionNo: ReadonlyMap<string, number>, base: { taskId: number }): ChangelogEntry {
    const payload = review.payload as {
      changes?: Record<string, { from: unknown; to: unknown }>;
      reason?: string;
      text?: string;
      next_version_no?: number;
      created_via?: 'human' | 'agent';
    };
    if (review.kind === 'comment') {
      return {
        ...base,
        id: `wf-review-${review.id}`,
        occurredAt: review.created_at,
        kind: 'fix',
        tone: 'neutral',
        icon: 'fa fa-comment',
        actor: member(review.reviewer_id),
        parts: [`commented: “${this.text(payload.text ?? '', 120)}”`],
        actions: [],
      };
    }
    const updates = Object.entries(payload.changes ?? {}).map(([field, change]) => ({
      property: INPUT_LABELS[field] ?? field,
      before: describeInputValue(change.from),
      after: describeInputValue(change.to),
    }));
    const next = payload.next_version_no ?? (versionNo.get(review.proposal_version_id) ?? 0) + 1;
    return {
      ...base,
      id: `wf-review-${review.id}`,
      occurredAt: review.created_at,
      kind: 'fix',
      tone: payload.created_via === 'agent' ? 'assistant' : 'neutral',
      icon: 'fa fa-pen-ruler',
      actor: member(review.reviewer_id, payload.created_via),
      parts: [updates.length > 0 ? 'changed the fix' : 'answered the open questions on the fix', ` (version ${next})`],
      ...(payload.reason ? { note: this.text(payload.reason) } : {}),
      actions: this.action('Fix', review.id, `Fix version ${next}`, updates),
    };
  }

  approval(approval: ApprovalRow, booking: EquipmentBookingRow, version: number | undefined): ChangelogEntry[] {
    const scope = SCOPE_NOUNS[approval.scope];
    const versionNote = version !== undefined ? `For version ${version} of the fix` : undefined;
    const amount = approval.scope === 'payment' ? this.money(approval.amount_minor) : null;
    const parts: TextPart[] =
      approval.scope === 'schedule'
        ? ['approved the schedule change']
        : amount
          ? ['approved paying ', { name: amount }, ' to ', this.supplier(booking)]
          : ['approved the payment to ', this.supplier(booking)];
    const entries: ChangelogEntry[] = [
      {
        id: `wf-approval-${approval.id}`,
        occurredAt: approval.created_at,
        kind: approval.scope === 'payment' ? 'payment' : 'fix',
        tone: 'ok',
        icon: 'fa fa-thumbs-up',
        actor: member(approval.approver_id),
        parts,
        taskId: booking.task_id,
        ...(versionNote ? { note: versionNote } : {}),
        actions: [],
      },
    ];
    if (approval.status === 'invalidated' && approval.invalidated_at) {
      entries.push({
        id: `wf-approval-${approval.id}-void`,
        occurredAt: approval.invalidated_at,
        kind: approval.scope === 'payment' ? 'payment' : 'fix',
        tone: 'warn',
        icon: 'fa fa-rotate-left',
        actor: { type: 'system' },
        parts: [`${this.firstName(approval.approver_id)}’s approval of the ${scope} no longer counts`],
        taskId: booking.task_id,
        ...(approval.invalidated_reason ? { note: this.text(approval.invalidated_reason) } : {}),
        actions: [],
      });
    }
    return entries;
  }

  payment(payment: PaymentAuthorizationRow, booking: EquipmentBookingRow, supplier: TextPart): ChangelogEntry[] {
    const amount = this.money(payment.amount_minor);
    const fee = this.money(payment.fee_minor);
    const facts = [
      fact('Amount', this.masked(payment.amount_minor)),
      fact('Paid to', booking.supplier_name),
      fact('Status', PAYMENT_PROGRESS[payment.status]),
      ...(payment.paypal_batch_id ? [fact('PayPal reference', payment.paypal_batch_id)] : []),
    ];
    const base = { kind: 'payment' as const, taskId: booking.task_id };
    const entries: ChangelogEntry[] = [
      {
        ...base,
        id: `wf-pay-${payment.id}`,
        occurredAt: payment.created_at,
        tone: 'paypal',
        icon: 'fa-brands fa-paypal',
        actor: member(payment.authorized_by),
        parts: amount ? ['sent ', { name: amount }, ' to ', supplier, ' with PayPal'] : ['sent the payment to ', supplier, ' with PayPal'],
        note: PAYMENT_PROGRESS[payment.status],
        actions: this.action('Payment', payment.id, 'PayPal payment', facts),
      },
    ];
    const settledAt = payment.last_checked_at ?? payment.updated_at;
    if (payment.status === 'succeeded') {
      entries.push({
        ...base,
        id: `wf-pay-${payment.id}-paid`,
        occurredAt: settledAt,
        tone: 'paypal',
        icon: 'fa fa-circle-check',
        actor: { type: 'paypal' },
        parts: amount
          ? ['confirmed ', { name: amount }, ' paid to ', supplier, fee ? ` (PayPal fee ${fee})` : '']
          : ['confirmed the payment to ', supplier],
        actions: this.action('Payment', payment.id, 'PayPal payment', [
          fact('Amount', this.masked(payment.amount_minor)),
          ...(payment.fee_minor !== null ? [fact('PayPal fee', this.masked(payment.fee_minor))] : []),
          ...(payment.paypal_batch_id ? [fact('PayPal reference', payment.paypal_batch_id)] : []),
        ]),
      });
    } else if (payment.status === 'failed') {
      entries.push({
        ...base,
        id: `wf-pay-${payment.id}-failed`,
        occurredAt: settledAt,
        tone: 'error',
        icon: 'fa fa-triangle-exclamation',
        actor: { type: 'paypal' },
        parts: ['could not make the payment to ', supplier],
        ...(payment.message ? { note: this.text(payment.message) } : {}),
        actions: [],
      });
    }
    return entries;
  }
}

/** Every workflow event of the project, in no particular order (the grid sorts by time). */
export function workflowEntries(snapshot: WorkflowSnapshot, ctx: WorkflowContext): ChangelogEntry[] {
  const describer = new WorkflowDescriber(snapshot, ctx);
  const entries: ChangelogEntry[] = [];
  for (const proposal of snapshot.proposals) {
    const booking = snapshot.bookings.find((candidate) => candidate.id === proposal.booking_id);
    if (booking) entries.push(...describer.proposal(proposal, booking));
  }
  return entries;
}
