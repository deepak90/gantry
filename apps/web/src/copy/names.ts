/**
 * The names people take in a session on the hosted site: 30 easy-to-say first and last names, none a famous person's
 * and none a joke, since Remy says them aloud. Nobody types a name; the welcome screen suggests one nobody in the
 * session has, and "Another name" goes through the others.
 *
 * The database holds the same list (`copy_seat_names()` in supabase/migrations/20261111010000_session_codes_and_names.sql)
 * and has the last word: a name that is taken or not on the list gets a free one there. A test keeps the two the same.
 */

export const SEAT_NAMES: readonly string[] = [
  'Riley Brooks',
  'Jordan Ellis',
  'Avery Patel',
  'Morgan Reyes',
  'Casey Nguyen',
  'Taylor Brennan',
  'Quinn Delgado',
  'Rowan Hughes',
  'Parker Dunn',
  'Emerson Cole',
  'Jamie Holt',
  'Cameron Shaw',
  'Drew Okafor',
  'Sage Whitaker',
  'Kendall Price',
  'Reese Carter',
  'Alex Whitfield',
  'Jesse Navarro',
  'Elliot Kim',
  'Finley Ward',
  'Peyton Garcia',
  'Skyler Hart',
  'Dakota Lin',
  'Blake Mensah',
  'Charlie Lane',
  'Kai Larsen',
  'Harper Nolan',
  'Rory Castillo',
  'Devon Park',
  'Sasha Moreau',
];

/**
 * The names to suggest, in the order "Another name" shows them: the free ones (none of `taken`), shuffled. `random`
 * returns a number in [0, 1), as Math.random does.
 */
export function nameSuggestions(taken: readonly string[] = [], random: () => number = Math.random): string[] {
  const free = SEAT_NAMES.filter((name) => !taken.includes(name));
  // Fisher–Yates.
  for (let i = free.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [free[i], free[j]] = [free[j]!, free[i]!];
  }
  return free;
}

/** The title that goes with a seat: whoever starts the session is its `cm` member, who pays; whoever joins is `pm`. */
export const seatTitle = (starting: boolean): string => (starting ? 'construction manager' : 'project manager');
