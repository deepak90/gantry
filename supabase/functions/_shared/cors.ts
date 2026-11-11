/**
 * Which browser pages may call the functions (`supabase.functions.invoke` and the page's own fetch): the hosted site,
 * and, off the hosted project, the dev servers on this machine. A request from any other origin is still answered, but
 * without `Access-Control-Allow-Origin`, so the browser keeps the answer from that page. The functions take a bearer
 * token, not a cookie, so this is a second fence, not the first.
 *
 *   GANTRY_SITE_ORIGIN  the site's origin, when it moves (https://gantry-pearl.vercel.app unless set)
 *   GANTRY_HOSTED=1     the hosted project: the site's origin only
 */
import type { Env } from './config.ts';
import { isHosted } from './hosted.ts';

/** The hosted site. */
export const SITE_ORIGIN = 'https://gantry-pearl.vercel.app';

/** A dev server on this machine, on any port: Vite's, the e2e runs', a second checkout's. */
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/;

/** The headers supabase-js sends (its `@supabase/supabase-js/cors` list, plus functions-js's x-region). */
const ALLOWED_HEADERS = 'authorization, x-client-info, apikey, content-type, x-region, x-retry-count, traceparent, tracestate, baggage';

/** The origin to name in `Access-Control-Allow-Origin`, or null when this one may not read the answer. */
export function allowedOrigin(origin: string | null, env: Env): string | null {
  if (!origin) return null;
  const site = env.get('GANTRY_SITE_ORIGIN')?.trim().replace(/\/$/, '') || SITE_ORIGIN;
  if (origin === site) return origin;
  return !isHosted(env) && LOCAL_ORIGIN.test(origin) ? origin : null;
}

/** The CORS headers for an answer to this request, the preflight's included. */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = allowedOrigin(request.headers.get('origin'), env);
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    // The answer depends on the asking page, so a cache must not hand one page's answer to another.
    Vary: 'Origin',
  };
}
