/**
 * The coach: nothing on screen while people work. After a pause (no click, key or scroll for a few
 * seconds) thin corner marks close in on the one thing to do next, with a short note beside it (under it,
 * for a control in the header or the toolbar: the note never covers the header). A click or a key
 * anywhere puts it away until the next pause; "Got it" puts it away for that step. "Show me" points
 * right away instead of waiting for a pause, and the marks go there from the steps in the header, so the
 * eye can follow them.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { StoryStep } from './story';
import '../styles/onboarding.css';

/** What the coach points at: a step of the steps, or an item of "Try these" (try-these.ts). */
export interface CoachStep {
  key: string;
  label: string;
  hint: string;
  /** Selectors: the first one on screen wins. */
  targets: readonly string[];
}

export interface StoryCoachProps<S extends CoachStep = StoryStep> {
  /** The next step, or null when every step is done. */
  step: S | null;
  /** How long a pause lasts before the coach speaks up. */
  idleMs?: number;
  /** A new value means someone pressed "Show me": point now. */
  nudge?: number;
  onShow(step: S): void;
}

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Spot extends Box {
  key: string;
  /** Pointing at a side panel's tab, not yet at the thing itself. */
  onTab: boolean;
  /** Where the marks set out from, when someone asked for them. */
  from: Box | null;
  /** The bottom of the page's header: the note stays below it, so the steps and the header's buttons stay in view. */
  floor: number;
  /** Where the side panel's tabs begin (their left edge): the note stays clear of them. The window's edge without them. */
  edge?: number;
}

/** How far the marks stand off the thing they point at. */
const STANDOFF = 5;
/** How far outside that they start, when they just close in. */
const CLOSE_IN = 8;
const MARK = 10;
/** The note's width (onboarding.css), and the room kept round it. */
const NOTE_WIDTH = 284;
const GAP = 10;
/** A control this far below the header at most is in the header or the toolbar under it: the note goes under the control. */
const TOP_BAND = 56;
/**
 * While one of these is open, the coach doesn't speak up on its own: a menu or a popover (the steps' sheet and the
 * invite card among them; the header's popovers sit under the coach's layer), and the odds.
 */
export const QUIET_WHILE = '.popover, [data-testid="invite-card"], [data-testid="odds-panel"]';

/** The first target on screen: present, drawn, and inside the window. */
export function firstVisible(selectors: readonly string[]): HTMLElement | null {
  for (const selector of selectors) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth) return element;
    }
  }
  return null;
}

const boxOf = (element: Element): Box => {
  const { top, left, width, height } = element.getBoundingClientRect();
  return { top, left, width, height };
};

const spotOf = (key: string, element: HTMLElement, from: Box | null): Spot => ({
  key,
  ...boxOf(element),
  onTab: element.matches('[data-testid^="inspector-tab-"]'),
  from,
  floor: document.querySelector('.app-header')?.getBoundingClientRect().bottom ?? 0,
  edge: document.querySelector('.inspector-rail')?.getBoundingClientRect().left ?? window.innerWidth,
});

/** Where the note goes: under a control in the header or the toolbar, else beside the control on its roomier side; never over the header. */
export function placeNote(spot: Spot, around: Box): { style: CSSProperties; from: { x?: number; y?: number } } {
  const under = !spot.onTab && spot.top + spot.height <= spot.floor + TOP_BAND;
  if (under) {
    const edge = Math.min(window.innerWidth, spot.edge ?? window.innerWidth);
    const left = Math.max(GAP, Math.min(around.left, edge - NOTE_WIDTH - GAP));
    return { style: { top: Math.max(spot.floor + GAP, around.top + around.height + GAP), left }, from: { y: -6 } };
  }
  const top = Math.max(spot.floor + GAP, Math.min(spot.top + spot.height / 2 - 48, window.innerHeight - 180));
  const onLeft = spot.left + spot.width / 2 > window.innerWidth / 2;
  return onLeft ? { style: { top, right: window.innerWidth - around.left + GAP }, from: { x: 6 } } : { style: { top, left: around.left + around.width + GAP }, from: { x: -6 } };
}

const outset = (box: Box, by: number): Box => ({ top: box.top - by, left: box.left - by, width: box.width + by * 2, height: box.height + by * 2 });

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

const cornerOf = (corner: (typeof CORNERS)[number], box: Box) => ({
  x: corner.endsWith('left') ? box.left : box.left + box.width - MARK,
  y: corner.startsWith('top') ? box.top : box.top + box.height - MARK,
});

/** Whether the coach may speak up for a step: on its own once a step; "Show me" (`asked`) any time. */
export const mayCoach = (spoken: ReadonlySet<string>, key: string, asked: boolean): boolean => asked || !spoken.has(key);

