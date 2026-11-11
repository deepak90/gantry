/**
 * How long a clip runs: the tape, a hold on its last frame (the outcome, also the poster), then a
 * short dissolve back to the opening shot, so the clip loops without a jump. Shared by the
 * composition and render.ts, which takes the poster from the end of the hold.
 */
export const HOLD_MS = 1_400;
export const LOOP_MS = 450;

export function clipTiming(tape: { fps: number; duration_ms: number }): { frames: number; poster: number } {
  const frameAt = (ms: number) => Math.round((ms / 1000) * tape.fps);
  return { frames: frameAt(tape.duration_ms + HOLD_MS + LOOP_MS), poster: frameAt(tape.duration_ms + HOLD_MS) - 1 };
}
