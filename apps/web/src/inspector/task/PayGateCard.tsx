/**
 * A payment gate in the task panel (gantt/pay-gates.ts): what it holds and what it pays for, what each trade partner
 * has earned to date on that work (% complete against the scheduled value, less retainage held until handover) and
 * what each is due, and paying it with PayPal Payouts.
 *
 * Review payment opens the payment window in the middle of the screen (payments/PayModal.tsx): every firm's line, the
 * total with PayPal's fee, the PayPal balance it comes from, what it releases, and, over the project's threshold, the
 * second person who approves it before Send payout unlocks; then PayPal's own statuses, step by step. Paying records
 * each task's share as paid and releases the held work. The day it is paid can be set later here too (the plan moves
 * for everyone); what that does to the handover is the odds' to say. People who may not see money see the dates and the
 * state, not the amounts.
 */
import type { TaskModel } from '@bryntum/gantt';
import type { ProgressPayment } from '@collab/shared';
import { useMemo, useState } from 'react';
import { heldWords, wholeMoney } from '../../gantt/look';
import { gateFor, heldBy, payOn, paymentOf, removePayGate, scheduledPayDay, type Gate } from '../../gantt/pay-gates';
import { openPayWindow } from '../../payments/PayModal';
import { Pill, plural, shortDay, usePanel, type Tone } from './ui';
import '../../styles/pay-gates.css';

const STATE: Record<Gate['payGate']['state'], { tone: Tone; words: string }> = {
  waiting: { tone: 'warn', words: 'Awaiting payment' },
  paying: { tone: 'busy', words: 'Processing' },
  paid: { tone: 'ok', words: 'Paid' },
  failed: { tone: 'alert', words: 'Payment failed' },
};