export function StoryCoach<S extends CoachStep = StoryStep>({ step, idleMs = 9000, nudge = 0, onShow }: StoryCoachProps<S>) {
  const reduce = useReducedMotion();
  const [spot, setSpot] = useState<Spot | null>(null);
  const dismissed = useRef(new Set<string>());
  const note = useRef<HTMLDivElement>(null);
  const setOutFrom = useRef<Box | null>(null);
  const stepRef = useRef(step);
  stepRef.current = step;
  const seenNudge = useRef(nudge);
  /** Steps the coach has already spoken up for on its own: it does that once a step; "Show me" brings it back any time. */
  const autoShown = useRef(new Set<string>());

  useEffect(() => {
    setSpot(null);
    let soon = nudge !== seenNudge.current;
    seenNudge.current = nudge;
    if (soon && step) dismissed.current.delete(step.key);
    if (!step || step.targets.length === 0 || dismissed.current.has(step.key)) return undefined;
    // Once on its own is enough: it never keeps coming back over what someone is reading.
    if (!mayCoach(autoShown.current, step.key, soon)) return undefined;
    let timer = 0;
    let showing = false;
    const show = () => {
      const asked = soon;
      soon = false;
      const current = stepRef.current;
      const target = current ? firstVisible(current.targets) : null;
      // The open steps already say what is next ("Show me" came from there, and they are on their way out); a menu
      // that is open is left in view; and someone reading the odds is left to it, as with the 3D view (fx3d-building.css).
      if (!current || !target || (!asked && document.querySelector(QUIET_WHILE))) {
        timer = window.setTimeout(show, idleMs);
        return;
      }
      showing = true;
      if (!asked) autoShown.current.add(current.key);
      const rail = document.querySelector('[data-testid="story-rail-button"]');
      const from = asked ? (setOutFrom.current ?? (rail ? boxOf(rail) : null)) : null;
      setOutFrom.current = null;
      setSpot(spotOf(current.key, target, from));
    };
    const arm = () => {
      window.clearTimeout(timer);
      // A moment for the panel that "Show me" just opened to draw.
      timer = window.setTimeout(show, soon ? 250 : idleMs);
    };
    // A click, a key or a scroll anywhere but on the note puts the coach away and starts the wait again.
    const interact = (event: Event) => {
      if (note.current?.contains(event.target as Node)) return;
      if (showing) {
        showing = false;
        setSpot(null);
      }
      if (mayCoach(autoShown.current, stepRef.current?.key ?? '', false)) arm();
    };
    // Moving the pointer only delays it; it never hides a coach already showing (the pointer may be on its way to it).
    const move = () => {
      if (!showing && !soon && mayCoach(autoShown.current, stepRef.current?.key ?? '', false)) arm();
    };
    const reposition = () => {
      if (!showing) return;
      const current = stepRef.current;
      const target = current ? firstVisible(current.targets) : null;
      if (current && target) setSpot(spotOf(current.key, target, null));
    };
    const options = { capture: true, passive: true } as const;
    window.addEventListener('pointerdown', interact, options);
    window.addEventListener('keydown', interact, options);
    window.addEventListener('wheel', interact, options);
    window.addEventListener('pointermove', move, options);
    window.addEventListener('resize', reposition);
    arm();
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', interact, options);
      window.removeEventListener('keydown', interact, options);
      window.removeEventListener('wheel', interact, options);
      window.removeEventListener('pointermove', move, options);
      window.removeEventListener('resize', reposition);
    };
  }, [step?.key, idleMs, nudge]);

  const around = spot && outset(spot, STANDOFF);
  const start = spot && around && (spot.from ?? outset(around, CLOSE_IN));
  const traveling = Boolean(spot?.from);
  const placed = spot && around ? placeNote(spot, around) : null;

  return createPortal(
    <AnimatePresence>
      {spot && around && start && placed && step && spot.key === step.key && (
        <motion.div key={spot.key} className="story-coach" initial={false} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0 : 0.16 }} data-testid="story-coach">
          {CORNERS.map((corner) => (
            <motion.span
              key={corner}
              className={`story-coach-mark is-${corner}`}
              aria-hidden="true"
              initial={reduce ? false : { ...cornerOf(corner, start), opacity: traveling ? 1 : 0 }}
              animate={{ ...cornerOf(corner, around), opacity: 1 }}
              transition={reduce ? { duration: 0 } : { type: 'spring', bounce: 0, visualDuration: traveling ? 0.56 : 0.3 }}
            />
          ))}
          <motion.div
            ref={note}
            className="card story-coach-note"
            role="status"
            style={placed.style}
            initial={reduce ? false : { opacity: 0, ...placed.from }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            transition={{ delay: reduce ? 0 : traveling ? 0.34 : 0.12, duration: reduce ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <span className="story-coach-kicker">Next</span>
            <strong>{step.label}</strong>
            <span>{step.hint}</span>
            <span className="story-coach-actions">
              <button
                type="button"
                className="button is-quiet is-sm"
                onClick={() => {
                  dismissed.current.add(step.key);
                  setSpot(null);
                }}
              >
                Got it
              </button>
              {spot.onTab && (
                <button
                  type="button"
                  className="button is-primary is-sm"
                  onClick={() => {
                    // From the tab to the thing itself: the marks carry on from here.
                    setOutFrom.current = around;
                    setSpot(null);
                    onShow(step);
                  }}
                >
                  Show me
                </button>
              )}
            </span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
