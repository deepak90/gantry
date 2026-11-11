/**
 * Who is in the plan, read from the presence state of `project:{id}:presence` (the agent listens and
 * never tracks itself). Mirrors apps/web/src/presence/peers.ts: one key per tab (the session id), the
 * last valid meta wins, and a meta that names another session than its key is ignored.
 */
import { z } from 'zod';
import { meetingReady, type PlanMember, type PlanSnapshot } from '../plan/snapshot';

export type PresenceState = Readonly<Record<string, readonly unknown[]>>;

const peerSchema = z.object({
  session: z.string().min(1),
  user: z.string().min(1).max(64),
  name: z.string().max(80),
  role: z.enum(['pm', 'cm']),
  since: z.number().int().nonnegative(),
  /** The call this tab hosts while Remy is on it, and the conversation it uses (null: the main thread). */
  call: z.object({ remy: z.boolean(), thread: z.string().nullable() }).optional(),
});
export type PresencePeer = z.infer<typeof peerSchema>;

export function peersFromPresence(state: PresenceState): PresencePeer[] {
  const bySession = new Map<string, PresencePeer>();
  for (const [key, metas] of Object.entries(state)) {
    for (let index = metas.length - 1; index >= 0; index--) {
      const parsed = peerSchema.safeParse(metas[index]);
      if (parsed.success && parsed.data.session === key) {
        bySession.set(key, parsed.data);
        break;
      }
    }
  }
  return [...bySession.values()].sort((a, b) => a.since - b.since || a.session.localeCompare(b.session));
}

/** The project members behind the tabs present (one entry per person, in order of arrival). */
export function presentMembers(plan: PlanSnapshot, peers: readonly PresencePeer[]): PlanMember[] {
  const seen = new Set<string>();
  const members: PlanMember[] = [];
  for (const peer of peers) {
    if (seen.has(peer.user)) continue;
    const member = plan.members.find((candidate) => candidate.userId === peer.user);
    if (member) {
      seen.add(peer.user);
      members.push(member);
    }
  }
  return members;
}

export type PresenceTrigger = { kind: 'meeting_started'; present: PlanMember[] } | { kind: 'person_joined'; member: PlanMember; present: PlanMember[] } | null;

/**
 * What a change in who is present means for the agent. `joined` are the people with a tab that was
 * not there before (a reload after `pnpm demo:reset` opens a new session, so it counts as joining).
 * The meeting starts when a second person arrives and someone present sees costs (meetingReady).
 */
export function presenceTrigger(before: readonly PlanMember[], after: PlanMember[], joined: readonly PlanMember[] = after.filter((member) => !before.some((other) => other.userId === member.userId))): PresenceTrigger {
  if (joined.length === 0) return null;
  if (meetingReady(after) && !meetingReady(before)) return { kind: 'meeting_started', present: after };
  return { kind: 'person_joined', member: joined[0]!, present: after };
}

/** The members behind tabs that were not present before (new sessions). */
export function joinedMembers(plan: PlanSnapshot, before: ReadonlySet<string>, peers: readonly PresencePeer[]): PlanMember[] {
  return presentMembers(plan, peers.filter((peer) => !before.has(peer.session)));
}
