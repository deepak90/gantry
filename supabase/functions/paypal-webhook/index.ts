/**
 * paypal-webhook: PayPal's payout event deliveries (no JWT; `verify_jwt = false` in config.toml).
 * Verifies the signature, records each event once and applies its status; see _shared/webhook.ts.
 */
import { createWebhookHandler } from '../_shared/handlers.ts';
import { edgeDependencies } from '../_shared/supabase.ts';

Deno.serve(createWebhookHandler(edgeDependencies));
