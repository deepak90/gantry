/**
 * What the hosted site counts, through the website's analytics (`track`): sessions started and invites opened (a link
 * or a code), teammate tabs opened, calls, the "Try these" items, invoices sent, rentals paid, sessions reset, waits
 * for a new session (a network's limits), and errors. A local build sends nothing. Props are plain strings, numbers
 * and flags, never a name or an email.
 */
import { track } from '../analytics';
import { HOSTED } from '../hosted';

export type ReportProps = Record<string, string | number | boolean>;

/** The events, by name. */
export type ReportEvent =
  | 'copy_claimed'
  | 'join_opened'
  | 'teammate_opened'
  | 'call_started'
  | 'call_ended'
  | 'try_item_done'
  | 'invoice_sent'
  | 'rental_paid'
  | 'copy_reset'
  | 'copy_wait'
  | 'error';

export type Reporter = (event: ReportEvent, props?: ReportProps) => void;

/** Counts one event on the hosted site. Analytics never breaks the page. */
export const report: Reporter = (event, props = {}) => {
  if (!HOSTED) return;
  try {
    track(event, props);
  } catch {
    // Not counted.
  }
};

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : typeof error === 'string' ? error : String(error));

/** An error, where it happened and its first words. */
export function reportError(where: string, error: unknown, send: Reporter = report): void {
  send('error', { where, message: messageOf(error).slice(0, 160) });
}
