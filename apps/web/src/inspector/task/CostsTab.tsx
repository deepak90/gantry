/**
 * Costs (cost viewers only), laid out like a cost statement: budget against forecast with the
 * variance, what has been spent and paid, and what remains; the budget and forecast themselves,
 * edited here and saved one field at a time; who is paid for the task and when (its cost lines, from
 * a library piece); and, for a task with rented equipment, the rental
 * and every PayPal payment made for it with the receipt filed for each. Amounts are shown in full
 * (dollars and cents): these are the figures people sign off.
 */
import { DateHelper } from '@bryntum/gantt';
import { BryntumNumberField } from '@bryntum/gantt-react';
import { COST_DUE_WORDS, format, money, payablesByPayee, type CurrencyCode, type PayableState } from '@collab/shared';
import { when } from '../../editor/ui';
import { setTaskMoney } from './apply';
import type { TaskView } from './model';
import type { PaymentLine, TaskPaymentFacts } from './payments';
import { Notice, PAYPAL_MARK, Pill, Section, plural, useLatest, usePanel } from './ui';
import '../../styles/costs-tab.css';
import { ASSISTANT_NAME } from '../../assistant/identity';
import { planClock } from '../../plan-clock';

export interface CostsTabProps {
  view: TaskView;
  payments: TaskPaymentFacts | null;
  onOpenRentals?: () => void;
  /** Opens a filed document (a payment receipt) in a new tab. */
  onOpenDocument?: (documentId: string) => void;
}

const toMinor = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null);
const full = (minor: number, currency: CurrencyCode) => format(money(minor, currency));

export function CostsTab({ view, payments, onOpenRentals, onOpenDocument }: CostsTabProps) {
  const { project, run, currency } = usePanel();
  const { money: costs } = view;
  const variance = costs.expected - costs.budget;
  const variancePct = costs.budget > 0 ? Math.abs(variance / costs.budget) * 100 : null;
  const remaining = Math.max(0, costs.expected - costs.spent);
  const scale = Math.max(costs.budget, costs.expected, costs.spent, 1);
  const pct = (minor: number) => `${Math.min(100, (minor / scale) * 100).toFixed(1)}%`;
  const handlers = useLatest({
    budget: ({ value, userAction }: { value: unknown; userAction?: boolean }) => {
      const minor = toMinor(value);
      if (userAction && minor !== null) void run(() => setTaskMoney(project, view.id, { budgetMinor: minor }));
    },
    forecast: ({ value, userAction }: { value: unknown; userAction?: boolean }) => {
      const minor = toMinor(value);
      if (userAction && minor !== null) void run(() => setTaskMoney(project, view.id, { forecastMinor: minor }));
    },
  });

  return (
    <div className="ti-tab-body" data-testid="task-money">
      <section className="card cs-statement" aria-label="Cost summary" data-testid="cost-statement">
        <dl className="cs-head">
          <div>
            <dt>Budget</dt>
            <dd>{full(costs.budget, currency)}</dd>
          </div>
          <div>
            <dt>Forecast</dt>
            <dd>{full(costs.expected, currency)}</dd>
          </div>
          <div>
            <dt>Variance</dt>
            <dd data-testid="cost-variance">
              {variance === 0 ? 'On budget' : `${full(Math.abs(variance), currency)} ${variance > 0 ? 'over' : 'under'}`}
              {variancePct !== null && variance !== 0 && <small>{variancePct < 0.1 ? '<0.1' : variancePct.toFixed(1)}%</small>}
            </dd>
          </div>
        </dl>
        <div className="cs-bar" role="img" aria-label={`${full(costs.spent, currency)} spent and ${full(costs.paid, currency)} paid of a ${full(costs.expected, currency)} forecast`}>
          <span className="cs-bar-forecast" style={{ width: pct(costs.expected) }} />
          <span className="cs-bar-spent" style={{ width: pct(costs.spent) }} />
          <span className="cs-bar-paid" style={{ width: pct(costs.paid) }} />
          {costs.budget > 0 && <span className="cs-bar-budget" style={{ left: pct(costs.budget) }} title={`Budget ${full(costs.budget, currency)}`} />}
        </div>
        <dl className="cs-lines">
          <div>
            <dt>
              <span className="cs-key is-spent" aria-hidden="true" /> Spent to date
            </dt>
            <dd>{full(costs.spent, currency)}</dd>
          </div>
          <div>
            <dt>
              <span className="cs-key is-paid" aria-hidden="true" /> Paid out
            </dt>
            <dd>{full(costs.paid, currency)}</dd>
          </div>
          <div>
            <dt>
              <span className="cs-key is-left" aria-hidden="true" /> Still to spend
            </dt>
            <dd>{full(remaining, currency)}</dd>
          </div>
        </dl>
        {view.costCode && (
          <p className="cs-code">
            Cost code <code>{view.costCode}</code>
          </p>
        )}
      </section>

      {view.isPhase ? (
        <Notice icon="layer-group">A phase adds up the costs of the tasks inside it. Change those tasks' budgets and forecasts.</Notice>
      ) : (
        <Section title="Budget and forecast" aside="saved as you type">
          <div className="ti-grid">
            <div className="field ti-row">
              <span className="field-label">Budget ({currency})</span>
              <BryntumNumberField
                cls="ti-field cs-amount"
                ariaLabel={`Budget in ${currency}`}
                min={0}
                step={100}
                changeOnSpin={500}
                format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 } as never}
                value={costs.budget / 100}
                onChange={(event: { value: unknown; userAction?: boolean }) => handlers.current.budget(event)}
              />
            </div>
            <div className="field ti-row">
              <span className="field-label">Forecast ({currency})</span>
              <BryntumNumberField
                cls="ti-field cs-amount"
                ariaLabel={`Forecast final cost in ${currency}`}
                min={0}
                step={100}
                changeOnSpin={500}
                format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 } as never}
                value={costs.expected / 100}
                onChange={(event: { value: unknown; userAction?: boolean }) => handlers.current.forecast(event)}
              />
            </div>
          </div>
          <p className="field-hint">The forecast is what this task is now expected to cost in total. Spent and paid come from the work done and from payments.</p>
        </Section>
      )}

      {view.costLines.length > 0 && <CostLinesSection view={view} />}

      {payments ? (
        <>
          <RentalSection payments={payments} onOpenRentals={onOpenRentals} />
          <LedgerSection lines={payments.ledger} onOpenDocument={onOpenDocument} />
        </>
      ) : (
        !view.isPhase && <p className="ti-empty-line">No equipment rental or payment is tied to this task.</p>
      )}
    </div>
  );
}

