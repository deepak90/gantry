/**
 * The landing page's own script (landing.html), beside the site's (site.ts: visit counts, tracked clicks, the film):
 * - "Join with a code": a teammate's 6 digits go to /app?code=… (join-code.ts);
 * - the hero's model of Harbor going up once the footings are paid (landing/model.ts, loaded when it nears the screen);
 * - the call, Gantry drawn in code playing the film's scene (landing/scene.ts);
 * - the odds, the app's own marble tower replaying real runs (landing/odds.ts, loaded when it nears the screen);
 * - the money in the film, row by row (landing/ledger.ts).
 * Each one leaves the page as it was written if its part isn't there, and respects reduced motion.
 */
import { startJoinCodeForms } from './join-code';
import { startLedger } from './landing/ledger';
import { startModel } from './landing/model';
import { startOdds } from './landing/odds';
import { startScene } from './landing/scene';

startJoinCodeForms();
closeJoinOnEscape();
startModel();
startScene();
startOdds();
startLedger();

/** The code card closes on Escape and when someone clicks elsewhere, like a menu. */
function closeJoinOnEscape(): void {
  const joins = [...document.querySelectorAll<HTMLDetailsElement>('details.join')];
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const join of joins) {
      if (!join.open) continue;
      join.open = false;
      join.querySelector('summary')?.focus();
    }
  });
  document.addEventListener('click', (event) => {
    for (const join of joins) if (join.open && event.target instanceof Node && !join.contains(event.target)) join.open = false;
  });
}
