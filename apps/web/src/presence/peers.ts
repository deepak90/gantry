/**
 * Who is in the plan, read from the presence state, and who follows whom. Pure functions over
 * validated presence entries; the session decides what to do with the answers.
 */
import { peerSchema, type Peer } from './protocol';

/**
 * Presence state as Supabase delivers it: one key per tab (the session id), each with the metas
 * that tab tracked. A tab that re-tracks quickly can briefly carry two; the last one wins.
 */
export type PresenceState = Readonly<Record<string, readonly unknown[]>>;

/** Every valid tab in the state, one entry per session, oldest first. Malformed metas are skipped. */
export function peersFromPresence(state: PresenceState): Peer[] {
  const bySession = new Map<string, Peer>();
  for (const [key, metas] of Object.entries(state)) {
    for (let index = metas.length - 1; index >= 0; index--) {
      const parsed = peerSchema.safeParse(metas[index]);
      // The key is the session the channel tracked under: a meta naming another session is forged.
      if (parsed.success && parsed.data.session === key) {
        bySession.set(key, parsed.data);
        break;
      }
    }
  }
  return [...bySession.values()].sort(byArrival);
}

export function byArrival(a: Peer, b: Peer): number {
  return a.since - b.since || a.session.localeCompare(b.session);
}

/** Everyone but this tab. */
export function othersOf(peers: readonly Peer[], self: string): Peer[] {
  return peers.filter((peer) => peer.session !== self);
}

/** The tabs following `session` directly. */
export function followersOf(peers: readonly Peer[], session: string): Peer[] {
  return peers.filter((peer) => peer.following === session && peer.session !== session);
}

export type FollowRefusal = 'self' | 'absent' | 'loop';

/**
 * Whom to follow when this tab asks to follow `wanted`. Following someone who follows somebody
 * else means watching what they watch, so the chain is walked to the person actually driving the
 * view; a chain that comes back to this tab is refused (two people following each other would
 * mirror an unchanging view for ever).
 */
export function followTarget(peers: readonly Peer[], self: string, wanted: string): { target: Peer } | { refused: FollowRefusal } {
  if (wanted === self) return { refused: 'self' };
  const bySession = new Map(peers.map((peer) => [peer.session, peer]));
  let current = bySession.get(wanted);
  if (!current) return { refused: 'absent' };
  const seen = new Set<string>([current.session]);
  while (current.following) {
    if (current.following === self) return { refused: 'loop' };
    const next = bySession.get(current.following);
    // Following someone who has left: they are only looking at their own view now.
    if (!next || seen.has(next.session)) break;
    seen.add(next.session);
    current = next;
  }
  return { target: current };
}

/**
 * People's colors: cobalt, teal, plum, olive, indigo, slate. Never red, orange or pink (red means
 * danger in this app). Hex, because presence carries them to other browsers; all carry white text.
 */
const FALLBACK_COLORS = ['#2663c9', '#007e79', '#7d418a', '#5a7323', '#5644b4', '#46576c'] as const;

/** A steady color for somebody without a profile color. */
export function fallbackColor(userId: string): string {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length] ?? FALLBACK_COLORS[0];
}

/** The inverse or the ink text token, whichever reads better (WCAG contrast) on a person's color. */
export function readableInkOn(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 'var(--ink-inverse)';
  const channel = (offset: number) => {
    const value = parseInt(match[1]!.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  // Contrast with white is 1.05 / (L + 0.05); with --ink (L ≈ 0.009) it is (L + 0.05) / 0.059.
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.059 ? 'var(--ink-inverse)' : 'var(--ink)';
}

/** Two letters for an avatar: `Deepak Jayaram` → `DJ`. */
export function initialsOf(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('');
  return (letters.slice(0, 2) || '?').toUpperCase();
}
