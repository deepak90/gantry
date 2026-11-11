/**
 * The odds panel, beside the chart ("On-time odds" in the toolbar): how likely the handover is by its date, from a
 * thousand runs of the plan on the scheduling engine; what moves it; the ways forward, each with its button; and the
 * assumptions it all rests on, on screen and editable. Two plain lines over and under the board say what was run, what
 * its percent and date mean, and the step to take (odds/odds-explain.ts). The work is the controller's
 * (odds/odds-controller.ts); this only shows it.
 *
 * The runs show on the 3D Galton board by default (odds/odds-board.ts, odds/galton/), one marble per run in its
 * handover day's bin, with a quiet Board / Dots switch for the dot plot. Both are told every run, so switching is
 * instant, and a pass's runs wait (4 s at most) for the board's physics while the board is on screen, so the first
 * marbles leave the hopper as their runs land. The odds start from the toolbar's Odds button or Remy's
 * `schedule_odds` (the board pours from empty); when PayPal pays a hold, the panel runs again by itself and the board
 * drains and refills.
 *
 * The board's API, for the walkthroughs: `oddsBoard` from src/odds/odds-board.ts. It works on the board of the open
 * panel:
 * - `oddsBoard.setHero(true)`: the board fills the chart's side at hero size, with its big number and its words
 *   (beside the piles, or over them in a narrow frame such as the chart's side beside this panel at 1600 × 900);
 *   `setHero(false)` puts it back in the panel. The panel's expand button and the board's back button do the same. `oddsBoard.hero` says which.
 * - `await oddsBoard.whenReady()`: the panel open, the board loaded, a pass begun on it and its physics ready to pour
 *   (it waits for the panel to open).
 * - `oddsBoard.onPhase((phase, at) => …)`: each phase as it is first on screen ('board', 'cascade', 'poured',
 *   'settled', 'result', 'drain', 'drained', 'compare', 'stacking', 'stacked'), with that frame's performance.now();
 *   returns a function that stops it. `oddsBoard.phase` is the last one.
 * - `oddsBoard.jumpTo('result')`: the final frame from any state (every marble in its place, the number, the words);
 *   `jumpTo('stacked')` stands every tower on its way up at once.
 * - `oddsBoard.compare()`: two boards side by side, "Wait till Friday" against "Pay today" (with "with PayPal" under
 *   it), from the panel's own runs (this answer and its pay-when-due step; after PayPal paid, the answer before and
 *   this one); false when there is no such pair yet. For its few seconds it takes over the whole of the plan's area
 *   (the task grid, the chart's side and this panel; the app's header, the toolbar, the side panels and the call bar
 *   stay), so at 1600 × 900 each board is about 630 px wide. `compare({ takeover: false })` keeps the two boards where
 *   the board is. Titles and their words are sized to their own board, the dates thin out to weeks or to the ends and
 *   the deadline's day, and no two labels ever overlap.
 * - `oddsBoard.single()`: back to one board, where it was and as it was (the same answer, the same place, the plan's
 *   area uncovered). A new pass (PayPal paid, the odds asked again), `setHero` or the board's close button do the same.
 * - `oddsBoard.stack('wait' | 'pay')`: on the side by side, that board's runs stacked as a building (the marbles lift
 *   out of the bins, earliest handover first, into ten floors of a tenth of the runs each, the deadline a floor line;
 *   on the right the band between the two lines, the runs that make it only by paying today, lit and counted); both,
 *   the left first, with no argument. Resolves true once standing. `oddsBoard.unstack()` puts the piles back,
 *   `oddsBoard.stacked` says which. The side by side's quiet building button does the same.
 */
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react';
import type { CurrencyCode } from '@collab/shared';
import { wholeMoney } from '../gantt/look';
import { DEFAULT_ASSUMPTIONS, KIND_WORDS, dayWords, monthDay, type Id, type OddsAssumptions, type OddsPlan, type WorkKind } from '../gantt/monte-carlo';
import { actionWords, type LadderStep } from '../gantt/monte-carlo-optimizer';
import { OddsPlot } from './OddsPlot';
import { preferredView, rememberView, type ChartSide, type OddsView } from './odds-board';
import type { OddsController, OddsState } from './odds-controller';
import { explainOdds } from './odds-explain';
import { assumptionWords } from './odds-summary';
import '../styles/odds.css';

