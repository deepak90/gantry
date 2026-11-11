/**
 * The ways into someone's session, other than starting one:
 *
 * - the invite link, `/app?join=<token>`: whoever opens it joins the session (join_copy) in the next free seat, under
 *   a name from the list. The token is the session's own and stops working when the session is reset.
 * - the session code, 6 digits ("482 917"), typed on the welcome screen or the landing page, which sends
 *   `/app?code=482917` (join_copy_by_code). The code dies with the session too.
 * - a teammate in the next tab, `/app?join=<token>&as=teammate`: the same link, opened by this browser as a second
 *   person (supabase/client.ts keeps that tab's sign-in apart).
 */

/** What a join token may look like: letters, digits and URL-safe marks, nothing that needs escaping twice. */
const TOKEN = /^[A-Za-z0-9._~-]{4,200}$/;

/** The token in an address's query (`?join=`), or null. */
export function joinTokenOf(search: string): string | null {
  const token = new URLSearchParams(search).get('join')?.trim() ?? '';
  return TOKEN.test(token) ? token : null;
}

/** The link that joins this session, on this site. */
export function inviteLink(token: string, origin: string): string {
  const url = new URL('/app', origin);
  url.searchParams.set('join', token);
  return url.toString();
}

/** The same link, for a second person in a new tab of this browser. */
export function teammateLink(token: string, origin: string): string {
  const url = new URL(inviteLink(token, origin));
  url.searchParams.set('as', 'teammate');
  return url.toString();
}

/** A session code as typed: 6 digits, with any spaces or dashes between them; anything else is not one. */
export function parseSessionCode(input: string | null | undefined): string | null {
  const digits = (input ?? '').replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** A code as people read it out: "482 917". */
export function formatSessionCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** What someone has typed into a code field so far, shown the same way: digits only, at most six, "482 9". */
export function typedSessionCode(input: string): string {
  const digits = input.replace(/\D/g, '').slice(0, 6);
  return digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
}

/** The code in an address's query (`?code=`, as the landing page sends it), or null. */
export function sessionCodeOf(search: string): string | null {
  return parseSessionCode(new URLSearchParams(search).get('code'));
}

/** The address without the given query parameters: once an invite or a code is used, a reload doesn't use it again. */
export function withoutParams(href: string, names: readonly string[]): string {
  const url = new URL(href);
  for (const name of names) url.searchParams.delete(name);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The address without its `join=`. */
export const withoutJoin = (href: string): string => withoutParams(href, ['join']);
