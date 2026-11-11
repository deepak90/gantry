/**
 * Who hosts the call: the person who has been on it longest. Only the host's tab hands Remy her lines (`remy.say`); every
 * tab works the host out the same way (apps/web/src/call/view.ts `hostOf`), and so does the worker, which refuses a line
 * from anyone else. When the host leaves, the next longest takes over, everywhere at once.
 *
 * The people are those on the call who aren't Remy (the worker passes only people) and aren't a recording
 * participant (`recorder-…`); a hidden participant, such as an observer, is on nobody's call. Join times are the call server's, in
 * ms: one that isn't known goes last, then identities in order, so the tabs and the worker agree.
 */

export interface Joined {
  identity: string;
  /** When they joined, in ms since the epoch by the call server's clock; 0 when it isn't known. */
  joinedAt: number;
}

export const isRecorder = (identity: string): boolean => identity.startsWith('recorder-');

const byJoining = (a: Joined, b: Joined): number => (a.joinedAt || Infinity) - (b.joinedAt || Infinity) || a.identity.localeCompare(b.identity);

/** The host's identity; null when nobody is on the call. */
export function hostOf(people: readonly Joined[]): string | null {
  return people.filter((person) => !isRecorder(person.identity)).sort(byJoining)[0]?.identity ?? null;
}
