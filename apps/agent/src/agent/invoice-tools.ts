/**
 * The assistant's tool for billing a change to the plan (a change order) through PayPal Invoicing. It
 * drafts the invoice from the plan (plan/invoice.ts: the change's tasks at their own costs, grouped by
 * floor, billed to the project's client, Harbor's tenant) and keeps it by id for show_change_invoice.
 *
 * Nothing here sends anything, and the assistant cannot: a person who sees costs presses Send on the
 * card, under their own login, whatever their approval setting (prepare_invoice records the invoice on
 * the change's first task, then supabase/functions/paypal-invoice creates it in PayPal and sends it).
 */
import { PAYPAL_PAYMENT_LIMIT_MINOR, type ChangeInvoiceCard, type InvoiceRow } from '@collab/shared';
import { z } from 'zod';
import { lastDay, usd } from '../plan/format';
import { changeInvoice, changeTasks, ChangeInvoiceError } from '../plan/invoice';
import { ToolRefusal } from './refusal';
import type { ToolContext } from './tools';

/** A drafted invoice, kept by id for its card: the card's props exactly. */
export type DraftedInvoice = ChangeInvoiceCard;

export const InvoiceToolSchemas = {
  draft_change_invoice: z.object({
    change: z
      .string()
      .trim()
      .min(1)
      .max(90)
      .nullish()
      .describe('The change in a few words, as the people call it, e.g. "New light fixtures, levels 1 to 3"; omit to name it after the library piece and its floors'),
    task_ids: z
      .array(z.int().positive())
      .min(1)
      .max(60)
      .nullish()
      .describe('The tasks the change added (a group brings its tasks), ids from a tool result; omit for the library piece added to the plan most recently, on every floor it went'),
  }),
};
export type InvoiceToolName = keyof typeof InvoiceToolSchemas;

export const INVOICE_TOOL_DESCRIPTIONS: Record<InvoiceToolName, string> = {
  draft_change_invoice:
    'Draft the PayPal invoice for a change to the plan (a change order), billed to the project’s client (the tenant): a line for what is bought once for every floor, then one line per floor for its own work (its tasks listed under it), each at the plan’s own costs, with the total, the terms (net 30) and whether the tenant may pay it in parts (over $60,000, the most one PayPal payment carries). Says when the change already has an invoice and where it stands. Nothing is sent: it returns an invoice_id for show_change_invoice, and a person who sees costs presses Send.',
};

export const isInvoiceTool = (name: string): name is InvoiceToolName => name in InvoiceToolSchemas;

/** "$6,200" (no cents unless they matter). */
const dollars = (minor: number) => usd(minor).replace(/\.00$/, '');

/** An invoice already recorded on the change: one of its tasks carries it, and it was not canceled. */
function invoiceOn(invoices: readonly InvoiceRow[], taskIds: readonly number[]): InvoiceRow | null {
  const ids = new Set(taskIds);
  return [...invoices].filter((invoice) => invoice.status !== 'cancelled' && ids.has(invoice.group_task_id)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null;
}

/** Watch rules that also bill some of these tasks once they are finished: billing the change now would bill that work twice. */
function rulesBilling(ctx: ToolContext, taskIds: readonly number[]): string[] {
  const ids = new Set(taskIds);
  const covers = (scopeIds: readonly number[]) => {
    // A group in a rule's scope stands for everything under it.
    const covered = new Set(scopeIds);
    for (let grew = true; grew; ) {
      grew = false;
      for (const task of ctx.plan.tasks) if (task.parentId !== null && covered.has(task.parentId) && !covered.has(task.id)) covered.add(task.id), (grew = true);
    }
    return [...ids].some((id) => covered.has(id));
  };
  return ctx.watch.rules
    .filter((rule) => {
      if (!rule.enabled || rule.action.kind !== 'prepare_invoice') return false;
      switch (rule.scope.kind) {
        case 'plan':
          return true;
        case 'tasks':
          return covers(rule.scope.task_ids);
        case 'dates': {
          const { from, to } = rule.scope;
          return ctx.plan.tasks.some((task) => ids.has(task.id) && task.start <= to && lastDay(task.end) >= from);
        }
        case 'crew': {
          const crews = new Set(rule.scope.resource_ids);
          return ctx.plan.assignments.some((assignment) => ids.has(assignment.taskId) && crews.has(assignment.resourceId));
        }
      }
    })
    .map((rule) => rule.name);
}

export function runInvoiceTool(name: InvoiceToolName, rawArgs: unknown, ctx: ToolContext): unknown {
  const parsed = InvoiceToolSchemas[name].safeParse(rawArgs);
  if (!parsed.success) throw new ToolRefusal(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
  const { plan } = ctx;
  const recipient = plan.clientName?.trim();
  if (!recipient) throw new ToolRefusal('This project has nobody to bill: no client or tenant is on file for it.');
  let draft: ReturnType<typeof changeInvoice>;
  try {
    const change = changeTasks(plan, parsed.data.task_ids ?? null);
    const pieceName = change.libraryRef ? (ctx.library.snippets.find((snippet) => snippet.id === change.libraryRef)?.name ?? null) : null;
    draft = changeInvoice(plan, change, { name: parsed.data.change ?? null, pieceName, recipient });
  } catch (failure) {
    if (failure instanceof ChangeInvoiceError) throw new ToolRefusal(failure.message);
    throw failure;
  }
  // A change billed already keeps its invoice: the card follows that one, so nobody bills the change twice.
  const already = invoiceOn(ctx.workflow.invoices ?? [], draft.task_ids);
  const invoiceId = `invoice-${(ctx.invoices?.size ?? 0) + 1}`;
  const card: DraftedInvoice = { invoice_id: invoiceId, ...draft, ...(already ? { record_task_id: already.group_task_id } : {}) };
  (ctx.invoices ??= new Map()).set(invoiceId, card);
  return {
    invoice_id: invoiceId,
    change: card.change,
    to: card.recipient,
    lines: card.lines.map((line) => ({ label: line.label, amount_minor: line.amount_minor, text: dollars(line.amount_minor), tasks: line.task_ids.length })),
    total_minor: card.total_minor,
    payment_limit_minor: PAYPAL_PAYMENT_LIMIT_MINOR,
    text: {
      total: dollars(card.total_minor),
      terms: `net ${card.due_days}: due ${card.due_days} days after it is sent`,
      in_parts: card.partial_payments ? `over ${dollars(PAYPAL_PAYMENT_LIMIT_MINOR)}, the most one PayPal payment carries, so ${card.recipient} may pay it in parts` : null,
    },
    already_invoiced: already
      ? {
          status: already.status,
          number: already.paypal_number,
          total_minor: already.amount_minor,
          sent_on: already.sent_at?.slice(0, 10) ?? null,
          paid_on: already.paid_at?.slice(0, 10) ?? null,
        }
      : null,
    // Rules that bill this work again when it finishes ("bill the tenant when … finished").
    also_billed_when_finished: rulesBilling(ctx, card.task_ids),
    sent_by: 'a person who sees costs, pressing Send on the card; never you',
  };
}

/** One line for the logs and the progress stream. */
export function summarizeInvoiceTool(name: InvoiceToolName, value: Record<string, any>): string {
  switch (name) {
    case 'draft_change_invoice':
      return `${value.invoice_id}: ${value.lines?.length ?? 0} line(s), ${value.text?.total} to ${value.to}${value.already_invoiced ? ` (already ${value.already_invoiced.status})` : ''}`;
  }
}
