/**
 * What a browser is told when something fails, and what only the log hears. A failure nobody planned for is a 500
 * with one plain sentence and a request id; its detail (a database message, which can name tables and functions) is
 * logged under that id. On the hosted site (GANTRY_HOSTED=1) a setup problem is plain too: its own message is for
 * whoever runs the functions (it names files and settings), so it goes to the log. On this machine it stays in the
 * answer, where it tells the developer what to fix.
 */
import { ConfigError, type Env } from './config.ts';
import { isHosted } from './hosted.ts';
import { HttpError, type Log } from './http.ts';
import { PayPalAuthError } from './paypal.ts';

/** A short random id for one failure: in the answer and in its log line. */
export function requestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const somethingWentWrong = (id: string): string =>
  `Something went wrong on our side. Try again in a moment, and if it keeps happening, mention request id ${id}.`;

/** A 500 for a failure nobody planned for: a plain sentence and an id; the failure itself goes to the log. */
export function internalError(error: unknown, log: Log | undefined): HttpError {
  const id = requestId();
  log?.(`unexpected failure, request id ${id}`, error);
  return new HttpError(500, 'INTERNAL_ERROR', somethingWentWrong(id), id);
}

/** What the hosted site says about each setup problem; nothing was sent to PayPal in any of them. */
const PLAIN_SETUP: Readonly<Record<ConfigError['code'] | PayPalAuthError['code'], string>> = {
  PAYPAL_NOT_CONFIGURED: 'Payments with PayPal aren’t set up on this site right now. Nothing was sent.',
  PAYPAL_AUTH_FAILED: 'PayPal didn’t accept this site’s sign-in just now. Nothing was sent; try again later.',
  PAYPAL_UNAVAILABLE: 'PayPal couldn’t be reached just now. Nothing was sent; try again in a moment.',
};

/** A 503 for PayPal settings that are missing or refused: plain on the hosted site, the full story on this machine. */
export function setupError(error: ConfigError | PayPalAuthError, env: Env, log: Log | undefined): HttpError {
  if (!isHosted(env)) return new HttpError(503, error.code, error.message);
  const id = requestId();
  log?.(`${error.code}, request id ${id}: ${error.message}`);
  return new HttpError(503, error.code, PLAIN_SETUP[error.code], id);
}

/** Every failure as the browser may see it: refusals as they are, setup problems by `setupError`, the rest by `internalError`. */
export function publicError(error: unknown, env: Env, log: Log | undefined): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ConfigError || error instanceof PayPalAuthError) return setupError(error, env, log);
  return internalError(error, log);
}
