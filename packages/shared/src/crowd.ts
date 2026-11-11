/**
 * The simulated people of the "busy workplace" demo (`pnpm crowd`): local-only accounts that sign in
 * like anyone else and work in a project as project managers without cost access. Their names say they
 * are simulated, and presence marks them with a robot badge.
 *
 * Self-contained (no imports): the Node launcher (scripts/crowd.ts) loads this file directly.
 */

export interface CrowdPerson {
  /** auth.users id. */
  id: string;
  email: string;
  /** The name a person would give. */
  name: string;
  /** `profiles.display_name`: the name with the simulated marker, as History and presence show it. */
  displayName: string;
  /** What they do on site. */
  title: string;
  /** `profiles.color`: never red, orange or pink; distinct from the demo PM and CM. */
  color: string;
}

/** Local-only password shared by every simulated account. */
export const CROWD_PASSWORD = 'demo-crowd-2026';

/** Appended to the display name, so a simulated person never passes for a real one. */
export const CROWD_NAME_MARK = '(sim)';

const person = (id: string, email: string, name: string, title: string, color: string): CrowdPerson => ({
  id,
  email,
  name,
  displayName: `${name} ${CROWD_NAME_MARK}`,
  title,
  color,
});

/** In launch order: `pnpm crowd --people 3` starts the first three. */
export const CROWD_PEOPLE: readonly CrowdPerson[] = [
  person('00000000-0000-4000-8000-0000000000c1', 'marcus@demo.local', 'Marcus Webb', 'Field engineer', '#0f766e'),
  person('00000000-0000-4000-8000-0000000000c2', 'lena@demo.local', 'Lena Ortiz', 'Scheduler', '#4338ca'),
  person('00000000-0000-4000-8000-0000000000c3', 'tom@demo.local', 'Tom Becker', 'MEP coordinator', '#0369a1'),
  person('00000000-0000-4000-8000-0000000000c4', 'aisha@demo.local', 'Aisha Khan', 'Cost estimator', '#15803d'),
  person('00000000-0000-4000-8000-0000000000c5', 'dan@demo.local', 'Dan Murphy', 'Foreman', '#7a6a00'),
  person('00000000-0000-4000-8000-0000000000c6', 'sofia@demo.local', 'Sofia Rossi', "Architect's site rep", '#475569'),
  person('00000000-0000-4000-8000-0000000000c7', 'kenji@demo.local', 'Kenji Sato', 'Structural engineer', '#6b5b4b'),
];

/** Membership every simulated person gets in the project they work in. */
export const CROWD_MEMBERSHIP = { role: 'pm', can_view_costs: false, approval_limit_minor: 0 } as const;

export function isCrowdUser(userId: string): boolean {
  return CROWD_PEOPLE.some((entry) => entry.id === userId);
}
