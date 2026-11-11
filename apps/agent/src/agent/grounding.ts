/**
 * Grounding for generative UI: a card may only show money and dates that a tool computed. The model
 * chooses what to show and how to word it; it cannot put a number on screen the cost math did not
 * produce. A failed check goes back to the model as a tool error so it can correct the card in the
 * same turn, and no browser ever shows the rejected card.
 */
import { fromDecimalString, type HowToClip, type UiComponentName } from '@collab/shared';
import type { Issue } from '../plan/detectors';
import { checkHowTo } from './how-to';

export interface GroundingContext {
  issues: ReadonlyMap<string, Issue>;
  /** Every amount (minor units) any tool returned in the conversation. */
  knownMinor: ReadonlySet<number>;
  /** Ids of the tasks in the plan. */
  taskIds?: ReadonlySet<number>;
  /** Plan edits drafted in this conversation (draft_plan_edit), by edit_id. */
  edits?: ReadonlySet<string>;
  /** Snippet drafts made in this conversation (draft_snippet, find_repeating_work), by draft_id. */
  drafts?: ReadonlySet<string>;
  /** Invoices drafted for changes in this conversation (draft_change_invoice), by invoice_id. */
  invoices?: ReadonlySet<string>;
  /** The how-to clips that exist (apps/web/public/clips/clips.json). */
  clips?: readonly HowToClip[];
}

function checkTasks(ids: readonly number[], ctx: GroundingContext, where: string): string[] {
  return ids.filter((id) => !ctx.taskIds?.has(id)).map((id) => `${where}: there is no task ${id} in the plan`);
}

export function minorValues(value: unknown, out = new Set<number>()): Set<number> {
  if (Array.isArray(value)) {
    for (const item of value) minorValues(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'number' && Number.isSafeInteger(item) && /_minor$/.test(key)) out.add(item);
      else minorValues(item, out);
    }
  }
  return out;
}

export function dateValues(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) out.add(value);
  else if (Array.isArray(value)) for (const item of value) dateValues(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) dateValues(item, out);
  return out;
}

const toMinor = (text: string): number => fromDecimalString(text, 'USD').minor;
const asDecimal = (minor: number): string => (minor / 100).toFixed(2);

/** Dollar amounts written in free text ("$2,400", "$1,200.00"), in minor units. */
export function amountsInText(text: string): number[] {
  return [...text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g)].map((match) => toMinor(`${match[1]!.replace(/,/g, '')}.${match[2] ?? '00'}`));
}

/**
 * Amounts in `text` that no tool computed. Zero needs no source ("$0 left to pay"); text carries no
 * sign, so a negative amount grounds its size ("costs $600 more" for a saving of -600.00).
 */
export function ungroundedAmounts(text: string, allowed: ReadonlySet<number>): number[] {
  return amountsInText(text).filter((amount) => amount !== 0 && !allowed.has(amount) && !allowed.has(-amount));
}

function checkText(texts: (string | null | undefined)[], allowed: ReadonlySet<number>, where: string): string[] {
  return texts
    .filter((text): text is string => typeof text === 'string')
    .flatMap((text) => ungroundedAmounts(text, allowed))
    .map((amount) => `${where}: $${asDecimal(amount)} in the text is not an amount the tools computed`);
}

/** Card amounts must be amounts the tools computed; an extra cost may be shown as the size of a negative saving. */
function checkMoney(amounts: string[], allowed: ReadonlySet<number>, where: string): string[] {
  return amounts
    .filter((amount) => !allowed.has(toMinor(amount)) && !allowed.has(-toMinor(amount)))
    .map((amount) => `${where}: ${amount} is not an amount the tools computed (allowed: ${[...allowed].map(asDecimal).join(', ')})`);
}

function checkDates(dates: string[], allowed: ReadonlySet<string>, where: string): string[] {
  return dates.filter((value) => !allowed.has(value)).map((value) => `${where}: ${value} is not a date from the tool results`);
}

/** Problems with a validated card; empty means it may be shown. */
export function groundCard(component: UiComponentName, props: Record<string, any>, ctx: GroundingContext): string[] {
  switch (component) {
    case 'show_issue_card': {
      const issue = ctx.issues.get(props.issue_id);
      if (!issue) return [`issue_id ${props.issue_id} was not returned by find_issues (or the event)`];
      const money = new Set<number>([...minorValues(issue), ...ctx.knownMinor]);
      return [
        ...checkText([props.headline, props.detail, props.remedy, ...props.facts.map((fact: { value: string }) => fact.value)], money, 'text'),
        ...(props.money ? checkMoney([props.money.amount], money, 'money') : []),
        ...(props.timeline ? checkDates([props.timeline.rental_from, props.timeline.work_starts, props.timeline.work_last_day, props.timeline.rental_last_day], dateValues(issue), 'timeline') : []),
      ];
    }
    case 'show_choices':
      return checkText([props.question, ...props.choices.map((choice: { label: string; reply: string }) => `${choice.label} ${choice.reply}`)], ctx.knownMinor, 'text');
    case 'show_tasks':
      return [...checkTasks(props.task_ids, ctx, 'task_ids'), ...checkText([props.title, props.note], ctx.knownMinor, 'text')];
    case 'show_task':
      return [...checkTasks([props.task_id], ctx, 'task_id'), ...checkText([props.note], ctx.knownMinor, 'note')];
    case 'show_chart':
      return [...(Array.isArray(props.task_ids) ? checkTasks(props.task_ids, ctx, 'task_ids') : []), ...checkText([props.title, props.note], ctx.knownMinor, 'text')];
    case 'show_findings':
      return [
        ...props.findings.flatMap((finding: { task_ids: number[] }, index: number) => checkTasks(finding.task_ids, ctx, `finding ${index + 1}`)),
        ...checkText([props.title, props.summary, ...props.findings.map((finding: { text: string }) => finding.text)], ctx.knownMinor, 'text'),
      ];
    case 'show_plan_edit':
      return ctx.edits?.has(props.edit_id)
        ? checkText([props.title, props.reason], ctx.knownMinor, 'text')
        : [`edit_id ${props.edit_id} was not returned by draft_plan_edit`];
    case 'show_snippets':
      return props.drafts
        .filter((draft: { draft_id: string }) => !ctx.drafts?.has(draft.draft_id))
        .map((draft: { draft_id: string }) => `draft_id ${draft.draft_id} was not returned by draft_snippet or find_repeating_work`);
    case 'show_rule_draft': {
      const scope = props.scope as { kind: string; task_ids?: number[] };
      const unknown = scope.kind === 'tasks' ? (scope.task_ids ?? []).filter((id) => ctx.taskIds && !ctx.taskIds.has(id)) : [];
      return unknown.length > 0 ? [`these tasks are not in the plan: ${unknown.join(', ')}`] : [];
    }
    case 'show_review':
    case 'show_invoices':
      return [];
    case 'show_change_invoice':
      return ctx.invoices?.has(props.invoice_id) ? [] : [`invoice_id ${props.invoice_id} was not returned by draft_change_invoice`];
    case 'show_how':
      return checkHowTo(ctx.clips ?? [], props.clip);
    case 'suggest_next':
      return checkText(props.suggestions.map((suggestion: { label: string; message: string }) => `${suggestion.label} ${suggestion.message}`), ctx.knownMinor, 'text');
  }
}
