/**
 * The other people's pointers: the latest position of each, in the order each sender sent them,
 * forgotten when they leave the plan, go quiet for `CURSOR_TTL_MS` or close the tab.
 */
import { CURSOR_TTL_MS, type CursorMessage, type CursorPoint } from './protocol';

export interface RemoteCursor {
  session: string;
  point: CursorPoint;
  seq: number;
  /** When it arrived, on the receiver's clock. */
  at: number;
  /** When it was sent, on the sender's clock (absent from older senders). */
  t?: number;
}

export class RemoteCursors {
  private readonly entries = new Map<string, RemoteCursor>();
  /** Highest seq seen per sender, kept after a pointer leaves so a late older move cannot bring it back. */
  private readonly lastSeq = new Map<string, number>();

  /** Takes one message; true when what is shown changed. */
  receive(message: CursorMessage, now: number): boolean {
    const previous = this.lastSeq.get(message.session);
    if (previous !== undefined && message.seq <= previous) return false;
    this.lastSeq.set(message.session, message.seq);
    if (!message.point) return this.entries.delete(message.session);
    this.entries.set(message.session, { session: message.session, point: message.point, seq: message.seq, at: now, ...(message.t !== undefined ? { t: message.t } : {}) });
    return true;
  }

  /** Forgets pointers that have not moved for `ttlMs`; true when any went. */
  prune(now: number, ttlMs = CURSOR_TTL_MS): boolean {
    let changed = false;
    for (const [session, cursor] of this.entries) {
      if (now - cursor.at >= ttlMs) {
        this.entries.delete(session);
        changed = true;
      }
    }
    return changed;
  }

  /** Keeps only the senders still present; true when any went. */
  retain(present: ReadonlySet<string>): boolean {
    let changed = false;
    for (const session of [...this.lastSeq.keys()]) {
      if (!present.has(session)) {
        this.lastSeq.delete(session);
        changed = this.entries.delete(session) || changed;
      }
    }
    return changed;
  }

  list(): RemoteCursor[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }
}
