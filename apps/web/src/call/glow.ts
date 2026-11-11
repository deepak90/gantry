/**
 * Who is talking, on the plan: while someone on the call speaks, the label on their pointer gets a quiet ring in
 * their color (call.css), so a voice can be put to a pointer. Nothing follows the voice and nothing pulses: on a
 * call, only the call bar moves with voices (the speaking rings, Remy's aura and her thinking orbs). The header's
 * avatars stay still. Matched by identity: a person's identity on the call is their tab's presence session id,
 * which presence puts on their pointer.
 */
import type { CallSession } from './session';
import { humansOf } from './view';

const MARK = 'callSpeaking';
/** How often the pointers are looked at: they come and go with the people on the plan. */
const EVERY_MS = 200;

/** The pointer of the person whose tab is `identity`. */
function pointersOf(identity: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`.presence-cursor[data-session="${CSS.escape(identity)}"]`)];
}

export function glowSpeakers(session: CallSession): () => void {
  if (typeof document === 'undefined' || typeof CSS === 'undefined') return () => undefined;
  let lit = new Set<HTMLElement>();
  const look = () => {
    const now = new Set<HTMLElement>();
    if (session.inCall) {
      for (const person of humansOf(session.snapshot.people)) {
        if (person.isLocal || !person.speaking) continue;
        for (const pointer of pointersOf(person.identity)) {
          pointer.dataset[MARK] = 'true';
          now.add(pointer);
        }
      }
    }
    for (const pointer of lit) if (!now.has(pointer)) delete pointer.dataset[MARK];
    lit = now;
  };
  const timer = window.setInterval(look, EVERY_MS);
  const stop = session.subscribe(look);
  return () => {
    window.clearInterval(timer);
    stop();
    for (const pointer of lit) delete pointer.dataset[MARK];
  };
}
