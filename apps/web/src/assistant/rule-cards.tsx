/**
 * The cards behind plain-English rules, drawn from the live plan rather than from what the model wrote:
 *
 * - RuleDraftCardView: what someone wrote, as blocks (when, what it watches, the conditions, what
 *   happens), with what it would find right now. Nothing is watched until Start watching.
 * - ReviewCardView: what a rule found about rented equipment, one row each, with Accept and Decline;
 *   accepting one fix can change the numbers of the next. Then the accepted rentals: Review payment opens the
 *   payout sheet, and Send payout pays each firm with PayPal Payouts.
 * - InvoicesCardView: what a rule prepared for finished work, one invoice per floor, sent with PayPal.
 */
import type { Gantt, ProjectModel } from '@bryntum/gantt';
import { addDays, conditionWords, describeAction, evaluateWatch, format, money, shortDay, type CurrencyCode, type InvoiceRow, type RuleDraftCard, type WatchCondition, type WatchPlan, type WatchRuleRow, type WatchSimpleCondition } from '@collab/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { WatchList } from '../alerts/useWatchList';
import { movedSince, showWasHere, spansOf } from '../library/was-here';
import { PayoutSheet } from '../payments/PayoutSheet';
import { balanceOwner, receiptTransactionId, rentalPaymentStatus, type PayoutLine } from '../payments/payout-sheet';
import { invoiceAction, prepareInvoice, projectClient, type WorkflowClient } from '../workflow/api';
import { receiptFor } from '../workflow/model';
import { paymentBefore, paymentSent } from '../workflow/rental';
import { applyRentalFix, undoRentalFix } from '../workflow/rental-fix';
import type { WorkflowController, WorkflowViewState } from '../workflow/controller';
import { rentalReview, type RentalFix, type RentalReview, type RentalRow } from '../workflow/review';
import { CardShell, type CardEnv } from './cards';
import '../styles/rule-cards.css';

