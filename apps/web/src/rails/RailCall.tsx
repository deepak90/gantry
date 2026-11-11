/**
 * The call, low on the screen, over the chart, 3D and dialogs alike. It shows who is on the call and
 * who is talking, with their words coming up as they say them, like captions on a call. Once everyone
 * has stopped, it shows the step's takeaway. In the voice mode you are on the call too, with your
 * microphone's level, so it shows when you are talking and the assistant listening.
 *
 * On a call with several people (`captions` given), the words are the call's captions: the speaker's
 * name in their color over their latest words, two lines at most, in a place kept for them so the bar
 * doesn't grow and shrink as people talk; CC on the bar turns them off. Screen readers are told each
 * finished line by the call itself (CallLayer), not every word as it is made out.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { RemyMark } from '../assistant/RemyMark';
import { wordsOf, type Call, type CallState, type Words } from './call';
import type { Hand } from './hand';
import { AssistantFace, assistantDoing, Meter, moodOf, useCallState, YourFace } from './RailFaces';
import '../styles/rails.css';

export interface CallPerson {
  name: string;
  color: string;
}

const EASE = [0.22, 1, 0.36, 1] as const;

function Said({ state, name }: { state: CallState; name: string }) {
  const words = state.words!;
  const shown = wordsOf(words.text).slice(0, words.shown);
  // Live transcription: the last few words may still change, so they show fainter until settled.
  const settled = shown.length - (words.tentative ?? 0);
  return (
    <p className={`rail-call-said is-${words.who}`} data-testid="rail-call-said" data-who={words.who}>
      <span className="rail-call-who">{words.name ?? (words.who === 'you' ? 'You' : name)}</span>
      <span className="rail-call-words">
        {shown.map((word, index) => (
          <span key={index} className={`rail-word${index >= settled ? ' is-tentative' : ''}`}>
            {word}{' '}
          </span>
        ))}
      </span>
    </p>
  );
}

/**
 * A caption on a call with several people: who is speaking, in their color, over their words. The words keep
 * their places as the transcript grows (only new words come in), and the newest two lines show. Before their
 * first words are in, dots: never words that weren't heard.
 */
function Caption({ words, name }: { words: Words; name: string }) {
  const shown = wordsOf(words.text).slice(0, words.shown);
  const settled = shown.length - (words.tentative ?? 0);
  const reduce = useReducedMotion();
  return (
    <motion.p
      className={`rail-call-said is-${words.who}`}
      data-testid="rail-call-said"
      data-who={words.who}
      style={words.color ? ({ '--speaker': words.color } as CSSProperties) : undefined}
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : 0.16, ease: EASE }}
    >
      <span className="rail-call-who">{words.name ?? (words.who === 'you' ? 'You' : name)}</span>
      <span className="rail-call-words">
        <span className="rail-call-line">
          {shown.length === 0 ? (
            <span className="rail-call-dots" role="img" aria-label="Speaking">
              <i />
              <i />
              <i />
            </span>
          ) : (
            shown.map((word, index) => (
              <span key={index} className={`rail-word${index >= settled ? ' is-tentative' : ''}`}>
                {word}{' '}
              </span>
            ))
          )}
        </span>
      </span>
    </motion.p>
  );
}

/** What the call shows in words now, if anything. A new line is a new caption, so its words come in fresh. */
function wordsFor(state: CallState, call: Call, voice: boolean) {
  if (state.words) return <Said key={`${state.words.name ?? state.words.who}:${state.words.text}`} state={state} name={call.name} />;
  if (state.takeaway) {
    return (
      <p className="rail-call-takeaway" data-testid="rail-call-takeaway">
        <strong>{state.takeaway.lead}</strong> {state.takeaway.text}
      </p>
    );
  }
  // Your words are written down once you finish (live, they can't be as you go): until then, dots, never
  // words that weren't heard.
  if (state.youTalking) {
    return (
      <p className="rail-call-said is-you is-hearing" data-testid="rail-call-hearing">
        <span className="rail-call-who">You</span>
        <span className="rail-call-dots" role="img" aria-label="Talking">
          <i />
          <i />
          <i />
        </span>
      </p>
    );
  }
  if (import.meta.env.DEV && voice && state.mic === 'starting') return <p className="rail-call-status">Starting your microphone…</p>;
  if (import.meta.env.DEV && voice && state.mic === 'blocked') return <p className="rail-call-status">The microphone is blocked. Allow it from the address bar, then reload.</p>;
  if (import.meta.env.DEV && voice && state.mic === 'deaf') return <p className="rail-call-status">No words can be made out: speech recognition is off (Chrome, the microphone and the network are needed).</p>;
  return null;
}

