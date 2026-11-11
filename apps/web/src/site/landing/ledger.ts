/**
 * "PayPal, start to finish" (`[data-ledger]` in landing.html): the money in the film, row by row. When the list
 * comes on screen the rows arrive, then each status moves on in the film's order: the tenant's invoice is sent, the
 * two payments are approved, then paid, and the hold on the chart is released. Without scripts, or under reduced
 * motion, it shows how things ended.
 */
import { prefersReducedMotion, watchVisibility } from './motion';

export function startLedger(root: ParentNode = document): void {
  const ledger = root.querySelector<HTMLElement>('[data-ledger]');
  if (!ledger || prefersReducedMotion()) return;
  const rows = [...ledger.querySelectorAll<HTMLElement>('.ledger-row')];

  /** Shows each row's status for a step: its latest pill at or before it. */
  const at = (step: number, flash: boolean) => {
    for (const row of rows) {
      const pills = [...row.querySelectorAll<HTMLElement>('.ledger-status .pill')];
      const current = pills.filter((pill) => Number(pill.dataset.step) <= step).pop();
      const changed = current !== undefined && !current.classList.contains('is-current');
      for (const pill of pills) pill.classList.toggle('is-current', pill === current);
      if (changed && flash) {
        row.classList.add('is-changed');
        requestAnimationFrame(() => requestAnimationFrame(() => row.classList.remove('is-changed')));
      }
    }
    ledger.classList.toggle('is-released', step >= 3);
  };

  // Ready, below the fold: rows waiting, statuses at the start.
  ledger.classList.add('is-waiting');
  at(0, false);

  let started = false;
  const stop = watchVisibility(ledger, (fraction) => {
    if (started || fraction < 0.45) return;
    started = true;
    stop();
    ledger.classList.remove('is-waiting');
    window.setTimeout(() => at(1, true), 1100);
    window.setTimeout(() => at(2, true), 2100);
    window.setTimeout(() => at(3, true), 3100);
  }, [0, 0.45]);
}
