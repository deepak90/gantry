/**
 * The steps in the header, on a counter: which step this is and its name, behind a small window. When a
 * step is done, a check leaves the place it happened and goes up to the counter, and the wheels turn
 * one notch. A click opens the rest of the drum, with how to do the current step and "Show me".
 * Scrolling over the drum reads the other steps. It never covers the plan for long.
 *
 * It shows the project's steps (story.ts) and, on the hosted site, the things to try in a session (try-these.ts),
 * which can be done in any order: there the steps come done first, so each one done turns the counter a notch,
 * whichever it was, and "Show me" works on any step left. What the counter shows is held until the check lands;
 * when the step in the window stays the same (another one was done), only the number turns.
 */
import { AnimatePresence, motion, useReducedMotion, type MotionValue } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDismiss } from '../app/useDismiss';
import { firstVisible } from './StoryCoach';
import { drumStyle, useDrum, useFace, type DrumShape } from './StoryDrum';
import type { StoryStep } from './story';
import '../styles/onboarding.css';

/** What the counter needs of a step. */
export interface RailStep {
  key: string;
  label: string;
  hint: string;
  done: boolean;
  /** Where the step happens: selectors, the first one on screen wins (the check sets out from there). */
  targets: readonly string[];
}

/** The steps on the counter: a line about them, what "done" looks like, and the steps, the one at hand first not done. */
export interface RailStory<S extends RailStep = RailStep> {
  pitch: string;
  goal: string;
  steps: readonly S[];
}

export interface StoryRailProps<S extends RailStep = StoryStep> {
  story: RailStory<S>;
  onShow(step: S): void;
  onHide(): void;
  /** The steps can be done in any order: "Show me" is offered on any step not done yet, wherever the drum is turned. */
  anyOrder?: boolean;
  /** Beside the counter for a moment, such as "Start here" (StartHere.tsx). */
  cue?: ReactNode;
}

const COUNTER: DrumShape = { rowHeight: 20, degrees: 50 };
const SHEET: DrumShape = { rowHeight: 30, degrees: 20 };
/** How much scrolling turns the drum one row. */
const WHEEL_PER_ROW = 40;
/** A press this recent is what finished the step. */
const RECENT_PRESS_MS = 2500;
/** The check's whole trip, and the part of it spent where the step happened. */
const FLIGHT_S = 0.86;
const HOLD = 0.32;
const CHECK_WIDTH = 12;

interface Hand {
  touched: boolean;
  x: number;
  y: number;
  at: number;
}

/** Where the pointer last went down, and whether anyone has touched anything since the page opened. */
function useHand() {
  const hand = useRef<Hand>({ touched: false, x: 0, y: 0, at: -Infinity });
  useEffect(() => {
    const press = (event: PointerEvent) => {
      hand.current = { touched: true, x: event.clientX, y: event.clientY, at: performance.now() };
    };
    const key = () => {
      hand.current.touched = true;
    };
    const options = { capture: true, passive: true } as const;
    window.addEventListener('pointerdown', press, options);
    window.addEventListener('keydown', key, options);
    return () => {
      window.removeEventListener('pointerdown', press, options);
      window.removeEventListener('keydown', key, options);
    };
  }, []);
  return hand;
}

interface Point {
  x: number;
  y: number;
}

const middle = (rect: DOMRect): Point => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

/** Where a finished step happened: the press that did it, or else the thing it was about. Nothing on load. */
function whereItHappened(step: RailStep, hand: Hand): Point | null {
  if (!hand.touched) return null;
  if (performance.now() - hand.at < RECENT_PRESS_MS) return { x: hand.x, y: hand.y };
  const target = firstVisible(step.targets);
  return target ? middle(target.getBoundingClientRect()) : null;
}

/** The step at hand: the first one not done (the step count when every one is). */
const atOf = (steps: readonly RailStep[]): number => {
  const index = steps.findIndex((step) => !step.done);
  return index < 0 ? steps.length : index;
};

/** What the counter shows: the steps as they were when it last turned, and where it stands on them. */
interface Shown<S> {
  steps: readonly S[];
  at: number;
  /** The step in the window is the same one as before the counter turned: its name stays where it is. */
  still: boolean;
}

function shownOf<S extends RailStep>(steps: readonly S[], before: Shown<S> | null): Shown<S> {
  const at = atOf(steps);
  return { steps, at, still: before !== null && steps[at]?.key === before.steps[before.at]?.key };
}

function Check() {
  return (
    <svg className="story-check" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.5 6.5 5 9l4.5-5.5" />
    </svg>
  );
}