export interface OddsPanelProps {
  controller: OddsController;
  canViewCosts: boolean;
  currency: CurrencyCode;
  onClose(): void;
  /** Opens a hold's payment card, where PayPal pays it. */
  onReviewPayment(gateId: Id): void;
  /** Brings a task into view on the chart. */
  onShowTask(taskId: Id): void;
  /** Where the board goes to fill the chart's side: the Gantt's frame and its chart side. */
  chartSide?: () => ChartSide | null;
}

const pct = (value: number) => (value > 0 && value < 0.01 ? (value * 100).toFixed(1) : Math.round(value * 100).toString());
const count = (value: number) => value.toLocaleString('en-US');
const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const plural = (n: number, one: string, many = `${one}s`) => `${n === 1 ? one : many}`;

function contractWords(plan: OddsPlan): string {
  const day = dayWords(plan.contractDay);
  if (plan.contractFrom === 'baseline') return `Handover by ${day}, the date first planned`;
  if (plan.contractFrom === 'plan') return `Handover by ${day}, the date in the plan`;
  return `Handover by ${day}, the contract date`;
}

export function OddsPanel({ controller, canViewCosts, currency, onClose, onReviewPayment, onShowTask, chartSide }: OddsPanelProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<OddsView>(preferredView);
  const chooseView = useCallback((next: OddsView) => {
    rememberView(next);
    setView(next);
  }, []);

  useEffect(() => {
    controller.show();
    return () => controller.hide();
  }, [controller]);

  const { plan, now, phase, progress, ladder, previewing, assumptions } = state;
  const running = phase === 'running';
  const shownStep = previewing !== null ? ladder[previewing] : null;
  const shownSimulation = shownStep?.simulation ?? (running ? null : now);
  const onTime = shownSimulation && !running ? shownSimulation.onTime : progress.onTime;
  const shown = shownSimulation && !running ? shownSimulation.runs.length : progress.shown;
  const odds = shown > 0 ? onTime / shown : 0;
  const explained = explainOdds(state, view);

  return (
    <aside className="odds-panel" aria-label="On-time odds" data-testid="odds-panel">
      <header className="panel-head odds-head">
        <div className="panel-head-icon" aria-hidden="true">
          <i className="fa fa-dice" />
        </div>
        <div className="panel-head-text">
          <h2 className="panel-head-title">On-time odds</h2>
          <p className="panel-head-sub">{plan ? contractWords(plan) : 'Running the plan on the scheduling engine'}</p>
        </div>
        <div className="panel-head-actions">
          <button type="button" className="button is-quiet is-sm is-icon" title="Run again" aria-label="Run again" disabled={running} onClick={() => controller.runAgain()} data-testid="odds-run-again">
            <i className="fa fa-rotate-right" aria-hidden="true" />
          </button>
          <button type="button" className="button is-quiet is-sm is-icon" title="Close" aria-label="Close the odds" onClick={onClose}>
            <i className="fa fa-xmark" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="odds-body">
        <section className="odds-headline" aria-live="polite" data-testid="odds-headline">
          <p className="odds-figure">
            {shown > 0 ? pct(odds) : '–'}
            <span className="odds-figure-unit">%</span>
          </p>
          <div className="odds-headline-text">
            <p className="odds-count">
              On time in <strong className="num">{count(onTime)}</strong> of <strong className="num">{count(shown)}</strong> {plural(shown, 'run')}
            </p>
            {shownSimulation ? (
              <p className="odds-spread">
                Half hand over by <strong>{monthDay(shownSimulation.p50)}</strong>, eight in ten by <strong>{monthDay(shownSimulation.p80)}</strong>
              </p>
            ) : (
              <p className="odds-spread">{view === 'board' ? 'A marble drops as each run finishes' : 'The dots land as the runs finish'}</p>
            )}
            {previewing === null && <Moved state={state} />}
          </div>
        </section>

        <Status state={state} onRunAgain={() => controller.runAgain()} />

        <OddsPlot
          controller={controller}
          contractDay={plan?.contractDay ?? null}
          shown={shown}
          onTime={onTime}
          caption={shownStep?.action ? `With every step down to ${actionWords(shownStep.action)}` : null}
          onBackToNow={() => controller.preview(null)}
          view={view}
          onView={chooseView}
          chartSide={chartSide}
          about={
            <p className="odds-explain" data-testid="odds-explain-about">
              {explained.about}
            </p>
          }
          says={
            explained.says && (
              <p className="odds-explain is-says" data-testid="odds-explain-says">
                <Figures text={explained.says} />
                {explained.step !== null && (
                  <>
                    {' '}
                    <button type="button" className="button is-link is-sm" onClick={() => controller.preview(explained.step)} data-testid="odds-explain-show">
                      Show it
                    </button>
                  </>
                )}
              </p>
            )
          }
        />

        {plan && plan.holds.length > 0 && (
          <div className="odds-pay" role="group" aria-label="How holds are paid">
            <span className="odds-pay-label">Holds paid</span>
            <div className="segmented odds-segmented">
              <button type="button" aria-pressed={assumptions.payPolicy === 'payRun'} disabled={running} onClick={() => controller.setPayPolicy('payRun')} data-testid="odds-pay-run">
                On the Friday pay run
              </button>
              <button type="button" aria-pressed={assumptions.payPolicy === 'due'} disabled={running} onClick={() => controller.setPayPolicy('due')} data-testid="odds-pay-due">
                When due
              </button>
            </div>
          </div>
        )}

        <Threats state={state} onShowTask={onShowTask} />

        <Ladder state={state} controller={controller} canViewCosts={canViewCosts} currency={currency} onReviewPayment={onReviewPayment} />

        <footer className="odds-assumptions">
          <p className="odds-assumptions-line">
            <span>{assumptionWords(plan, assumptions)}</span>
            <button type="button" className="button is-link is-sm" aria-expanded={editing} onClick={() => setEditing((value) => !value)} data-testid="odds-edit-assumptions">
              {editing ? 'Close' : 'Edit'}
            </button>
          </p>
          {editing && (
            <AssumptionsForm
              plan={plan}
              assumptions={assumptions}
              disabled={running}
              onRun={(next) => {
                setEditing(false);
                controller.setAssumptions(next);
              }}
            />
          )}
          <p className="odds-truth">
            A simulation of these assumptions, not a prediction. Each {view === 'board' ? 'marble' : 'dot'} is one run of the plan on the scheduling engine, which never changes the plan
            {state.runsPerSecond ? `; ${count(Math.round(state.runsPerSecond))} runs a second here` : ''}.
          </p>
        </footer>
      </div>
    </aside>
  );
}

