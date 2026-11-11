/**
 * "Start over", in the account menu on the hosted site, asked twice: the session goes back to how it started, for
 * everyone in it. The question goes when the menu closes.
 */
import { useState } from 'react';
import '../styles/copy.css';

export const START_OVER_WARNING = 'Everything in this session goes back to how it started, for everyone in it.';

export function StartOverItem({ onStartOver }: { onStartOver(): void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" role="menuitem" className="menu-item" data-testid="menu-start-over" onClick={() => setAsking(true)}>
        <i className="fa fa-rotate-left" aria-hidden="true" /> Start over
      </button>
    );
  }
  return (
    <div className="app-user-confirm" role="group" aria-label="Start over">
      <p>{START_OVER_WARNING}</p>
      <span className="app-user-confirm-actions">
        <button type="button" className="button is-quiet is-sm" onClick={() => setAsking(false)}>
          Cancel
        </button>
        <button type="button" className="button is-primary is-sm" data-testid="menu-start-over-confirm" onClick={onStartOver}>
          Start over
        </button>
      </span>
    </div>
  );
}
