/**
 * How Remy leaves a call, however she goes (time up, a quiet call, everyone gone, nobody came). In @livekit/agents
 * 1.9.3 a job's shutdown closes her voice session first, which can take up to a minute, and only then leaves the room:
 * for that minute she would look present to everyone, deaf and mute, and a new call would find her there and not send
 * her again. So she leaves first:
 *
 * 1. `mark`: her `remy.leaving` attribute, which the token route and the tabs read as gone; waited for at most
 *    `markMs`, as she leaves either way.
 * 2. `deleteRoom`, when the call ends for everyone (its time is up).
 * 3. `close`: her sessions start closing, not waited for.
 * 4. `disconnect`: she is off the call.
 * 5. `shutdown`: the job ends.
 */

export interface LeavingSteps {
  mark(): Promise<void>;
  deleteRoom?: () => Promise<void>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
  shutdown(): void;
  /** What went wrong on the way out (she leaves anyway). */
  onError?(step: 'mark' | 'mark_late' | 'delete_room' | 'close' | 'disconnect', error?: unknown): void;
}

export async function leaveCall(steps: LeavingSteps, { markMs }: { markMs: number }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), markMs)));
  const marked = steps.mark().then(() => 'marked' as const);
  const outcome = await Promise.race([marked, late]).catch((error: unknown) => {
    steps.onError?.('mark', error);
    return 'failed' as const;
  });
  clearTimeout(timer);
  if (outcome === 'late') steps.onError?.('mark_late');
  if (steps.deleteRoom) await steps.deleteRoom().catch((error: unknown) => steps.onError?.('delete_room', error));
  void steps.close().catch((error: unknown) => steps.onError?.('close', error));
  await steps.disconnect().catch((error: unknown) => steps.onError?.('disconnect', error));
  steps.shutdown();
}
