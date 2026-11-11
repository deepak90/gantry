/**
 * The spark button's shell (SparkShell) the call with Remy wears, with Remy's mark for its icon, as "Call Remy"
 * and "Join" in the header and as Remy's seat on the call bar. Its label rolls over and its icon turns into the
 * next one, and its glow can follow a voice.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { RemyMark } from '../assistant/RemyMark';
import { useLevel } from '../rails/RailFaces';
import { rampTo, SPARK_PATH, throwSparks } from './spark';

const EASE = [0.22, 1, 0.36, 1] as const;

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Two small sparks that twinkle after each sweep. */
function Twinkles() {
  return (
    <>
      <svg className="talk-spark-twinkle is-first" viewBox="0 0 24 24">
        <path d={SPARK_PATH} />
      </svg>
      <svg className="talk-spark-twinkle is-second" viewBox="0 0 24 24">
        <path d={SPARK_PATH} />
      </svg>
    </>
  );
}

/** The four-point spark, lit from the top left, with two small ones that twinkle after each sweep. */
function Spark() {
  const fill = useId();
  return (
    <>
      <svg className="talk-spark-star" viewBox="0 0 24 24">
        <defs>
          <linearGradient id={fill} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="oklch(0.98 0.012 250)" />
            <stop offset="0.5" stopColor="oklch(0.88 0.07 232)" />
            <stop offset="1" stopColor="oklch(0.62 0.19 262)" />
          </linearGradient>
        </defs>
        <path fill={`url(#${fill})`} d={SPARK_PATH} />
      </svg>
      <Twinkles />
    </>
  );
}

/** What the spark button wears: the spark, Remy's mark (the spark in its ring), a microphone or Send's plane. */
export type SparkIcon = 'spark' | 'remy' | 'microphone' | 'paper-plane';

function Glyph({ icon, busy }: { icon: SparkIcon; busy: boolean }) {
  if (icon === 'spark') return <Spark />;
  if (icon === 'remy') {
    return (
      <>
        <RemyMark motion={busy ? 'work' : 'breath'} className="talk-spark-mark" />
        <Twinkles />
      </>
    );
  }
  return <i className={`fa fa-${icon}`} />;
}

/** Writes a level into the button's `--level` on every frame (only while there is one to follow). */
function FollowLevel({ target, read }: { target: RefObject<HTMLElement | null>; read(): number }) {
  useLevel(target, read);
  return null;
}

export interface SparkShellProps {
  /**
   * What its light does (talk.css reads it as `data-state`): `off` and `failed` invite a press (hover quickens the
   * light, a press throws sparks), `connecting` races a comet round the rim while someone joins, and anything else
   * is on the call, calmer.
   */
  state: string;
  icon: SparkIcon;
  text: string;
  title: string;
  onPress(): void;
  disabled?: boolean;
  /** A voice the glow follows, 0 to 1, read on every frame. */
  level?: () => number;
  /** After the label, inside the button: a count. */
  after?: ReactNode;
  /** Over the icon: Send's paper planes. */
  flying?: ReactNode;
  /** The button's name for screen readers, when the label alone doesn't say it. */
  label?: string;
  testId: string;
}

/**
 * The spark button itself: a light runs round the rim with a warm spark riding it, over a soft bloom, in 7.5 s
 * breaths (talk.css). Its label rolls over and its icon turns into the next one.
 */
export function SparkShell({ state, icon, text, title, onPress, disabled = false, level, after, flying, label, testId }: SparkShellProps) {
  const button = useRef<HTMLButtonElement>(null);
  const glyph = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const inviting = state === 'off' || state === 'failed';

  const press = () => {
    if (inviting && button.current && glyph.current && !still()) throwSparks(button.current, glyph.current);
    onPress();
  };
  // Hovering quickens the light's rhythm before the call; it eases back when the pointer leaves.
  const quicken = (rate: number) => {
    if (button.current && !still() && inviting) rampTo(button.current, rate);
  };
  const swap = reduce ? { duration: 0 } : { duration: 0.24, ease: EASE };

  return (
    <button
      ref={button}
      type="button"
      className={`talk-spark${icon === 'remy' ? ' has-mark' : ''}`}
      data-state={state}
      onClick={press}
      onPointerEnter={() => quicken(1.8)}
      onPointerLeave={() => quicken(1)}
      disabled={disabled}
      title={title}
      aria-label={label}
      data-testid={testId}
    >
      {level && <FollowLevel target={button} read={level} />}
      <span className="talk-spark-bloom" aria-hidden="true" />
      <span className="talk-spark-ring" aria-hidden="true" />
      <span className="talk-spark-face">
        <span className="talk-spark-icon" ref={glyph} aria-hidden="true">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={icon}
              className="talk-spark-glyph"
              initial={{ scale: 0.3, rotate: -50, opacity: 0 }}
              animate={{ scale: 1, rotate: 0, opacity: 1 }}
              exit={{ scale: 0.3, rotate: 50, opacity: 0 }}
              transition={swap}
            >
              <Glyph icon={icon} busy={state === 'connecting'} />
            </motion.span>
          </AnimatePresence>
          {flying}
        </span>
        <span className="talk-spark-label">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span key={text} className="talk-spark-text" initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -12, opacity: 0 }} transition={swap}>
              {text}
            </motion.span>
          </AnimatePresence>
        </span>
        {after}
      </span>
    </button>
  );
}
