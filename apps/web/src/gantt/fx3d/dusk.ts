/**
 * The building at dusk: the film's shot of the tenant's new lights coming on. The day goes down to a slate evening over
 * the site, then each floor with lights in it comes on in turn, lowest first, and the shot holds on them.
 *
 * Also the go-between for a walkthrough and the site view, as rental-story.ts is for the crane: the view hands itself
 * in while it is up (`duskStage`).
 *
 * Pure: no three.js, so the timing can be tested on its own.
 */

/** How long the evening takes to come down. */
const FALL_SECONDS = 0.95;
/** When the first floor starts to come on: as the evening is nearly down. */
const FIRST_ON = 0.7;
/** From one floor starting to come on to the next. */
const BETWEEN = 0.7;
/** How long one floor takes to come on. */
const RAMP = 0.45;
/** How long the shot holds once the last floor is on. */
const HOLD = 0.6;

const ease = (t: number) => {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
};

/** How long the shot runs for this many floors: about 4 s for three. */
export function duskSeconds(floors: number): number {
  return Math.max(FALL_SECONDS, FIRST_ON + Math.max(0, floors - 1) * BETWEEN + RAMP) + HOLD;
}

export interface DuskMoment {
  /** 0: the day; 1: the evening. */
  evening: number;
  /** How far each floor's lights are on, 0 to 1, lowest floor first. */
  floors: number[];
  /** The shot has run its length. */
  done: boolean;
}

/** The shot `t` seconds in. */
export function duskAt(t: number, floors: number): DuskMoment {
  return {
    evening: ease(t / FALL_SECONDS),
    floors: Array.from({ length: floors }, (_, floor) => ease((t - FIRST_ON - floor * BETWEEN) / RAMP)),
    done: t >= duskSeconds(floors),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The walkthrough's way in: the site view hands itself in while it is up
// ---------------------------------------------------------------------------------------------------------------------

/** What the film's walkthrough asks of the site view for the shot. */
export interface DuskStage {
  /** The layers with light fixtures in them, lowest first; empty while the view is on its way in or there are none. */
  floors(): readonly number[];
  /**
   * The whole shot, about 4 s: the view goes to the day the last lights are in, frames the building, the evening comes
   * down and the floors light up one after another. Resolves once it has held on them; the evening stays until `lift`.
   */
  play(): Promise<void>;
  /** Back to the day, the lights left as the plan has them. Closing the view does this by itself. */
  lift(seconds?: number): Promise<void>;
}

let current: DuskStage | null = null;

export const duskStage = {
  /** The site view while it is up; null otherwise. */
  get(): DuskStage | null {
    return current;
  },
  /** The view hands itself in (or out, with null). */
  set(stage: DuskStage | null): void {
    current = stage;
  },
};
