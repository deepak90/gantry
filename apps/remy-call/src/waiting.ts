/**
 * Who Remy owes an answer on a call, which is what shows her as "thinking" (agent.ts #publishState).
 *
 * Each line addressed to her adds an entry, and an entry lapses on its own after PENDING_TTL_MS (config.ts). A turn of
 * hers can end without words, quiet or with a card alone, so counting one answer against one entry left an entry over
 * and showed her thinking for up to 45 seconds after she had answered. An answer to someone settles everything
 * they asked before it: a second question asked before the first answer comes shows her listening until its own line.
 */

/** Someone Remy owes an answer: who, when they finished speaking, and when the debt lapses. */
export interface Waiting {
  identity: string;
  at: number;
  expiresAt: number;
}

/** The entries left once a line goes out to `to`, and whom it answered: `to`, or else whoever has waited longest. */
export function afterAnswer(waiting: readonly Waiting[], to: string | undefined): { waiting: Waiting[]; answered: string | null } {
  if (to) return { waiting: waiting.filter((entry) => entry.identity !== to), answered: to };
  const [first, ...rest] = waiting;
  return { waiting: rest, answered: first?.identity ?? null };
}