export interface RuleCardEnv extends CardEnv {
  watch: WatchList;
  workflow: WorkflowViewState;
  controller: WorkflowController | null;
  client: WorkflowClient;
  projectId: string;
  project: ProjectModel;
  gantt(): Gantt | undefined;
  /** The conversation this card is in: what the rule finds is told there. */
  threadId: string | null;
  dataVersion: number;
  showTasks(ids: readonly number[]): void;
  /** What a choice on a card is about: a 3D view goes there if it is open, and the chart stays as it is. */
  followTasks?(ids: readonly number[]): void;
  openDocument(id: string): void;
  /** Where a card that can pay signs up, for a way to its payment from elsewhere: it answers whether it had one to open. */
  payOpeners?: Set<() => boolean>;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const usd = (minor: number, currency: CurrencyCode) => format(money(minor, currency)).replace(/\.00$/, '');

/** PayPal's own artwork (public/paypal). */
const PAYPAL_MARK = '/paypal/paypal-mark.svg';

/** A rental in a payout that was sent: its firm and amount as sent, and the payment showing before, which is not this one. */
interface SentRental {
  bookingId: string;
  firm: string;
  amountMinor: number;
  before: string | null;
}

/** The payout sheet on the card: closed, under review, or sent. */
type PaySheet = null | 'review' | { sent: SentRental[] };

/** The payment Send payout made for a rental, once it has gone to PayPal (a refusal before PayPal is not one). */
function freshPayment(review: RentalReview, entry: SentRental, failure: { code?: string | null } | null) {
  return paymentSent(review.rows.find((row) => row.booking.id === entry.bookingId)?.standing.payment ?? null, entry.before, failure);
}

// ---- the rule, in blocks ---------------------------------------------------------------------------

/** While the model is still writing, any field of the card may be missing, at any depth. */
function scopeWords(scope: Partial<RuleDraftCard['scope']> & { kind?: string; task_ids?: number[]; resource_ids?: number[]; from?: string; to?: string }, project: ProjectModel): string {
  switch (scope.kind) {
    case 'plan':
      return 'The whole plan';
    case 'tasks': {
      const names = (scope.task_ids ?? []).map((id) => (project.taskStore.getById(id) as { name?: string } | undefined)?.name ?? `Task ${id}`);
      return names.length <= 2 ? names.join(' and ') : `${names.length} tasks: ${names.slice(0, 2).join(', ')} and more`;
    }
    case 'dates':
      return `Work between ${scope.from ?? '…'} and ${scope.to ?? '…'}`;
    case 'crew':
      return (scope.resource_ids?.length ?? 1) === 1 ? 'A crew' : `${scope.resource_ids!.length} crews`;
    default:
      return '…';
  }
}

/** The conditions written so far, leaving out one still without a kind. */
function partsOf(condition: Partial<WatchCondition> | undefined): WatchSimpleCondition[] {
  if (!condition?.kind) return [];
  const parts = condition.kind === 'any' || condition.kind === 'all' ? ((condition as { of?: WatchSimpleCondition[] }).of ?? []) : [condition as WatchSimpleCondition];
  return parts.filter((part) => Boolean(part?.kind));
}

export function RuleDraftCardView({ card, env }: { card: Partial<RuleDraftCard>; env: RuleCardEnv }) {
  const [removed, setRemoved] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const parts = partsOf(card.condition);
  const kept = parts.filter((_, index) => !removed.has(index));
  const condition: WatchCondition | null = kept.length === 0 ? null : kept.length === 1 ? kept[0]! : { kind: card.condition?.kind === 'all' ? 'all' : 'any', of: kept as WatchSimpleCondition[] };
  const saved = env.watch.rules.find((rule) => rule.name === card.name) ?? null;
  const now = useMemo(() => {
    if (env.partial || !condition || !card.scope || !card.name || !card.trigger || !card.action) return null;
    return evaluateWatch([{ id: 'draft', name: card.name, scope: card.scope, condition, enabled: true }], env.watch.plan(), { canViewCosts: env.canViewCosts, currency: env.currency });
  }, [env.partial, env.dataVersion, condition === null ? '' : JSON.stringify(condition), card.scope, card.name]);

  return (
    <CardShell kind="rule" icon="bell" kicker={saved ? 'Watching' : 'A rule to watch'} env={env} testId="assistant-rule-draft">
      <h4 className="ac-title">{card.name ?? <span className="ac-skeleton" />}</h4>
      <dl className="rule-blocks">
        <div>
          <dt>When</dt>
          <dd>{card.trigger?.kind ? <span className="rule-block">{card.trigger.kind === 'change' ? 'The plan changes' : `Every day at ${card.trigger.at ?? '…'}`}</span> : <span className="ac-skeleton" />}</dd>
        </div>
        <div>
          <dt>Watch</dt>
          <dd>{card.scope?.kind ? <span className="rule-block">{scopeWords(card.scope, env.project)}</span> : <span className="ac-skeleton" />}</dd>
        </div>
        <div>
          <dt>If</dt>
          <dd className="rule-block-list">
            {parts.map((part, index) =>
              removed.has(index) ? null : (
                <span key={`${part.kind}:${index}`} className="rule-block-wrap">
                  {kept[0] !== part && <span className="rule-joiner">{card.condition?.kind === 'all' ? 'and' : 'or'}</span>}
                  <span className="rule-block is-condition" data-testid="rule-condition">
                    {conditionWords(part)}
                    {!saved && parts.length - removed.size > 1 && (
                      <button type="button" className="rule-block-remove" aria-label={`Leave out: ${conditionWords(part)}`} onClick={() => setRemoved((current) => new Set(current).add(index))}>
                        <i className="fa fa-xmark" aria-hidden="true" />
                      </button>
                    )}
                  </span>
                </span>
              ),
            )}
            {parts.length === 0 && <span className="ac-skeleton" />}
          </dd>
        </div>
        <div>
          <dt>Then</dt>
          <dd>{card.action?.kind ? <span className="rule-block">{describeAction(card.action)}</span> : <span className="ac-skeleton" />}</dd>
        </div>
      </dl>
      {Array.isArray(card.left_out) && card.left_out.length > 0 && (
        <p className="note is-sm rule-left-out" data-testid="rule-left-out">
          <i className="fa fa-circle-info" aria-hidden="true" /> I couldn’t turn this into a check: {card.left_out.join('; ')}
        </p>
      )}
      {!env.partial && !saved && now && (
        <p className={`rule-now${now.length > 0 ? ' is-found' : ''}`} data-testid="rule-now">
          {now.length === 0 ? 'Nothing to report right now.' : `Right now: ${plural(now.length, 'thing')} to look at.`}
        </p>
      )}
      {!env.partial && !saved && (
        <div className="ac-actions">
          <button
            type="button"
            className="button is-primary"
            disabled={busy || !condition || !env.active}
            data-testid="rule-start"
            onClick={() => {
              if (!card.name || !card.scope || !card.trigger || !card.action || !condition) return;
              setBusy(true);
              void env.watch
                .save({ id: null, name: card.name, scope: card.scope, condition, trigger: card.trigger, action: card.action, enabled: true, threadId: env.threadId })
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Starting…' : 'Start watching'}
          </button>
        </div>
      )}
      {saved && (
        <p className="pc-outcome is-saved" data-testid="rule-watching">
          <i className="fa fa-circle-check" aria-hidden="true" /> Watching. It checks every time the plan changes.
        </p>
      )}
    </CardShell>
  );
}

// ---- rentals to review -----------------------------------------------------------------------------

/** What a way of changing a rental comes to, in a few words. */
function fixWords(fix: RentalFix, currency: CurrencyCode): string {
  const span = `${shortDay(fix.start)} to ${shortDay(addDays(fix.end, -1))}`;
  const money = `${plural(fix.days, 'day')}, ${usd(fix.costMinor, currency)}`;
  const saving = fix.savingMinor > 0 ? `, saves ${usd(fix.savingMinor, currency)}` : fix.savingMinor < 0 ? `, ${usd(-fix.savingMinor, currency)} more` : '';
  return `${span}: ${money}${saving}`;
}

function ReviewRow({ row, env, busy, onAccept, onDecline, onUndo }: { row: RentalRow; env: RuleCardEnv; busy: boolean; onAccept(fix: RentalFix): void; onDecline(): void; onUndo(): void }) {
  const { standing } = row;
  const receipt = row.state === 'paid' && env.workflow.snapshot ? receiptFor(env.workflow.snapshot.documents, standing.payment?.id) : null;
  const icon = row.state === 'paid' ? 'circle-check' : row.state === 'accepted' ? 'circle-check' : row.state === 'declined' ? 'circle-minus' : row.problem === 'twice' ? 'clone' : 'hourglass-half';
  return (
    <li
      className={`review-row is-${row.state}`}
      data-testid="review-row"
      data-state={row.state}
      data-equipment={row.equipment}
      onClick={(event) => {
        // Anywhere on the row shows the rental's work; its buttons do their own thing.
        if (!(event.target as HTMLElement).closest('button, a')) env.showTasks(row.taskIds);
      }}
    >
      <i className={`fa fa-${icon} review-row-icon`} aria-hidden="true" />
      <div className="review-row-body">
        <p className="review-row-title">
          <button type="button" className="review-row-name" title="Show in the plan" onClick={() => env.showTasks(row.taskIds)}>
            {row.state === 'open' || row.state === 'declined' ? row.title : `${row.equipment}: fixed`}
          </button>
          {row.problem === 'idle' && row.state === 'open' && (
            // A new key replays the flash whenever the number changes.
            <span key={row.idleCostMinor} className="review-row-money" data-testid="review-idle-cost">
              {usd(row.idleCostMinor, env.currency)}
            </span>
          )}
        </p>
        {(row.state === 'open' || row.state === 'declined') && <p className="review-row-detail">{row.detail}</p>}
        {row.state === 'open' && row.fix && (
          <p className="review-row-detail" data-testid="review-suggestion">
            <strong>{row.fix.label}.</strong> {fixWords(row.fix, env.currency)}.
          </p>
        )}
        {row.state !== 'open' && row.state !== 'declined' && (
          <p className="review-row-detail">
            {row.equipment} on rent {shortDay(row.booking.billable_start)} to {shortDay(addDays(row.booking.billable_end, -1))}: {usd(standing.costMinor, env.currency)}
            {standing.savedMinor > 0 ? `, down from ${usd(standing.quotedCostMinor, env.currency)}` : ''}.
          </p>
        )}
        {row.state === 'open' && row.fix && (
          <div className="review-row-actions">
            <button
              type="button"
              className="button is-primary is-sm"
              disabled={busy || !env.active}
              onClick={() => {
                env.followTasks?.(row.taskIds);
                onAccept(row.fix!);
              }}
              data-testid="review-accept"
            >
              Accept
            </button>
            {row.alternative && (
              <button
                type="button"
                className="button is-sm"
                disabled={busy || !env.active}
                title={fixWords(row.alternative, env.currency)}
                onClick={() => {
                  env.followTasks?.(row.taskIds);
                  onAccept(row.alternative!);
                }}
                data-testid="review-alternative"
              >
                {row.alternative.label}
              </button>
            )}
            <button
              type="button"
              className="button is-sm"
              disabled={busy || !env.active}
              onClick={() => {
                env.followTasks?.(row.taskIds);
                onDecline();
              }}
              data-testid="review-decline"
            >
              Decline
            </button>
          </div>
        )}
        {row.state === 'accepted' && (
          <div className="review-row-actions">
            <button
              type="button"
              className="button is-link"
              disabled={busy || !env.active}
              onClick={() => {
                env.followTasks?.(row.taskIds);
                onUndo();
              }}
              data-testid="review-undo"
            >
              Undo
            </button>
          </div>
        )}
        {row.state === 'declined' && <p className="review-row-note">Declined. It stays as booked.</p>}
        {row.state === 'paying' && (
          <p className="review-row-note">
            <i className="fa fa-spinner fa-spin-pulse" aria-hidden="true" /> PayPal is processing…
          </p>
        )}
        {row.state === 'failed' && <p className="review-row-note is-error">{standing.payment?.message ?? 'PayPal could not make this payment.'}</p>}
        {row.state === 'paid' && (
          <p className="review-row-note is-paid">
            <img className="paypal-mark" src={PAYPAL_MARK} alt="" aria-hidden="true" /> Paid to {row.booking.supplier_name}
            {receipt && (
              <button type="button" className="button is-link" onClick={() => env.openDocument(receipt.id)} data-testid="review-receipt">
                Receipt
              </button>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

export function ReviewCardView({ ruleId, env }: { ruleId: string; env: RuleCardEnv }) {
  const [sheet, setSheet] = useState<PaySheet>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rule = env.watch.rules.find((candidate) => candidate.id === ruleId) ?? null;
  const snapshot = env.workflow.snapshot;
  const review = useMemo(
    () => (rule && snapshot ? rentalReview({ snapshot, project: env.project, rule, plan: env.watch.plan(), dismissals: env.watch.dismissals, currency: env.currency }) : null),
    [rule, snapshot, env.project, env.dataVersion, env.watch.dismissals, env.currency],
  );
  const payable = useRef(0);
  payable.current = review?.payable.length ?? 0;
  // A way to the payment from elsewhere (the site view) opens this card's payout sheet, for the person to review.
  useEffect(() => {
    const openers = env.payOpeners;
    if (!openers) return;
    const open = (): boolean => {
      if (payable.current === 0) return false;
      setSheet((current) => current ?? 'review');
      return true;
    };
    openers.add(open);
    return () => {
      openers.delete(open);
    };
  }, [env.payOpeners]);
  // Refused before any payment was made (nothing reached PayPal): back to the review, with the reason on the card.
  useEffect(() => {
    if (sheet === null || sheet === 'review' || !review) return;
    const reached = sheet.sent.some((entry) => freshPayment(review, entry, env.workflow.failure));
    if (!reached && env.workflow.busy === null && env.workflow.failure?.action === 'pay') setSheet('review');
  }, [sheet, review, env.workflow.busy, env.workflow.failure]);
  if (!rule) return <p className="ac-muted">That rule is gone.</p>;
  if (!review) return <p className="ac-muted">Reading the rentals…</p>;
  const busy = working !== null || env.workflow.busy !== null;
  const failure = error ?? env.workflow.failure?.message ?? null;

  // Each is an ordinary change to the plan, which the toolbar's Undo takes back as well.
  const change = async (row: RentalRow, edit: () => Promise<void>) => {
    setWorking(row.booking.id);
    setError(null);
    const before = spansOf(env.project);
    try {
      await edit();
      const moved = movedSince(env.project, before);
      const gantt = env.gantt();
      if (gantt && moved.length > 0) showWasHere(gantt, moved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  };

  const open = review.rows.filter((row) => row.state === 'open').length;
  const payTotal = review.payable.reduce((sum, row) => sum + row.standing.costMinor, 0);
  const paying = review.rows.some((row) => row.state === 'paying');

  // The payout sheet: the accepted rentals while under review; once sent, each as PayPal reports it.
  const sentRentals = sheet !== null && sheet !== 'review' ? sheet.sent : null;
  const fresh = sentRentals?.map((entry) => freshPayment(review, entry, env.workflow.failure)) ?? [];
  const sheetLines: PayoutLine[] = sentRentals
    ? sentRentals.map((entry, index) => {
        const payment = fresh[index] ?? null;
        const receipt = payment?.status === 'succeeded' ? receiptFor(snapshot?.documents, payment.id) : null;
        return {
          key: entry.bookingId,
          firm: entry.firm,
          amountMinor: payment?.amount_minor ?? entry.amountMinor,
          ...rentalPaymentStatus(payment),
          transactionId: receiptTransactionId(receipt?.text_content),
          unsent: !payment && env.workflow.busy !== 'pay',
        };
      })
    : review.payable.map((row) => ({ key: row.booking.id, firm: row.booking.supplier_name, amountMinor: row.standing.costMinor }));
  const allPaid = fresh.length > 0 && fresh.every((payment) => payment?.status === 'succeeded');
  const sheetPhase = sentRentals === null ? 'review' : fresh.some(Boolean) ? 'sent' : 'sending';
  const paidSummary = (
    <p className="review-summary is-paid" data-testid="review-paid">
      <img className="paypal-mark" src={PAYPAL_MARK} alt="" aria-hidden="true" /> Paid {usd(review.paidMinor, env.currency)} to {plural(review.paidCount, 'supplier')}
    </p>
  );

  return (
    <CardShell kind="review" icon="truck-ramp-box" kicker="Rented equipment to look at" env={env} testId="assistant-review">
      <ul className="review-rows">
        {review.rows.map((row) => (
          <ReviewRow
            key={row.booking.id}
            row={row}
            env={env}
            busy={busy}
            onAccept={(fix) => void change(row, () => applyRentalFix(env.project, row.booking, fix))}
            onDecline={() => {
              if (row.alert) void env.watch.dismiss(row.alert);
            }}
            onUndo={() => void change(row, () => undoRentalFix(env.project, row.booking))}
          />
        ))}
      </ul>
      {review.rows.length === 0 && <p className="ac-muted">Nothing is wrong with the rentals now.</p>}
      {(review.savedMinor !== 0 || review.handoverDays !== 0) && (
        <p className="review-summary" data-testid="review-summary">
          {review.savedMinor !== 0 && <span>{review.savedMinor > 0 ? `Saved ${usd(review.savedMinor, env.currency)}` : `${usd(-review.savedMinor, env.currency)} more on rent`}</span>}
          <span>{review.handoverDays === 0 ? 'Handover kept' : `Handover ${Math.abs(review.handoverDays)} days ${review.handoverDays > 0 ? 'later' : 'earlier'}`}</span>
        </p>
      )}
      {failure && <p className="pc-warning is-error">{failure}</p>}
      {review.payable.length > 0 && open === 0 && !paying && sheet === null && (
        <div className="review-pay">
          <span>
            {plural(review.payable.length, 'rental')} ready to pay · <strong>{usd(payTotal, env.currency)}</strong>
          </span>
          <button type="button" className="button is-primary" disabled={busy} onClick={() => setSheet('review')} data-testid="review-pay">
            Review payment
          </button>
        </div>
      )}
      {sheet !== null && (sentRentals !== null || review.payable.length > 0) && (
        <PayoutSheet
          lines={sheetLines}
          currency={env.currency}
          owner={balanceOwner(env.project)}
          phase={sheetPhase}
          batchIds={[...new Set(fresh.flatMap((payment) => (payment?.paypal_batch_id ? [payment.paypal_batch_id] : [])))]}
          reportedFeeMinor={allPaid && fresh.every((payment) => payment?.fee_minor !== null) ? fresh.reduce((sum, payment) => sum + (payment?.fee_minor ?? 0), 0) : null}
          disabled={busy}
          onSend={() => {
            setSheet({ sent: review.payable.map((row) => ({ bookingId: row.booking.id, firm: row.booking.supplier_name, amountMinor: row.standing.costMinor, before: paymentBefore(row.standing.payment) })) });
            void env.controller?.payRentals(review.payable.map((row) => row.booking));
          }}
          onClose={() => setSheet(null)}
          testId="review-pay"
          terms="Confirms the rental dates with each supplier · receipts filed to their tasks"
        >
          {allPaid && paidSummary}
        </PayoutSheet>
      )}
      {review.paidCount > 0 && !paying && review.payable.length === 0 && !(sheet !== null && allPaid) && paidSummary}
    </CardShell>
  );
}

// ---- invoices --------------------------------------------------------------------------------------

interface FinishedFloor {
  groupId: number;
  groupName: string;
  lines: { label: string; amount_minor: number }[];
  total: number;
}

function finishedFloors(rule: WatchRuleRow, plan: WatchPlan, currency: CurrencyCode): FinishedFloor[] {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  return evaluateWatch([rule], plan, { canViewCosts: true, currency }).flatMap((alert) => {
    const tasks = alert.taskIds.flatMap((id) => byId.get(id) ?? []);
    const groupId = tasks[0]?.parentId ?? null;
    if (groupId === null) return [];
    const lines = tasks.filter((task) => task.budgetMinor > 0).map((task) => ({ label: task.name, amount_minor: task.budgetMinor }));
    return [{ groupId, groupName: byId.get(groupId)?.name ?? 'This part of the plan', lines, total: lines.reduce((sum, line) => sum + line.amount_minor, 0) }];
  });
}

const POLL_MS = 20_000;

export function InvoicesCardView({ ruleId, env }: { ruleId: string; env: RuleCardEnv }) {
  const [clientName, setClientName] = useState<string | null>(null);
  const [working, setWorking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rule = env.watch.rules.find((candidate) => candidate.id === ruleId) ?? null;
  const invoices: readonly InvoiceRow[] = env.workflow.snapshot?.invoices ?? [];
  const floors = useMemo(() => (rule ? finishedFloors(rule, env.watch.plan(), env.currency) : []), [rule, env.dataVersion, env.currency]);
  const sent = invoices.filter((invoice) => invoice.status === 'sent');

  useEffect(() => {
    let alive = true;
    projectClient(env.client, env.projectId)
      .then((found) => alive && setClientName(found?.name ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [env.client, env.projectId]);

  // Whether the client has paid: asked of PayPal now and then while the card is the newest one.
  const sentKey = sent.map((invoice) => invoice.id).join();
  useEffect(() => {
    if (!sentKey || !env.active) return undefined;
    const timer = setInterval(() => {
      for (const id of sentKey.split(',')) void invoiceAction(env.client, id, 'refresh').catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [sentKey, env.active, env.client]);

  if (!rule) return <p className="ac-muted">That rule is gone.</p>;

  const send = async (floor: FinishedFloor) => {
    setWorking(floor.groupId);
    setError(null);
    try {
      const invoice = await prepareInvoice(env.client, { projectId: env.projectId, groupTaskId: floor.groupId, ruleId, title: `${floor.groupName}: finished work`, lines: floor.lines });
      await invoiceAction(env.client, invoice.id, 'send');
      await env.controller?.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await env.controller?.reload();
    } finally {
      setWorking(null);
    }
  };

  return (
    <CardShell kind="invoices" icon="file-invoice-dollar" kicker="Ready to bill" env={env} testId="assistant-invoices">
      {floors.length === 0 && invoices.length === 0 && <p className="ac-muted">Nothing is finished yet.</p>}
      <ul className="invoice-rows">
        {floors.map((floor) => {
          const invoice = invoices.find((candidate) => candidate.group_task_id === floor.groupId && candidate.status !== 'cancelled') ?? null;
          const status = invoice?.status ?? 'draft';
          return (
            <li key={floor.groupId} className={`invoice-row is-${status}`} data-testid="invoice-row" data-status={status} data-floor={floor.groupName}>
              <header>
                <strong>{floor.groupName}</strong>
                <span className="invoice-total">{usd(invoice?.amount_minor ?? floor.total, env.currency)}</span>
              </header>
              <ul className="invoice-lines">
                {floor.lines.map((line) => (
                  <li key={line.label}>
                    <span>{line.label}</span>
                    <span>{usd(line.amount_minor, env.currency)}</span>
                  </li>
                ))}
              </ul>
              <p className="invoice-to">To {invoice?.client_name ?? clientName ?? 'the client'}</p>
              {(status === 'draft' || status === 'failed') && (
                <div className="ac-actions">
                  <button type="button" className="button is-primary" disabled={working !== null || floor.total === 0} onClick={() => void send(floor)} data-testid="invoice-send">
                    <i className={`fa fa-${working === floor.groupId ? 'spinner fa-spin' : 'paper-plane'}`} aria-hidden="true" /> {working === floor.groupId ? 'Sending…' : 'Send invoice'}
                  </button>
                </div>
              )}
              {status === 'failed' && invoice?.message && <p className="pc-warning is-error">{invoice.message}</p>}
              {status === 'sent' && (
                <p className="review-row-note is-paid" data-testid="invoice-sent">
                  <img className="paypal-mark" src={PAYPAL_MARK} alt="" aria-hidden="true" /> Sent{invoice?.paypal_number ? ` · Invoice ${invoice.paypal_number}` : ''}
                  {invoice?.payer_url && (
                    <a className="button is-link" href={invoice.payer_url} target="_blank" rel="noreferrer" data-testid="invoice-view">
                      View in PayPal
                    </a>
                  )}
                </p>
              )}
              {status === 'paid' && (
                <p className="review-row-note is-paid" data-testid="invoice-paid">
                  <img className="paypal-mark" src={PAYPAL_MARK} alt="" aria-hidden="true" /> Paid by {invoice?.client_name}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="pc-warning is-error">{error}</p>}
    </CardShell>
  );
}