/** A small check where the step happened. It shrinks to a dot and arrives at the counter at speed, which turns the wheels. */
function CheckFlight({ from, to, onLand }: { from: Point; to: Point; onLand(): void }) {
  // The bend is under the digit, so the last of the trip comes up into it from below.
  const bend = { x: to.x, y: to.y + (from.y - to.y) * 0.5 };
  const path = `M${from.x} ${from.y}Q${bend.x} ${bend.y} ${to.x} ${to.y}`;
  return createPortal(
    <motion.span
      className="story-flight"
      style={{ offsetPath: `path("${path}")` }}
      aria-hidden="true"
      initial={{ offsetDistance: '0%', scale: 0.5, opacity: 0 }}
      animate={{ offsetDistance: ['0%', '0%', '100%'], scale: [0.5, 1, 1, 0.36, 0.36], opacity: [0, 1, 1, 1] }}
      transition={{
        offsetDistance: { duration: FLIGHT_S, times: [0, HOLD, 1], ease: ['linear', [0.5, 0, 0.75, 0.9]] },
        scale: { duration: FLIGHT_S, times: [0, 0.12, HOLD, 0.62, 1], ease: 'easeOut' },
        opacity: { duration: FLIGHT_S, times: [0, 0.12, HOLD, 1] },
      }}
      onAnimationComplete={onLand}
    >
      <motion.span animate={{ opacity: [1, 1, 0, 0] }} transition={{ duration: FLIGHT_S, times: [0, HOLD, HOLD + 0.1, 1] }}>
        <Check />
      </motion.span>
    </motion.span>,
    document.body,
  );
}

function CounterRow({ turn, index, children }: { turn: MotionValue<number>; index: number; children: ReactNode }) {
  const style = useFace(turn, index, COUNTER);
  return (
    <motion.span className="story-face" style={style}>
      {children}
    </motion.span>
  );
}

function SheetRow({ turn, index, children, ...rest }: { turn: MotionValue<number>; index: number; children: ReactNode; className?: string; 'aria-current'?: 'step'; 'data-testid'?: string }) {
  const style = useFace(turn, index, SHEET);
  return (
    <motion.li {...rest} style={style}>
      {children}
    </motion.li>
  );
}

interface StorySheetProps<S extends RailStep> {
  story: RailStory<S>;
  at: number;
  anyOrder: boolean;
  onShow(step: S): void;
  onHide(): void;
}

function StorySheet<S extends RailStep>({ story, at, anyOrder, onShow, onHide }: StorySheetProps<S>) {
  const reduce = useReducedMotion();
  const [peek, setPeek] = useState<number | null>(null);
  const scrolled = useRef(0);
  const drum = useRef<HTMLDivElement>(null);
  const showing = peek ?? at;
  const { turn } = useDrum(showing, { start: at - 0.4 });
  const count = story.steps.length;
  const step = story.steps[showing];
  // A step can be shown from where the drum stands: the one at hand, or any one left when the order is free.
  const showable = step && !step.done && (anyOrder || showing === at) ? step : null;

  const move = useCallback((rows: number) => setPeek((current) => Math.min(count, Math.max(0, (current ?? at) + rows))), [at, count]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
  };
  // Scrolling here turns the drum and nothing behind it, which takes a listener that can say so.
  useEffect(() => {
    const node = drum.current;
    if (!node) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      scrolled.current += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 20 : event.deltaY;
      const rows = Math.trunc(scrolled.current / WHEEL_PER_ROW);
      if (rows !== 0) {
        scrolled.current -= rows * WHEEL_PER_ROW;
        move(rows);
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [move]);

  return (
    <>
      <p className="story-rail-pitch">{story.pitch}</p>
      <div className={`story-drum${at === 0 ? ' is-first' : ''}${step ? '' : ' is-complete'}`} ref={drum} style={drumStyle(SHEET)} onPointerLeave={() => setPeek(null)}>
        <ol className="story-drum-rows" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => setPeek(null)}>
          {story.steps.map((row, index) => (
            <SheetRow
              key={row.key}
              turn={turn}
              index={index}
              className={`story-face story-row${row.done ? ' is-done' : index === at ? ' is-current' : ''}${showable && index === showing && index !== at ? ' is-picked' : ''}`}
              aria-current={index === at ? 'step' : undefined}
              data-testid={`story-step-${row.key}`}
            >
              <span className="story-row-mark">{row.done ? <Check /> : index + 1}</span>
              <span className="story-row-label">
                {row.label}
                {row.done && <span className="visually-hidden">, done</span>}
              </span>
            </SheetRow>
          ))}
          <SheetRow turn={turn} index={count} className={`story-face story-row${at === count ? ' is-done is-current' : ''}`}>
            <span className="story-row-mark">{at === count && <Check />}</span>
            <span className="story-row-label">{story.goal}</span>
          </SheetRow>
        </ol>
        <span className="story-drum-window" aria-hidden="true" />
      </div>
      {step && (
        <motion.p key={step.key} className="story-rail-hint" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.16 }} data-testid="story-hint">
          {step.hint}
        </motion.p>
      )}
      <footer className="story-rail-foot">
        <button type="button" className="button is-quiet is-sm" title="They come back from your account menu" onClick={onHide}>
          Hide the steps
        </button>
        {showable && (
          <button type="button" className="button is-primary is-sm" onClick={() => onShow(showable)} data-testid="story-show">
            Show me
          </button>
        )}
      </footer>
    </>
  );
}

