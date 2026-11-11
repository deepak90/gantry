/**
 * paypal-invoice: sends a prepared invoice through PayPal Invoicing, asks where it stands, or cancels it.
 * POST { "invoice_id": uuid, "action": "send" | "refresh" | "cancel" } with the user's JWT → 200 { invoice, mode },
 * or { "project_id": uuid, "action": "seller" } → 200 { seller }. See _shared/invoices.ts.
 */
import { createInvoiceHandler } from '../_shared/invoices.ts';
import { accounts, edgeDependencies, invoiceStore, paymentLimits, rateGate, resolveUser } from '../_shared/supabase.ts';

Deno.serve(
  createInvoiceHandler({ env: edgeDependencies.env, fetch: edgeDependencies.fetch, store: invoiceStore, resolveUser, accounts, limits: paymentLimits, rateGate, log: edgeDependencies.log }),
);