const LINE_STATES: Record<PayableState, { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
  paid: { label: 'Paid', tone: 'ok' },
  due: { label: 'Due now', tone: 'warn' },
  upcoming: { label: 'Later', tone: 'neutral' },
};

/** Who is paid for this task, how much and when (its cost lines), with what is due now. */
function CostLinesSection({ view }: { view: TaskView }) {
  const { currency } = usePanel();
  const day = (date: Date | null) => (date ? DateHelper.format(date, 'YYYY-MM-DD') : null);
  const lines = payablesByPayee(
    [{ id: view.id, name: view.name, startDate: day(view.start), endDate: day(view.end), percentDone: view.progress, costLines: view.costLines }],
    DateHelper.format(planClock.now(), 'YYYY-MM-DD'),
  ).flatMap((payee) => payee.lines);
  const total = view.costLines.reduce((sum, line) => sum + line.amount_minor, 0);
  return (
    <Section title="Who is paid" aside={full(total, currency)} testId="task-cost-lines">
      <ul className="cs-lines">
        {lines
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((line) => (
            <li key={line.index} className="cs-line">
              <span className="cs-line-what">
                <strong>{line.label}</strong>
                <span>
                  {line.payee} · {COST_DUE_WORDS[line.due]}
                </span>
              </span>
              <span className="cs-line-amount num">{full(line.amountMinor, currency)}</span>
              <Pill tone={LINE_STATES[line.state].tone}>{LINE_STATES[line.state].label}</Pill>
            </li>
          ))}
      </ul>
      <p className="field-hint">From the library piece this task came from. {ASSISTANT_NAME} adds these up across the plan when you ask who needs to be paid.</p>
    </Section>
  );
}

function RentalSection({ payments, onOpenRentals }: { payments: TaskPaymentFacts; onOpenRentals?: () => void }) {
  const { currency } = usePanel();
  const { rental } = payments;
  return (
    <Section
      title="Equipment rental"
      testId="task-payments"
      aside={
        onOpenRentals ? (
          <button type="button" className="button is-link" onClick={onOpenRentals}>
            All rentals <i className="fa fa-arrow-right" aria-hidden="true" />
          </button>
        ) : undefined
      }
    >
      <dl className="ti-facts ti-facts-list cs-facts">
        <div>
          <dt>Supplier</dt>
          <dd>{rental.supplier}</dd>
        </div>
        <div>
          <dt>Day rate</dt>
          <dd className="cs-num">{full(rental.rateMinor, currency)} a day, every day on rent</dd>
        </div>
        <div>
          <dt>Booked</dt>
          <dd>
            {rental.from} – {rental.until}
          </dd>
        </div>
      </dl>
    </Section>
  );
}

function LedgerSection({ lines, onOpenDocument }: { lines: PaymentLine[]; onOpenDocument?: (documentId: string) => void }) {
  const { currency } = usePanel();
  return (
    <Section title="Payments" aside={<Pill tone="neutral">PayPal sandbox</Pill>} testId="task-payment">
      {lines.length === 0 ? (
        <p className="ti-empty-line">No payments yet.</p>
      ) : (
        <ul className="cs-ledger" data-testid="payment-ledger">
          {lines.map((line) => (
            <li key={line.id} className={`is-${line.tone}`}>
              <div className="cs-ledger-main">
                <span className="cs-ledger-payee">
                  <img className="paypal-mark" src={PAYPAL_MARK} alt="" aria-hidden="true" />
                  {line.payee}
                  {line.versionNo !== null && <small> · fix version {line.versionNo}</small>}
                </span>
                <strong className="cs-num">{full(line.amountMinor, currency)}</strong>
              </div>
              <div className="cs-ledger-meta">
                <Pill tone={line.tone}>{line.label}</Pill>
                <span>{when(line.at)}</span>
                {line.feeMinor !== null && <span className="cs-num">PayPal fee {full(line.feeMinor, currency)}</span>}
                {line.reference && (
                  <span>
                    Ref <code>{line.reference}</code>
                  </span>
                )}
              </div>
              {line.message && line.status !== 'succeeded' && <p className={line.status === 'failed' ? 'ti-error-text' : 'ti-muted'}>PayPal: {line.message}</p>}
              {line.receiptId && onOpenDocument && (
                <button type="button" className="button is-link cs-receipt" onClick={() => onOpenDocument(line.receiptId!)}>
                  <i className="fa fa-file-pdf" aria-hidden="true" /> Payment receipt
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