export function StoryRail<S extends RailStep = StoryStep>({ story, onShow, onHide, anyOrder = false, cue }: StoryRailProps<S>) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  const root = useRef<HTMLDivElement>(null);
  const counter = useRef<HTMLSpanElement>(null);
  const sizer = useRef<HTMLSpanElement>(null);
  const hand = useHand();

  const latest = useRef(story.steps);
  latest.current = story.steps;

  // The counter holds the steps as they were until the check that finished the last one has landed.
  const [shown, setShown] = useState<Shown<S>>(() => shownOf(story.steps, null));
  const [flight, setFlight] = useState<{ key: string; from: Point; to: Point } | null>(null);
  useEffect(() => {
    if (flight || story.steps === shown.steps) return;
    const at = atOf(story.steps);
    // One step more done: the check goes up from where it happened. It is the first of the steps not counted yet.
    const finished = at === shown.at + 1 && !open && !reduce ? story.steps[shown.at] : undefined;
    const from = finished ? whereItHappened(finished, hand.current) : null;
    const to = counter.current?.getBoundingClientRect();
    if (finished && from && to) setFlight({ key: finished.key, from, to: middle(to) });
    else setShown((before) => shownOf(story.steps, before));
  }, [story.steps, shown, flight, open, reduce, hand]);

  const steps = shown.steps;
  const count = steps.length;
  const snap = !hand.current.touched;
  const digits = useDrum(shown.at, { snap });
  // When the step in the window stays the same, its name doesn't move: only the number turns.
  const names = useDrum(shown.at, { snap: snap || shown.still });
  const label = (row: number) => steps[row]?.label ?? story.goal;
  const rowsOf = ({ first, last }: { first: number; last: number }) => Array.from({ length: last - first + 1 }, (_, offset) => first + offset);

  // The name's window follows the name, so the wheel never clips it.
  const [labelWidth, setLabelWidth] = useState<number>();
  useLayoutEffect(() => {
    const node = sizer.current;
    if (!node) return undefined;
    const measure = () => setLabelWidth(Math.ceil(node.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useDismiss(open, root, () => setOpen(false));

  const at = shown.at;
  return (
    <div className="story-rail" ref={root} data-testid="story-rail">
      <button
        type="button"
        className="story-rail-button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={at < count ? `Step ${at + 1} of ${count}: ${label(at)}` : label(at)}
        onClick={() => setOpen((value) => !value)}
        data-testid="story-rail-button"
      >
        <span className={`story-rail-count${at < count ? '' : ' is-complete'}`} style={drumStyle(COUNTER)}>
          <span className="story-wheel story-rail-digit" ref={counter} style={{ width: at < count ? `${String(at + 1).length}ch` : CHECK_WIDTH }}>
            {rowsOf(digits).map((row) => (
              <CounterRow key={row} turn={digits.turn} index={row}>
                {row < count ? row + 1 : <Check />}
              </CounterRow>
            ))}
          </span>
          <span className="story-rail-of">/{count}</span>
        </span>
        <span className={`story-wheel story-rail-label${names.first === names.last ? '' : ' is-turning'}`} style={{ ...drumStyle(COUNTER), width: labelWidth }}>
          <span className="story-rail-sizer" ref={sizer}>
            {label(at)}
          </span>
          {rowsOf(names).map((row) => (
            <CounterRow key={row} turn={names.turn} index={row}>
              {label(row)}
            </CounterRow>
          ))}
        </span>
        <svg className="story-rail-chevron" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" />
        </svg>
      </button>
      {cue}
      <AnimatePresence>
        {open && (
          <motion.div
            className="popover story-rail-sheet"
            role="dialog"
            aria-label="The steps"
            initial={reduce ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
            data-testid="story-steps"
          >
            <StorySheet
              story={{ ...story, steps }}
              at={at}
              anyOrder={anyOrder}
              onShow={(step) => {
                setOpen(false);
                onShow(step);
              }}
              onHide={() => {
                setOpen(false);
                onHide();
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {flight && (
        <CheckFlight
          key={flight.key}
          from={flight.from}
          to={flight.to}
          onLand={() => {
            setFlight(null);
            setShown((before) => shownOf(latest.current, before));
          }}
        />
      )}
    </div>
  );
}
