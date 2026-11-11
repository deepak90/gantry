/**
 * Remy's minutes for the session as an orb: filled with her cobalt to what's left of the five minutes, its surface
 * moving while a call runs them down, amber in the last thirty seconds, empty once they're used up. In the header before
 * a call (`RemyMinutesChip`: the orb and "4:12 left", or "No Remy minutes left"), and on the call bar during one
 * (CallStrip's CallClock). The numbers are the site's (call/minutes.ts).
 */
import { useEffect, useId, useState } from 'react';
import { formatMinutes, fullnessOf, minutesLeftAt, minutesSpent, minutesTitle, MINUTES_ENDING_MS, SPENT_TEXT, spentTitle, spokenDuration, type HeardMinutes } from './minutes';

/** The liquid's surface: a wave two periods wider than the orb each side, so it can slide a period and still cover it. */
const SURFACE = 'M-12 2.75 q3 -1.6 6 0 t6 0 t6 0 t6 0 t6 0 t6 0 t6 0 t6 0 V 26 H -12 Z';
/** How far the surface drops from full (at the inside's top, 2.75) to empty (below its bottom, 21.25), in the 24-unit box. */
const DROP = 19.5;

export interface RemyOrbProps {
  /** 0 to 1: how full. */
  fullness: number;
  /** A call is running the minutes down: the surface moves. */
  draining: boolean;
  /** The last thirty seconds: amber. */
  ending: boolean;
}

export function RemyOrb({ fullness, draining, ending }: RemyOrbProps) {
  const id = `orb-${useId().replace(/[^\w-]/g, '')}`;
  const empty = fullness <= 0;
  const level = (1 - Math.min(1, Math.max(0, fullness))) * DROP;
  const classes = ['remy-orb', draining && !empty ? 'is-draining' : '', ending && !empty ? 'is-ending' : '', empty ? 'is-empty' : ''].filter(Boolean).join(' ');
  return (
    <svg className={classes} viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-fullness={fullness.toFixed(3)}>
      <defs>
        <clipPath id={`${id}-in`}>
          <circle cx="12" cy="12" r="9.25" />
        </clipPath>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="remy-orb-top" />
          <stop offset="1" className="remy-orb-deep" />
        </linearGradient>
      </defs>
      <circle className="remy-orb-well" cx="12" cy="12" r="9.25" />
      {!empty && (
        <g clipPath={`url(#${id}-in)`}>
          <g className="remy-orb-level" style={{ transform: `translateY(${level.toFixed(2)}px)` }}>
            <path className="remy-orb-liquid" d={SURFACE} fill={`url(#${id}-fill)`} />
          </g>
        </g>
      )}
      <circle className="remy-orb-rim" cx="12" cy="12" r="10.25" />
      <ellipse className="remy-orb-shine" cx="8.4" cy="7.6" rx="2.5" ry="1.5" transform="rotate(-35 8.4 7.6)" />
    </svg>
  );
}

/** This tab's clock, read once a second while `running`; still otherwise. */
export function useSecondsNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!running) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

/**
 * Before a call, in the header: the orb and what's left ("4:12 left"), running down while someone else's call with
 * Remy goes on; once they're used up, the empty orb and "No Remy minutes left", in place of the call button.
 */
export function RemyMinutesChip({ minutes }: { minutes: HeardMinutes }) {
  const now = useSecondsNow(minutes.going);
  const left = minutesLeftAt(minutes, now);
  const spent = minutesSpent(minutes);
  const title = spent ? spentTitle(minutes.totalMs) : minutesTitle(left, minutes.totalMs, minutes.going);
  return (
    <span
      className={`remy-minutes${spent ? ' is-spent' : ''}`}
      title={title}
      role={spent ? 'status' : undefined}
      aria-label={spent ? SPENT_TEXT : `${spokenDuration(left)} of Remy's time left for this session`}
      data-testid="remy-minutes"
      data-left-s={Math.ceil(left / 1000)}
      data-spent={spent}
    >
      <RemyOrb fullness={spent ? 0 : fullnessOf(left, minutes.totalMs)} draining={minutes.going && left > 0} ending={minutes.going && left <= MINUTES_ENDING_MS} />
      <span className="remy-minutes-text" aria-hidden="true">
        {spent ? SPENT_TEXT : `${formatMinutes(left)} left`}
      </span>
    </span>
  );
}
