/**
 * A private broadcast topic kept joined: the Realtime auth token is set before every join, and a
 * channel the server closed is joined again from scratch after a growing wait (Realtime only retries
 * errored channels by itself). Broadcasts sent while the channel was down are not replayed.
 */
import type { RevisionChannel, RevisionSupabaseClient } from '../sync/supabase-transport';

export type PrivateTopicClient = Pick<RevisionSupabaseClient, 'channel' | 'removeChannel' | 'realtime' | 'auth'>;

/** Delays before rejoining a channel the server closed; the last one repeats. */
const REJOIN_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;

export interface PrivateTopicOptions {
  /**
   * Adds the channel's listeners. `live()` is false once the channel was left or replaced: a replaced
   * channel may still deliver a last message, which is to be ignored.
   */
  listen(channel: RevisionChannel, live: () => boolean): void;
  /** Each status of the live channel; `rejoined` on the first SUBSCRIBED after a rejoin. */
  onStatus?(status: string, rejoined: boolean): void;
  /** Just before each rejoin. */
  onRejoin?(): void;
  /** Names the channel in warnings, e.g. "agent channel". */
  name: string;
  warn(message: string, error?: unknown): void;
  rejoinDelaysMs?: readonly number[];
}

/** Joins `topic` and keeps it joined; returns the function that leaves it (nothing is called after that). */
export function joinPrivateTopic(client: PrivateTopicClient, topic: string, options: PrivateTopicOptions): () => void {
  const { listen, onStatus, onRejoin, name, warn, rejoinDelaysMs = REJOIN_DELAYS_MS } = options;
  let active = true;
  let channel: RevisionChannel | null = null;
  let rejoins = 0;
  let rejoinTimer: ReturnType<typeof setTimeout> | null = null;

  const join = () => {
    const joined = client.channel(topic, { config: { private: true } });
    channel = joined;
    const live = () => active && joined === channel;
    listen(joined, live);
    void (async () => {
      try {
        const { data } = await client.auth.getSession();
        if (data.session?.access_token) await client.realtime.setAuth(data.session.access_token);
      } catch (error) {
        warn('realtime.setAuth failed', error);
      }
      if (!live()) return;
      joined.subscribe((state, error) => {
        if (!live()) return;
        if (error) warn(`${name} ${state}`, error);
        onStatus?.(state, state === 'SUBSCRIBED' && rejoins > 0);
        if (state === 'SUBSCRIBED') rejoins = 0;
        else if (state === 'CLOSED') scheduleRejoin();
      });
    })();
  };

  const scheduleRejoin = () => {
    if (rejoinTimer !== null || !active) return;
    const delay = rejoinDelaysMs[Math.min(rejoins, rejoinDelaysMs.length - 1)] ?? 10_000;
    rejoins++;
    const closed = channel;
    channel = null;
    if (closed) client.removeChannel(closed).catch(() => undefined);
    rejoinTimer = setTimeout(() => {
      rejoinTimer = null;
      if (!active) return;
      onRejoin?.();
      join();
    }, delay);
  };

  join();
  return () => {
    active = false;
    if (rejoinTimer !== null) clearTimeout(rejoinTimer);
    rejoinTimer = null;
    const current = channel;
    channel = null;
    if (current) client.removeChannel(current).catch((error: unknown) => warn('removeChannel failed', error));
  };
}
