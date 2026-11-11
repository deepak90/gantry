/**
 * "Start here": the first time a session opens, a ring goes round the counter in the header and a small word beside
 * it says where to begin, its arrow nudging toward the counter. It goes at the first press or key anywhere, or after a
 * few seconds, and doesn't come back for that session in this browser. Without motion it simply stands there.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import '../styles/onboarding.css';

/** How long after the page opens it comes, and how long it stays. */
const DELAY_MS = 700;
const SHOWN_MS = 8000;

function seen(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function remember(key: string | null): void {
  if (!key) return;
  try {
    window.localStorage.setItem(key, 'seen');
  } catch {
    // Not remembered: it may come once more in this session.
  }
}

export interface StartHereTiming {
  delayMs?: number;
  shownMs?: number;
}

/**
 * Whether "Start here" is up: once per session (`storageKey`, null for none), gone at the first press or key, or
 * after a few seconds.
 */
export function useStartHere(storageKey: string | null, { delayMs = DELAY_MS, shownMs = SHOWN_MS }: StartHereTiming = {}): boolean {
  const [state, setState] = useState<'waiting' | 'shown' | 'gone'>(() => (storageKey === null || seen(storageKey) ? 'gone' : 'waiting'));
  useEffect(() => {
    if (state === 'gone') return undefined;
    const gone = () => {
      remember(storageKey);
      setState('gone');
    };
    const timer = window.setTimeout(state === 'waiting' ? () => setState('shown') : gone, state === 'waiting' ? delayMs : shownMs);
    const options = { capture: true, passive: true } as const;
    window.addEventListener('pointerdown', gone, options);
    window.addEventListener('keydown', gone, options);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', gone, options);
      window.removeEventListener('keydown', gone, options);
    };
  }, [state, storageKey, delayMs, shownMs]);
  return state === 'shown';
}

/** The ring and the word, laid over the counter's corner of the header; presses go through to the counter. */
export function StartHere({ shown }: { shown: boolean }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {shown && (
        <motion.span
          key="start-here"
          className="start-here-cue"
          aria-hidden="true"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.2 } }}
          transition={{ duration: reduce ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
          data-testid="start-here"
        >
          <span className="start-here-ring" />
          {!reduce && (
            <motion.span
              className="start-here-ring is-ping"
              initial={{ opacity: 0.7, scale: 1 }}
              animate={{ opacity: 0, scale: 1.18 }}
              transition={{ duration: 1.3, ease: 'easeOut', repeat: 3, repeatDelay: 0.5, delay: 0.3 }}
            />
          )}
          <motion.span
            className="start-here"
            initial={reduce ? false : { x: 10 }}
            animate={reduce ? { x: 0 } : { x: [10, 0, -4, 0, -4, 0] }}
            transition={reduce ? { duration: 0 } : { duration: 2.2, times: [0, 0.2, 0.45, 0.6, 0.85, 1], ease: 'easeInOut' }}
          >
            <svg className="start-here-arrow" viewBox="0 0 14 10" aria-hidden="true">
              <path d="M13 5H1.5M5.5 1 1.5 5l4 4" />
            </svg>
            Start here
          </motion.span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
