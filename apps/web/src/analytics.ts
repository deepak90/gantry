/**
 * Visit counts and page speed for the hosted site: Vercel Web Analytics and Speed Insights. Both are cookieless
 * and keep no personal data; every page view and measurement is filed under its page's route alone (no query, no
 * hash, nothing after /app), so no visitor's copy or link ends up in them.
 *
 * They run only in the hosted build (VITE_GANTRY_HOSTED=1). In local dev and local builds nothing loads and
 * `track` does nothing.
 *
 *   startAnalytics('/app');                      // once, when the page starts
 *   track('Payment sent', { kind: 'rental' });   // a custom event: a name, and flat values only
 */
import { inject, track as sendEvent } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';

export type EventProps = Record<string, string | number | boolean | null>;

const enabled = import.meta.env.PROD && import.meta.env.VITE_GANTRY_HOSTED === '1';
/** Where Vercel's build says the scripts and intake live (site-pages.ts passes it through); empty: their defaults. */
const vercelConfig: string = import.meta.env.VERCEL_OBSERVABILITY_CLIENT_CONFIG ?? '';
let started = false;

/** Starts both, filing everything under `route` (such as '/', '/privacy' or '/app'). Safe to call twice. */
export function startAnalytics(route: string): void {
  if (!enabled || started) return;
  started = true;
  const atRoute = <Event extends { url: string }>(event: Event): Event => ({ ...event, url: new URL(route, event.url).href });
  inject({ mode: 'production', beforeSend: atRoute }, vercelConfig || undefined);
  injectSpeedInsights({ route, beforeSend: atRoute }, vercelConfig || undefined);
}

/** Counts a custom event (once `startAnalytics` has run). */
export function track(event: string, props?: EventProps): void {
  if (!enabled || !started) return;
  sendEvent(event, props);
}