/** A line with its percentages in bold, as the headline sets its figures. */
function Figures({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\d+(?:\.\d+)?%)/).map((part, index) => (index % 2 === 1 ? <strong key={index}>{part}</strong> : part))}
    </>
  );
}

/** How the odds moved since the answer before (PayPal paid, a step applied, the pay rule changed). */
function Moved({ state }: { state: OddsState }) {
  const { before, now, phase, reason } = state;
  if (!before || !now || phase === 'running') return null;
  if (before.onTime === now.onTime && before.p50 === now.p50) return null;
  const why = reason === 'paid' ? 'Before PayPal paid' : reason === 'applied' ? 'Before the Saturdays' : 'Before';
  return (
    <p className="odds-moved" data-testid="odds-moved">
      <i className="fa fa-arrow-trend-up" aria-hidden="true" /> {why}: {pct(before.odds)}%, half by {monthDay(before.p50)}
    </p>
  );
}

function Status({ state, onRunAgain }: { state: OddsState; onRunAgain(): void }) {
  const { phase, progress, searching, error, stale, now, askedAt, paidNote } = state;
  return (
    <>
      {paidNote && (
        <div className="note is-success is-sm odds-note" role="status">
          <i className="fa fa-circle-check" aria-hidden="true" />
          <span>{paidNote}</span>
        </div>
      )}
      {phase === 'running' && (
        <div className="odds-progress" role="status">
          <span>
            Running the plan on the scheduling engine: <span className="num">{count(progress.done)}</span> of <span className="num">{count(progress.total)}</span>
          </span>
          <span className="odds-progress-track">
            <span className="odds-progress-bar" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </span>
        </div>
      )}
      {phase === 'searching' && searching && (
        <div className="odds-progress is-searching" role="status">
          <span>Looking for ways forward: {searching.words}</span>
          <span className="odds-progress-track">
            <span className="odds-progress-bar" style={{ width: `${Math.round(searching.share * 100)}%` }} />
          </span>
        </div>
      )}
      {error && (
        <div className="note is-danger is-sm odds-note" role="alert">
          <i className="fa fa-circle-exclamation" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {stale && phase !== 'running' && (
        <div className="note is-info is-sm odds-note" data-testid="odds-stale">
          <i className="fa fa-circle-info" aria-hidden="true" />
          <span>
            The plan has changed since these runs{askedAt ? ` at ${TIME.format(askedAt)}` : ''}.{' '}
            <button type="button" className="button is-link is-sm" onClick={onRunAgain}>
              Run again
            </button>
          </span>
        </div>
      )}
      {now?.onCopy && askedAt && (
        <div className="note is-sm odds-note">
          <i className="fa fa-clone" aria-hidden="true" />
          <span>The plan changed while the runs were going: they answer for it as it was at {TIME.format(askedAt)}.</span>
        </div>
      )}
    </>
  );
}

function Threats({ state, onShowTask }: { state: OddsState; onShowTask(taskId: Id): void }) {
  const { threats, holds, now, plan } = state;
  if (!now || !plan) return null;
  const tasks = threats.slice(0, Math.max(1, 3 - holds.length));
  return (
    <section className="odds-section" aria-labelledby="odds-threats-title">
      <h3 className="section-label" id="odds-threats-title">
        What moves it
      </h3>
      <ul className="odds-threats" data-testid="odds-threats">
        {holds.map((hold) => (
          <li key={`hold-${String(hold.id)}`}>
            <button type="button" className="odds-threat is-hold" onClick={() => onShowTask(hold.id)} title={`Paid on the Friday pay run instead of when due: half the runs hand over ${hold.days} ${plural(hold.days, 'day')} later, eight in ten ${hold.p80Days} ${plural(hold.p80Days, 'day')} later; ${hold.points.toFixed(1)} points of odds.`}>
              <i className="fa fa-lock odds-threat-icon" aria-hidden="true" />
              <span className="odds-threat-name">{hold.name} on the Friday pay run</span>
              <span className="odds-threat-value num">
                {hold.days > 0 ? `${hold.days} ${plural(hold.days, 'day')} later` : 'no later'}
              </span>
            </button>
          </li>
        ))}
        {tasks.map((threat) => (
          <li key={`task-${String(threat.id)}`}>
            <button type="button" className="odds-threat" onClick={() => onShowTask(threat.id)} title={`The runs where ${threat.name} took longer handed over later: rank correlation ${threat.correlation.toFixed(2)} over ${count(now.runs.length)} runs.`}>
              <span className="odds-threat-name">{threat.name}</span>
              <span className="odds-threat-bar" aria-hidden="true">
                <span style={{ width: `${Math.round(threat.correlation * 100)}%` }} />
              </span>
              <span className="odds-threat-value num">{Math.round(threat.correlation * 100)}%</span>
            </button>
          </li>
        ))}
      </ul>
      {tasks.length > 0 && <p className="odds-footnote">For a task, how closely the handover follows its length across the runs.</p>}
    </section>
  );
}

function Ladder({
  state,
  controller,
  canViewCosts,
  currency,
  onReviewPayment,
}: {
  state: OddsState;
  controller: OddsController;
  canViewCosts: boolean;
  currency: CurrencyCode;
  onReviewPayment(gateId: Id): void;
}) {
  const { ladder, phase, searching, previewing, assumptions, applying, now, plan } = state;
  if (!now || !plan) return null;
  const done = phase === 'done';
  const extra = ladder.reduce((sum, step) => sum + step.costMinor, 0);
  const last = ladder.at(-1);
  return (
    <section className="odds-section" aria-labelledby="odds-ladder-title">
      <h3 className="section-label" id="odds-ladder-title">
        Ways forward
      </h3>
      {phase === 'running' && <p className="odds-footnote">The ways forward are tried once these runs are in.</p>}
      <ol className="odds-ladder" data-testid="odds-ladder">
        {ladder.map((step, index) => (
          <Rung
            key={step.action ? `${step.action.kind}-${String(step.action.id)}` : 'now'}
            step={step}
            index={index}
            previewing={previewing === index}
            payRun={assumptions.payPolicy === 'payRun'}
            premium={assumptions.saturdayPremium}
            canViewCosts={canViewCosts}
            currency={currency}
            applying={step.action !== null && applying === step.action.id}
            busy={phase === 'running' || applying !== null}
            onPreview={() => controller.preview(previewing === index ? null : index)}
            onReviewPayment={onReviewPayment}
            onApply={() => void controller.apply(step)}
          />
        ))}
        {phase === 'searching' && (
          <li className="odds-rung is-pending" aria-live="polite">
            <span className="odds-rung-mark" aria-hidden="true" />
            <span className="odds-rung-text">
              <strong>{searching?.words ? searching.words.replace(/^(Trying|Checking) /, '') : 'Looking'}</strong>
              <span>Trying it on the engine…</span>
            </span>
          </li>
        )}
      </ol>
      {done && last && ladder.length > 1 && (
        <p className="odds-footnote" data-testid="odds-ladder-total">
          With every step: {pct(last.simulation.odds)}% on time
          {canViewCosts && extra > 0 ? `, ${wholeMoney(extra, currency)} more in Saturday premiums` : ''}.
          {last.simulation.odds < 0.8 ? ' Nothing else on the list raises the odds.' : ''}
        </p>
      )}
      {done && ladder.length <= 1 && <p className="odds-footnote">Nothing on the list raises the odds: no hold to pay sooner and no Saturdays that help.</p>}
    </section>
  );
}

interface RungProps {
  step: LadderStep;
  index: number;
  previewing: boolean;
  payRun: boolean;
  premium: number;
  canViewCosts: boolean;
  currency: CurrencyCode;
  applying: boolean;
  busy: boolean;
  onPreview(): void;
  onReviewPayment(gateId: Id): void;
  onApply(): void;
}

function Rung({ step, index, previewing, payRun, premium, canViewCosts, currency, applying, busy, onPreview, onReviewPayment, onApply }: RungProps) {
  const { action, simulation } = step;
  let title: string;
  let detail: string;
  if (!action) {
    title = 'Now';
    detail = `${payRun ? 'Holds paid on the Friday pay run' : 'Holds paid when due'} · half by ${monthDay(simulation.p50)}`;
  } else if (action.kind === 'pay') {
    title = actionWords(action);
    detail = `${action.hold.dueDay !== null ? `Due ${dayWords(action.hold.dueDay)} · ` : ''}with PayPal, nothing extra · half by ${monthDay(simulation.p50)}`;
  } else {
    title = actionWords(action);
    const saturdays = Math.round(step.saturdays);
    detail = `About ${saturdays} ${plural(saturdays, 'Saturday')} at ${premium}×${canViewCosts ? ` · ${wholeMoney(step.costMinor, currency)} more` : ''} · half by ${monthDay(simulation.p50)}`;
  }
  return (
    <li className={`odds-rung${index === 0 ? ' is-now' : ''}${previewing ? ' is-previewing' : ''}`} data-testid={`odds-rung-${index}`}>
      <button type="button" className="odds-rung-main" aria-pressed={previewing} onClick={onPreview} title={index === 0 ? 'Show the runs as the plan stands' : 'Show these runs on the plot'}>
        <span className="odds-rung-mark" aria-hidden="true" />
        <span className="odds-rung-text">
          <strong>{title}</strong>
          <span>{detail}</span>
        </span>
        <span className="odds-rung-odds num">{pct(simulation.odds)}%</span>
      </button>
      {action?.kind === 'pay' && (
        <button type="button" className="button is-sm odds-rung-action" onClick={() => onReviewPayment(action.id)} data-testid="odds-review-payment">
          Review payment
        </button>
      )}
      {action?.kind === 'saturdays' && (
        <button type="button" className="button is-sm odds-rung-action" disabled={busy} onClick={onApply} data-testid="odds-apply">
          {applying ? 'Applying…' : 'Apply'}
        </button>
      )}
    </li>
  );
}

function AssumptionsForm({ plan, assumptions, disabled, onRun }: { plan: OddsPlan | null; assumptions: OddsAssumptions; disabled: boolean; onRun(next: OddsAssumptions): void }) {
  const id = useId();
  const [draft, setDraft] = useState<OddsAssumptions>(assumptions);
  const kinds: WorkKind[] = plan?.kinds.length ? plan.kinds : ['winter', 'outdoor', 'indoor', 'inspection'];
  const setRange = (kind: WorkKind, point: 'low' | 'likely' | 'high', percent: number) =>
    setDraft((current) => ({ ...current, ranges: { ...current.ranges, [kind]: { ...current.ranges[kind], [point]: percent / 100 } } }));
  const valid =
    kinds.every((kind) => {
      const range = draft.ranges[kind];
      return range.low > 0 && range.low <= range.likely && range.likely <= range.high && range.high <= 4;
    }) &&
    draft.runs >= 50 &&
    draft.runs <= 5000 &&
    draft.saturdayPremium >= 1 &&
    draft.saturdayPremium <= 3 &&
    draft.hourlyRate > 0 &&
    draft.hourlyRate <= 500;
  return (
    <form
      className="odds-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onRun({ ...draft, runs: Math.round(draft.runs), seed: Math.round(draft.seed) });
      }}
    >
      <table className="odds-form-ranges">
        <thead>
          <tr>
            <th scope="col">Length, as a share of the plan</th>
            <th scope="col">Shortest</th>
            <th scope="col">Likely</th>
            <th scope="col">Longest</th>
          </tr>
        </thead>
        <tbody>
          {kinds.map((kind) => (
            <tr key={kind}>
              <th scope="row">{KIND_WORDS[kind]}</th>
              {(['low', 'likely', 'high'] as const).map((point) => (
                <td key={point}>
                  <label className="odds-form-percent">
                    <input
                      className="input is-sm num"
                      type="number"
                      min={10}
                      max={400}
                      step={5}
                      value={Math.round(draft.ranges[kind][point] * 100)}
                      aria-label={`${KIND_WORDS[kind]}, ${point === 'low' ? 'shortest' : point === 'likely' ? 'most likely' : 'longest'} (% of the planned length)`}
                      onChange={(event) => setRange(kind, point, Number(event.target.value))}
                    />
                    <span aria-hidden="true">%</span>
                  </label>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="odds-form-row">
        <label className="field" htmlFor={`${id}-premium`}>
          <span className="field-label">Saturday cost</span>
          <span className="odds-form-unit">
            <input id={`${id}-premium`} className="input is-sm num" type="number" min={1} max={3} step={0.25} value={draft.saturdayPremium} onChange={(event) => setDraft({ ...draft, saturdayPremium: Number(event.target.value) })} />
            <span>× a weekday</span>
          </span>
        </label>
        <label className="field" htmlFor={`${id}-rate`}>
          <span className="field-label">A crew hour, loaded</span>
          <span className="odds-form-unit">
            <span aria-hidden="true">$</span>
            <input id={`${id}-rate`} className="input is-sm num" type="number" min={1} max={500} step={1} value={draft.hourlyRate} onChange={(event) => setDraft({ ...draft, hourlyRate: Number(event.target.value) })} />
          </span>
        </label>
        <label className="field" htmlFor={`${id}-runs`}>
          <span className="field-label">Runs</span>
          <input id={`${id}-runs`} className="input is-sm num" type="number" min={50} max={5000} step={50} value={draft.runs} onChange={(event) => setDraft({ ...draft, runs: Number(event.target.value) })} />
        </label>
        <label className="field" htmlFor={`${id}-seed`}>
          <span className="field-label">Seed</span>
          <span className="odds-form-unit">
            <input id={`${id}-seed`} className="input is-sm num" type="number" step={1} value={draft.seed} onChange={(event) => setDraft({ ...draft, seed: Number(event.target.value) })} />
            <button type="button" className="button is-quiet is-sm is-icon" title="Another seed" aria-label="Another seed" onClick={() => setDraft({ ...draft, seed: Math.floor(Math.random() * 9000) + 1 })}>
              <i className="fa fa-shuffle" aria-hidden="true" />
            </button>
          </span>
        </label>
      </div>
      <p className="odds-footnote">
        A Saturday costs the premium on each person’s eight hours (the plan’s headcount, or the usual crew for the trade); materials cost the same on any
        day. The same seed rolls the same dice: the same assumptions give the same answer, run after run.
      </p>
      <div className="odds-form-actions">
        <button type="submit" className="button is-primary is-sm" disabled={disabled || !valid}>
          Run
        </button>
        <button type="button" className="button is-sm" onClick={() => setDraft({ ...DEFAULT_ASSUMPTIONS, payPolicy: draft.payPolicy })}>
          Defaults
        </button>
      </div>
    </form>
  );
}
