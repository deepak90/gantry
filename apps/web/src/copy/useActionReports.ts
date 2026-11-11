/**
 * What the hosted site counts of a person's money moves: each invoice they sent (`invoice_sent`) and each rental they
 * paid (`rental_paid`), once, from the workflow as the database has it (the invoice's `sent_by`, the payment's
 * `authorized_by`), so only the tab of the person who did it counts it. What was already done when the workspace
 * opened is not counted again.
 */
import { useEffect, useRef } from 'react';
import type { WorkflowSnapshot } from '../workflow/api';
import { report, type ReportProps } from './report';

export interface ActionReport {
  /** Which record, so each is counted once. */
  id: string;
  event: 'invoice_sent' | 'rental_paid';
  props: ReportProps;
}

const amount = (minor: number) => Math.round(minor) / 100;

/** The invoices this person sent and the rentals they paid, as the snapshot has them. */
export function actionsBy(snapshot: WorkflowSnapshot, userId: string): ActionReport[] {
  const invoices = snapshot.invoices
    .filter((invoice) => (invoice.status === 'sent' || invoice.status === 'paid') && invoice.sent_by === userId)
    .map((invoice): ActionReport => ({ id: `invoice:${invoice.id}`, event: 'invoice_sent', props: { amount: amount(invoice.amount_minor), currency: invoice.currency } }));
  const payments = snapshot.payments
    .filter((payment) => payment.status === 'succeeded' && payment.authorized_by === userId)
    .map((payment): ActionReport => ({ id: `payment:${payment.id}`, event: 'rental_paid', props: { amount: amount(payment.amount_minor), currency: payment.currency } }));
  return [...invoices, ...payments];
}

/** Counts each new one (on the hosted site; `enabled` false counts nothing). */
export function useActionReports(enabled: boolean, snapshot: WorkflowSnapshot | null, userId: string, send = report): void {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!enabled || !snapshot) return;
    const actions = actionsBy(snapshot, userId);
    const known = seen.current;
    if (!known) {
      // The first look: what is there already was counted when it happened.
      seen.current = new Set(actions.map((action) => action.id));
      return;
    }
    for (const action of actions) {
      if (known.has(action.id)) continue;
      known.add(action.id);
      send(action.event, action.props);
    }
  }, [enabled, snapshot, userId, send]);
}