const TIME = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function PayGateCard({ task, dataVersion }: { task: TaskModel; dataVersion: unknown }) {
  const { project, currency, canViewCosts, run } = usePanel();
  const gate = gateFor(project, task);
  const [picking, setPicking] = useState(false);
  const payment: ProgressPayment | null = useMemo(() => (gate ? paymentOf(gate) : null), [gate, dataVersion]);

  if (!gate || !payment) return null;
  const amount = (minor: number) => wholeMoney(minor, currency);
  const state = STATE[gate.payGate.state];
  const holds = gate.holds.map((row) => row.name).join(', ');
  const later = scheduledPayDay(gate);
  const due = payment.dueMinor;
  const firms = payment.firms.filter((firm) => firm.earnedMinor > 0 || firm.dueMinor > 0);
  // The firms the payout pays, in the order it sends them (gantt/pay-gate-payment.ts).
  const payees = payment.firms.filter((firm) => firm.dueMinor > 0);
  // The payment window opens in the middle of the screen, page-wide (payments/PayModal.tsx), and stays while the panel moves on.
  const watchPayout = () => gate.payGate.batchId && openPayWindow(gate.id, { batchId: gate.payGate.batchId, sent: payees.map((firm) => ({ firm: firm.firm, amountMinor: firm.dueMinor })) });

  return (
    <section className={`card pay-gate-card is-${gate.payGate.state}`} data-testid="pay-gate-card">
      <header className="pay-gate-head">
        <span className="pay-gate-title">
          <i className="fa fa-money-check-dollar" aria-hidden="true" />
          Progress payment
        </span>
        <Pill tone={state.tone} icon={gate.payGate.state === 'paid' ? 'fa-brands fa-paypal' : undefined}>
          {state.words}
        </Pill>
      </header>
      <p className="pay-gate-lede" data-testid="pay-gate-lede">
        {gate.holding ? (
          <>
            <i className="fa fa-lock" aria-hidden="true" /> Holds <strong>{holds}</strong> until paid
          </>
        ) : (
          <>
            <i className="fa fa-lock-open" aria-hidden="true" /> <strong>{holds}</strong> released · paid with PayPal
          </>
        )}
      </p>

      {canViewCosts && gate.payGate.state !== 'paid' && (
        <div className="pay-gate-app" data-testid="pay-gate-app">
          <table className="pay-gate-table">
            <thead>
              <tr>
                <th scope="col">Trade partner</th>
                <th scope="col">% complete</th>
                <th scope="col">Earned to date</th>
                <th scope="col">Due now</th>
              </tr>
            </thead>
            <tbody>
              {firms.length === 0 ? (
                <tr>
                  <td colSpan={4} className="pay-gate-empty">
                    No work reported complete yet
                  </td>
                </tr>
              ) : (
                firms.map((firm) => (
                  <tr key={firm.firm} data-testid="pay-gate-firm">
                    <th scope="row">
                      {firm.firm}
                      <span className="pay-gate-for">{firm.items.map((item) => item.taskName).join(' · ')}</span>
                    </th>
                    <td>{Math.round(firm.percentDone)}%</td>
                    <td>{amount(firm.earnedMinor)}</td>
                    <td className="is-due">{amount(firm.dueMinor)}</td>
                  </tr>
                ))
              )}
            </tbody>
            {firms.length > 0 && (
              <tfoot>
                <tr>
                  <th scope="row">Total · {plural(firms.length, 'trade partner')}</th>
                  <td />
                  <td>{amount(payment.earnedMinor)}</td>
                  <td className="is-due">{amount(due)}</td>
                </tr>
              </tfoot>
            )}
          </table>
          {payment.earnedMinor > 0 && (
            <p className="pay-gate-note">
              Retainage {Math.round(payment.retainage * 100)}% · {amount(payment.retainedMinor)} held until handover
              {payment.paidBeforeMinor > 0 ? ` · Previously paid ${amount(payment.paidBeforeMinor)}` : ''}
            </p>
          )}
        </div>
      )}

      {gate.payGate.state === 'paid' && (
        <p className="pay-gate-paid" data-testid="pay-gate-paid">
          <img className="paypal-mark" src="/paypal/paypal-mark.svg" alt="" aria-hidden="true" />
          <span>
            {canViewCosts && gate.payGate.amountMinor !== null ? `Paid ${amount(gate.payGate.amountMinor)}` : 'Paid'}
            {gate.payGate.paidAt ? ` · ${TIME.format(new Date(gate.payGate.paidAt))}` : ''}
          </span>
          <span className="pay-gate-batch" data-testid="pay-gate-batch">
            {gate.payGate.batchId ? `PayPal ID ${gate.payGate.batchId}` : 'PayPal'}
          </span>
        </p>
      )}

      {gate.payGate.state === 'paying' && (
        <p className="pay-gate-paying" data-testid="pay-gate-paying">
          <i className="fa fa-circle-notch fa-spin" aria-hidden="true" /> Processing with PayPal · {plural(payees.length || 1, 'payment')}
          {canViewCosts && gate.payGate.batchId && (
            <button type="button" className="button is-link is-sm" onClick={watchPayout} data-testid="pay-gate-see">
              View payment
            </button>
          )}
        </p>
      )}

      {gate.payGate.state === 'failed' && gate.payGate.error && (
        <p className="note is-danger" data-testid="pay-gate-error">
          <i className="fa fa-triangle-exclamation" aria-hidden="true" />
          <span>{gate.payGate.error}</span>
        </p>
      )}

      <div className="pay-gate-actions">
        {canViewCosts && gate.payGate.state !== 'paid' && (
          <button
            type="button"
            className="button is-primary"
            disabled={gate.payGate.state === 'paying' || due <= 0}
            onClick={() => openPayWindow(gate.id)}
            data-testid="pay-gate-pay"
            title={due <= 0 ? 'No amount due yet' : `${amount(due)} to ${plural(payees.length, 'trade partner')} · through PayPal`}
          >
            Review payment
          </button>
        )}
        {gate.holding && (
          <span className="pay-gate-secondary">
            {later ? (
              <button type="button" className="button is-quiet is-sm" onClick={() => void run(() => payOn(project, gate.id, null))} data-testid="pay-gate-on-time">
                Scheduled {shortDay(later)} · Reset to due date
              </button>
            ) : picking ? (
              <input
                type="date"
                className="input is-sm"
                autoFocus
                aria-label="Payment date"
                onBlur={() => setPicking(false)}
                onChange={(event) => {
                  const [year, month, day] = event.target.value.split('-').map(Number);
                  if (!year || !month || !day) return;
                  setPicking(false);
                  void run(() => payOn(project, gate.id, new Date(year, month - 1, day)));
                }}
              />
            ) : (
              <button type="button" className="button is-quiet is-sm" onClick={() => setPicking(true)} data-testid="pay-gate-later">
                Schedule payment…
              </button>
            )}
            <button type="button" className="button is-quiet is-sm" onClick={() => void run(() => removePayGate(project, gate.id))} data-testid="pay-gate-remove">
              Remove hold
            </button>
          </span>
        )}
      </div>
    </section>
  );
}

/** On work a gate holds: what it waits for, in plain words, with a way to the payment. */
export function HeldNotice({ task }: { task: TaskModel }) {
  const { project, openTask } = usePanel();
  const gate = heldBy(project, task);
  if (!gate) return null;
  return (
    <p className="note is-warning pay-gate-held" data-testid="pay-gate-held">
      <i className="fa fa-lock" aria-hidden="true" />
      <span>
        {heldWords(gate)}.{' '}
        {openTask && typeof gate.id === 'number' && (
          <button type="button" className="button is-link is-sm" onClick={() => openTask(gate.id as number)}>
            View payment
          </button>
        )}
      </span>
    </p>
  );
}
