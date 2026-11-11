/**
 * The cards the assistant draws (its "generative UI"): the model picks a card and fills in its
 * fields through a tool call; the agent service checks every field (amounts and dates must come from
 * its own calculations) before the card is stored; these components draw them. While the model is
 * still writing a card, the same components draw what has arrived so far.
 *
 * Amounts arrive as decimal text ("2400.00") and are shown with the app's money formatting, or
 * masked for people who cannot see costs. Buttons act for the person looking, under their own login.
 */
import type { ReactNode } from 'react';
import { format, fromDecimalString, type CurrencyCode, type StoredIssueCard as IssueCardProps, type Choices as ChoicesProps } from '@collab/shared';
import { formatDay } from '../workflow/model';
import { withheldText } from './rich-text';
import { RemyMark } from './RemyMark';

export interface CardEnv {
  currency: CurrencyCode;
  canViewCosts: boolean;
  /** Only the newest card of a kind takes clicks; older ones stay in the thread, quieter. */
  active: boolean;
  /** Still being written by the model: fields may be missing. */
  partial: boolean;
}

/** `"2400.00"` → `$2,400.00` (or masked). */
export function amount(text: unknown, env: Pick<CardEnv, 'currency' | 'canViewCosts'>): string {
  if (!env.canViewCosts) return '•••';
  if (typeof text !== 'string') return '…';
  try {
    return format(fromDecimalString(text, env.currency));
  } catch {
    return '…';
  }
}

const day = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDay(value).replace(/, \d{4}$/, '') : '…');

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Every calendar day from `from` to `to`, inclusive (at most 40). */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let current = from; current <= to && out.length < 40; current = addDays(current, 1)) out.push(current);
  return out;
}

const WEEKEND = new Set([0, 6]);
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** `tone` colors the kicker for a card that flags trouble (red only when it needs attention now). */
export function CardShell({ kind, icon, kicker, tone, children, env, testId }: { kind: string; icon: string; kicker: string; tone?: 'danger' | 'warning'; children: ReactNode; env: CardEnv; testId: string }) {
  return (
    <article className={`card ac-card ac-${kind}${env.active ? '' : ' is-old'}${env.partial ? ' is-partial' : ''}`} data-testid={testId}>
      <p className={`ac-kicker${tone ? ` is-${tone}` : ''}`}>
        <i className={`fa fa-${icon}`} aria-hidden="true" />
        {kicker}
      </p>
      {children}
    </article>
  );
}

// -----------------------------------------------------------------------------------------
// Issue
// -----------------------------------------------------------------------------------------

/** A card's title: when the card is about tasks, it shows them. */
function CardTitle({ title, onShow }: { title: ReactNode; onShow?: (() => void) | undefined }) {
  return <h4 className="ac-title">{onShow ? <button type="button" className="ac-title-link" title="Show in the plan" data-testid="assistant-card-show" onClick={onShow}>{title}</button> : title}</h4>;
}

export function IssueCardView({ card, env, onAction, onShow }: { card: Partial<IssueCardProps>; env: CardEnv; onAction(kind: 'prepare_fix' | 'not_now', label: string): void; onShow?: () => void }) {
  const timeline = card.timeline ?? null;
  const days = timeline?.rental_from && timeline.rental_last_day ? daysBetween(timeline.rental_from, timeline.rental_last_day) : [];
  return (
    <CardShell kind="issue" icon="triangle-exclamation" kicker={card.severity === 'high' ? 'Needs attention' : 'Worth a look'} tone={card.severity === 'high' ? 'danger' : 'warning'} env={env} testId="assistant-issue-card">
      <CardTitle title={card.headline ?? <span className="ac-skeleton" />} onShow={onShow} />
      {card.detail && <p className="ac-text">{withheldText(card.detail)}</p>}
      {card.money && (
        <p className="ac-money is-alert">
          <span>{card.money.label}</span>
          <strong>{amount(card.money.amount, env)}</strong>
        </p>
      )}
      {timeline && days.length > 0 && (
        <figure className="ac-strip" aria-label={`${timeline.label}: paid from ${day(timeline.rental_from)}, work starts ${day(timeline.work_starts)}`}>
          <figcaption>{timeline.label}</figcaption>
          <ol>
            {days.map((iso) => {
              const idle = timeline.work_starts ? iso < timeline.work_starts || iso > timeline.work_last_day : false;
              return (
                <li key={iso} className={`${idle ? 'is-idle' : 'is-work'}${WEEKEND.has(weekday(iso)) ? ' is-weekend' : ''}${iso === timeline.work_starts ? ' is-start' : ''}`} title={formatDay(iso)}>
                  <span>{Number(iso.slice(8))}</span>
                </li>
              );
            })}
          </ol>
          <p className="ac-strip-legend">
            <span className="is-idle" /> paid, nothing to do <span className="is-work" /> work under way
          </p>
        </figure>
      )}
      {card.facts && card.facts.length > 0 && (
        <dl className="ac-facts">
          {card.facts.map((fact, index) => (
            <div key={`${fact.label}:${index}`}>
              <dt>{fact.label}</dt>
              <dd>{/\$|\d+\.\d\d/.test(fact.value ?? '') && !env.canViewCosts ? '•••' : withheldText(fact.value ?? '')}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.remedy && (
        <p className="note ac-remedy">
          <i className="fa fa-lightbulb" aria-hidden="true" /> {env.canViewCosts ? withheldText(card.remedy) : card.remedy.replace(/\$[\d,]+(\.\d\d)?/g, '•••')}
        </p>
      )}
      {card.actions && card.actions.length > 0 && !env.partial && (
        <div className="ac-actions">
          {card.actions.map((action) => (
            <button
              key={action.kind}
              type="button"
              className={action.kind === 'prepare_fix' ? 'button is-primary' : 'button'}
              disabled={!env.active}
              data-testid={`assistant-action-${action.kind}`}
              onClick={() => onAction(action.kind, action.label)}
            >
              {action.kind === 'prepare_fix' && <RemyMark motion="still" className="remy-inline" />} {action.label}
            </button>
          ))}
        </div>
      )}
    </CardShell>
  );
}

// -----------------------------------------------------------------------------------------
// Choices
// -----------------------------------------------------------------------------------------

export function ChoicesView({ card, env, onPick }: { card: Partial<ChoicesProps>; env: CardEnv; onPick(reply: string): void }) {
  return (
    <CardShell kind="choices" icon="circle-question" kicker="Quick answer" env={env} testId="assistant-choices">
      {card.question && <p className="ac-question">{card.question}</p>}
      <div className="ac-choices">
        {(card.choices ?? []).map((choice, index) => (
          <button key={`${choice.label}:${index}`} type="button" className="button" disabled={!env.active || env.partial || !choice.reply} onClick={() => choice.reply && onPick(choice.reply)}>
            {choice.label}
          </button>
        ))}
      </div>
    </CardShell>
  );
}