/**
 * The call steps aside when the assistant works underneath it: it slides along the bottom to the far
 * side from the cursor, and comes back once the cursor has gone. `--shift` is written on every frame,
 * without a render.
 */
function useStepAside(dock: RefObject<HTMLDivElement | null>, hand: Hand) {
  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return undefined;
    let frame = 0;
    let shift = 0;
    let clearSince = 0;
    const MARGIN = 72;
    const tick = (now: number) => {
      const element = dock.current;
      if (element) {
        const width = element.offsetWidth;
        const height = element.offsetHeight;
        const bottom = Number.parseFloat(getComputedStyle(element).bottom) || 24;
        const home = { left: (window.innerWidth - width) / 2, top: window.innerHeight - bottom - height };
        const { x, y } = hand.position;
        const under = hand.present && y >= home.top - 48 && x >= home.left - MARGIN && x <= home.left + width + MARGIN;
        let wanted = shift;
        if (under) {
          clearSince = 0;
          // All the way to the far side, so what the cursor works on stays in view around it too.
          wanted = x < window.innerWidth / 2 ? window.innerWidth - 16 - (home.left + width) : 16 - home.left;
        } else if (shift !== 0) {
          clearSince ||= now;
          if (now - clearSince > 900) wanted = 0;
        }
        if (Math.abs(wanted - shift) > 1) {
          shift = wanted;
          element.style.setProperty('--shift', `${Math.round(shift)}px`);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dock, hand]);
}

/** Where the call bar goes when the call ends: into the element given, curving there as it shrinks to a spark. */
const leaving = {
  gone: (to: { x: number; y: number } | null) =>
    to
      ? {
          x: [0, to.x * 0.72, to.x],
          y: [0, to.y * 0.28, to.y],
          scale: [1, 0.42, 0.05],
          opacity: [1, 0.95, 0],
          transition: { duration: 0.64, ease: [0.55, 0, 0.75, 0.2] as const },
        }
      : { opacity: 0, y: 10, transition: { duration: 0.28, ease: EASE } },
};

/**
 * `people`: on a call with several people, their tiles, after the assistant's (the call panel draws them);
 * they take the place of your own tile. `captions`: on such a call, whether its captions show (CC). `notice`: a word
 * about the call itself, such as "Remy is unavailable right now" with why under it, when the server refused her; it
 * takes the captions' place, with her mark, and the bar shows while it is set.
 */
export function RailCall({
  call,
  hand,
  you,
  voice: asked,
  controls,
  people,
  captions,
  notice = null,
  flyTo,
}: {
  call: Call;
  hand: Hand;
  you: CallPerson;
  voice: boolean;
  controls?: ReactNode;
  people?: ReactNode;
  captions?: boolean;
  notice?: CallNotice | string | null;
  flyTo?: () => Element | null;
}) {
  // The voice mode exists on the dev server only; built for production, its part of the call is left out.
  const voice = import.meta.env.DEV && asked;
  const state = useCallState(call);
  const reduce = useReducedMotion();
  const dock = useRef<HTMLDivElement>(null);
  useStepAside(dock, hand);
  const assistantOn = state.presence !== 'away';
  // A call's captions are its words; there are no takeaways or voice-mode notes on one.
  const captioned = captions !== undefined;
  const words = captioned ? null : wordsFor(state, call, voice);
  const caption = captioned && captions && state.words ? <Caption key={state.words.name ?? state.words.who} words={state.words} name={call.name} /> : null;
  const visible = assistantOn || words !== null || caption !== null || (voice && state.mic === 'on') || Boolean(controls) || Boolean(people) || Boolean(notice);
  // While it is on screen, what sits at the bottom of the site view moves up out of its way (fx3d-building.css).
  useEffect(() => {
    if (!visible) return undefined;
    document.documentElement.classList.add('has-rail-call');
    return () => document.documentElement.classList.remove('has-rail-call');
  }, [visible]);
  const mood = moodOf(state);
  // Measured as the call ends, while the bar is still on screen.
  const flight = (): { x: number; y: number } | null => {
    const target = reduce ? null : flyTo?.();
    const element = dock.current;
    if (!target || !element) return null;
    const from = element.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    return { x: to.left + to.width / 2 - (from.left + from.width / 2), y: to.top + to.height / 2 - (from.top + from.height / 2) };
  };
  return createPortal(
    <AnimatePresence custom={visible ? null : flight()}>
      {visible && (
        <motion.div
          ref={dock}
          className={`rail-call${words || caption || notice ? ' has-words' : ''}${assistantOn || voice || people ? ' has-people' : ''}${captioned ? ' is-captions' : ''}`}
          data-testid="rail-call"
          data-mood={assistantOn ? mood : 'away'}
          initial={reduce ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          variants={leaving}
          exit="gone"
          transition={{ duration: reduce ? 0 : 0.28, ease: EASE }}
        >
          <div className="rail-call-people">
            <AnimatePresence initial={false}>
              {assistantOn && (
                <motion.div
                  key="assistant"
                  className={`rail-call-tile is-assistant is-${state.presence}`}
                  data-testid="rail-call-assistant"
                  initial={reduce ? false : { opacity: 0, scale: 0.6, width: 0 }}
                  animate={{ opacity: 1, scale: 1, width: 'auto' }}
                  exit={{ opacity: 0, scale: 0.7, width: 0 }}
                  transition={{ duration: reduce ? 0 : 0.42, ease: EASE }}
                >
                  <AssistantFace call={call} state={state} size="md" />
                  <span className="rail-call-name">
                    {call.name}
                    <span className="rail-tag">AI</span>
                  </span>
                  <span className="rail-call-doing">{assistantDoing(state)}</span>
                </motion.div>
              )}
            </AnimatePresence>
            {people}
            {voice && !people && (
              <div className={`rail-call-tile is-you${state.youTalking ? ' is-talking' : ''}`} data-testid="rail-call-you">
                <YourFace call={call} name={you.name} color={you.color} />
                <span className="rail-call-name">You</span>
                <Meter call={call} />
              </div>
            )}
          </div>
          {words && (
            <div className="rail-call-text" role="status" aria-live="polite">
              {words}
            </div>
          )}
          {notice && <NoticeLine notice={typeof notice === 'string' ? { title: notice } : notice} reduce={reduce === true} />}
          {/* Kept on screen while captions are on, empty or not, so the bar holds still (a notice takes their place). */}
          {!notice && captioned && captions && (
            <div className="rail-call-text" data-testid="rail-call-captions">
              <AnimatePresence initial={false} mode="wait">
                {caption}
              </AnimatePresence>
            </div>
          )}
          {controls && <div className="rail-call-controls">{controls}</div>}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** A word about the call itself: a title, and a line under it when there is more to say. */
export interface CallNotice {
  title: string;
  detail?: string | null;
}

/** The notice, in the captions' place: Remy's mark, the title, and why under it. */
function NoticeLine({ notice, reduce }: { notice: CallNotice; reduce: boolean }) {
  return (
    <motion.div
      className="rail-call-text is-notice"
      role="status"
      aria-live="polite"
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0 : 0.3, ease: EASE }}
    >
      <div className="rail-call-notice" data-testid="rail-call-notice">
        <span className="rail-call-notice-mark" aria-hidden="true">
          <RemyMark />
        </span>
        <span className="rail-call-notice-words">
          <strong className="rail-call-notice-title">{notice.title}</strong>
          {notice.detail && <span className="rail-call-notice-detail">{notice.detail}</span>}
        </span>
      </div>
    </motion.div>
  );
}
