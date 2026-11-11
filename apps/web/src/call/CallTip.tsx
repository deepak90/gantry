/**
 * What to say once the call starts: a small strip over the call bar, in a prompter's manner (a small label, the
 * line rolling in, the next thing beneath), with a few questions Remy answers on the Harbor plan, one at a time, and how
 * to talk to her. It shows once Remy is on the call, and closes by itself after the first exchange with her (someone
 * asks her something and she has answered) or after 20 seconds, or with its close button. Once per call.
 *
 * It sits in the call bar's controls and is placed against the bar itself (call.css), so it moves with the bar.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { ASSISTANT_NAME } from '../assistant/identity';
import { REMY, type RemyMessage } from './protocol';

/** Questions she answers on the Harbor plan, said the way people ask them. */
export const TIP_LINES = [
  'What’s the crane costing us while it waits?',
  'What if we pay the footings on Friday?',
  'What’s holding the ground floor?',
  'What are the odds we make the handover?',
] as const;
/** The name rule, in words. */
export const TIP_HINT = `Just talk. With others on the call, start with “${ASSISTANT_NAME}, …”`;
/** How long each line shows. */
export const TIP_TURN_MS = 5_000;
/** How long the strip stays at most. */
export const TIP_SHOW_MS = 20_000;

const EASE = [0.22, 1, 0.36, 1] as const;

/** What the strip reads of the call: what Remy hears and says (CallSession has it). */
export interface TipCall {
  onMessage(listener: (message: RemyMessage, from: string | null) => void): () => void;
}

export function CallTip({ call, remyHere }: { call: TipCall; remyHere: boolean }) {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<'before' | 'shown' | 'done'>('before');
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (remyHere && phase === 'before') setPhase('shown');
  }, [remyHere, phase]);

  useEffect(() => {
    if (phase !== 'shown') return undefined;
    const close = setTimeout(() => setPhase('done'), TIP_SHOW_MS);
    const turn = setInterval(() => setIndex((at) => (at + 1) % TIP_LINES.length), TIP_TURN_MS);
    // The first exchange: a line said to her, then the end of her answer.
    let asked = false;
    const stop = call.onMessage((message, from) => {
      if (from !== REMY) return;
      if (message.kind === 'heard' && message.addressed) asked = true;
      else if (message.kind === 'said' && asked) setPhase('done');
    });
    return () => {
      clearTimeout(close);
      clearInterval(turn);
      stop();
    };
  }, [phase, call]);

  return (
    <AnimatePresence>
      {phase === 'shown' && (
        <motion.section
          key="tip"
          className="call-tip"
          role="note"
          aria-label={`What to say to ${ASSISTANT_NAME}`}
          data-testid="call-tip"
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
          transition={{ duration: reduce ? 0 : 0.28, ease: EASE }}
        >
          <div className="call-tip-body">
            <span className="call-tip-label">Try saying</span>
            <div className="call-tip-lines">
              <AnimatePresence mode="wait" initial={false}>
                <motion.p
                  key={index}
                  className="call-tip-line"
                  data-testid="call-tip-line"
                  initial={reduce ? false : { y: 12, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={reduce ? { opacity: 0 } : { y: -12, opacity: 0 }}
                  transition={{ duration: reduce ? 0 : 0.22, ease: EASE }}
                >
                  “{TIP_LINES[index]}”
                </motion.p>
              </AnimatePresence>
            </div>
            <p className="call-tip-hint">{TIP_HINT}</p>
          </div>
          <button type="button" className="call-tip-close" onClick={() => setPhase('done')} aria-label="Close" title="Close" data-testid="call-tip-close">
            <i className="fa fa-xmark" aria-hidden="true" />
          </button>
          <span className="call-tip-time" aria-hidden="true" style={{ animationDuration: `${TIP_SHOW_MS}ms` }} />
        </motion.section>
      )}
    </AnimatePresence>
  );
}
