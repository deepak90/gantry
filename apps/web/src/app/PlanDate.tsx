/**
 * "Plan date: Tue, Nov 10, 2026", in the header, on a build whose plan date is pinned (plan-clock.ts): the hosted
 * site runs on the film's day, and VITE_PLAN_DATE pins a local build. Pressed, it says why in plain words, and that
 * the times on messages, calls and payments are real. On the real clock there is nothing to say, so nothing shows.
 */
import { useRef, useState } from 'react';
import { FILM_DAY, planClock, planDayLabel } from '../plan-clock';
import { useDismiss } from './useDismiss';

/** What the plan date means, in the words the header's card uses. */
export function planDateWords(day: string): string {
  const why = day === FILM_DAY ? 'This demo runs on the film’s day, so the forecast and the odds match the film.' : `This build treats ${planDayLabel(day)} as today for the plan.`;
  return `${why} Times on messages, calls and payments are real.`;
}

export function PlanDate({ day = planClock.pinned }: { day?: string | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, root, () => setOpen(false));
  if (!day) return null;
  const label = planDayLabel(day);
  const words = planDateWords(day);
  return (
    <div className="plan-date" ref={root}>
      <button
        type="button"
        className={`plan-date-button${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Plan date: ${label}`}
        title={words}
        onClick={() => setOpen((value) => !value)}
        data-testid="plan-date"
      >
        <i className="fa fa-calendar-day" aria-hidden="true" />
        <span className="plan-date-long">Plan date: {label}</span>
        {/* A narrower header has room for "Nov 10"; the card and the tooltip keep the whole date. */}
        <span className="plan-date-short">Plan date: {planDayLabel(day, 'short')}</span>
      </button>
      {open && (
        <div className="popover plan-date-card" role="dialog" aria-label="Plan date" data-testid="plan-date-card">
          <p className="plan-date-title">Plan date: {label}</p>
          <p className="plan-date-words">{words}</p>
        </div>
      )}
    </div>
  );
}
