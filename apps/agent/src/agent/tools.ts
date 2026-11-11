/**
 * The agent's data and action tools: zod schemas (every call is validated before anything runs),
 * the handlers, and where each lands in the app. Results are small, JSON-safe and carry
 * ready-formatted text, so the model never formats or computes money itself.
 *
 * Policy lives here, in code, not in the prompt:
 *   - rental dates and what they cost come from rental_options, never from the model;
 *   - a change to the plan is only ever drafted here: a person applies it;
 *   - an invoice for a change is only ever drafted here: a person who sees costs sends it;
 *   - PayPal is only ever read (check_with_paypal), with every request checked against a read-only allowlist;
 *   - nothing here approves, pays or bills. The workflow RPCs would refuse anyway.
 */
import { rentalDays } from '@collab/shared';
import { z } from 'zod';
import { findIssues, type Issue, type IssueKind } from '../plan/detectors';
import { scheduleFloat } from '../plan/analysis';
import { planState } from '../plan/facts';
import { planDay } from '../plan/today';
import { day, lastDay, usd } from '../plan/format';
import { bookingById, findTask, resourceById, taskById, type PlanMember, type PlanSnapshot } from '../plan/snapshot';
import { rentalChoices } from '../plan/whatif';
import { openProposal, rentalStatuses, type WorkflowRows } from '../workflow/state';
import type { LibraryRows } from '../data/store';
import type { PlanRows } from '../plan/rows';
import type { AgentEditDecisionRow, HowToClip, WatchRuleRow, WatchRunRow } from '@collab/shared';
import { FACT_TOOL_DESCRIPTIONS, FactToolSchemas, isFactTool, runFactTool } from './fact-tools';
import type { CheckedEdit } from './edits';
import { INVOICE_TOOL_DESCRIPTIONS, InvoiceToolSchemas, isInvoiceTool, runInvoiceTool, type DraftedInvoice } from './invoice-tools';
import { ODDS_TOOL_DESCRIPTIONS, OddsToolSchemas, isOddsTool, runOddsTool, type CommandPort } from './odds-tool';
import { PAYMENT_TOOL_DESCRIPTIONS, PaymentToolSchemas, isPaymentTool, runPaymentTool } from './payment-tools';
import { PAYPAL_TOOL_DESCRIPTIONS, PayPalToolSchemas, isPayPalTool, runPayPalTool } from './paypal-tool';
import type { PayPalReader } from '../paypal/reader';
import { PLAN_TOOL_DESCRIPTIONS, PlanToolSchemas, isPlanTool, runPlanTool, type DraftRecord } from './plan-tools';
import { SCREEN_TOOL_DESCRIPTIONS, ScreenToolSchemas, isScreenTool, runScreenTool } from './screen-tools';
import { QUERY_TOOL_DESCRIPTIONS, QueryToolSchemas, isQueryTool, runQueryTool } from './query-tool';
import { ToolRefusal } from './refusal';

export interface ToolContext {
  plan: PlanSnapshot;
  workflow: WorkflowRows;
  /** Issues as last computed, by id (for grounding the issue card). */
  issues: Map<string, Issue>;
  /** The person whose message started this turn; null for an app-started turn. */
  speaker: PlanMember | null;
  present: PlanMember[];
  /** The project's task library as last read. */
  library: LibraryRows;
  /** Snippet drafts made in this conversation, by draft_id (for show_snippets). */
  drafts: Map<string, DraftRecord>;
  /** Plan edits drafted in this conversation, by edit_id (for show_plan_edit). */
  edits: Map<string, CheckedEdit>;
  /** Invoices drafted for changes in this conversation, by invoice_id (for show_change_invoice). */
  invoices?: Map<string, DraftedInvoice>;
  /** The rows the plan was built from (for the change history) and people's decisions about drafted changes. */
  history: { rows: PlanRows | null; decisions: AgentEditDecisionRow[] };
  /** The watch list as last read: the rules and the runs still open. */
  watch: { rules: WatchRuleRow[]; open: WatchRunRow[] };
  /** The how-to clips show_how may name (default: clips.json as read at startup). */
  clips?: readonly HowToClip[];
  /** Re-reads the workflow (and the plan) from the database. */
  refresh(): Promise<void>;
  /** Runs a command in a person's browser (the odds, Remy's screen actions); absent where there is no browser to ask. */
  commands?: CommandPort;
  /** The plan's today when it is pinned (GANTRY_PLAN_DATE, plan/today.ts); absent or null: the server's own day. */
  planDate?: string | null;
  /** PayPal itself, read only (check_with_paypal); absent or null where PayPal isn't connected for the assistant. */
  paypal?: PayPalReader | null;
}

export { ToolRefusal };

const date = z.iso.date().describe('Calendar date YYYY-MM-DD');
const issueKind = z.enum(['idle_equipment', 'over_budget', 'late_task', 'double_booked']);
const documentKind = z.enum(['quote', 'invoice', 'receipt', 'photo', 'drawing', 'report', 'other']);

export const DataToolSchemas = {
  reply: z.object({
    text: z.string().min(1).max(1200).describe('What you say to the people: plain sentences, no markdown'),
  }),
  get_plan_overview: z.object({}),
  find_issues: z.object({
    kinds: z.array(issueKind).nullish().describe('Limit to these kinds; omit for all'),
    task_ids: z.array(z.int().positive()).max(30).nullish().describe('Only issues about these tasks or the work under them (e.g. the selected tasks)'),
  }),
  get_booking: z.object({
    booking_id: z.string().nullish().describe('Equipment booking id; omit for the project’s equipment booking'),
  }),
  rental_options: z.object({
    booking_id: z.string().nullish().describe('Equipment booking id; or give task_id'),
    task_id: z.int().positive().nullish().describe('The task the rental is booked on, instead of booking_id'),
    pad_before_days: z.int().min(0).max(30).nullish().describe('Days on rent ahead of the work, when someone asked for that many (counted as pad_in says)'),
    pad_after_days: z.int().min(0).max(30).nullish().describe('Days on rent past the work, when someone asked for that many (counted as pad_in says)'),
    pad_in: z.enum(['calendar', 'working']).nullish().describe('How they counted the cover: calendar for days ("a day either side", weekends included), working for working days ("a working day either side")'),
    first_day: date.nullish().describe('First day on rent, when someone named the date'),
    last_day: date.nullish().describe('Last day on rent, included, when someone named the date'),
  }),
  get_payment_status: z.object({}),
  read_documents: z.object({
    kind: documentKind.nullish().describe('Only this kind, e.g. quote or receipt'),
    task_id: z.int().positive().nullish().describe('Only documents filed for this task'),
    limit: z.int().min(1).max(8).nullish().describe('How many, newest first (default 5)'),
  }),
  stay_quiet: z.object({ reason: z.string().min(1).max(200) }),
  ...PlanToolSchemas,
  ...FactToolSchemas,
  ...InvoiceToolSchemas,
  ...OddsToolSchemas,
  ...PaymentToolSchemas,
  ...PayPalToolSchemas,
  ...ScreenToolSchemas,
  ...QueryToolSchemas,
};
export type DataToolName = keyof typeof DataToolSchemas;

export const DATA_TOOL_DESCRIPTIONS: Record<DataToolName, string> = {
  reply:
    'Say something to the people: it appears in the shared thread at once and is spoken aloud in a voice meeting. Call it first in your response, before any other tool or card, so people hear you while the rest happens. Plain sentences, no markdown, no lists.',
  get_plan_overview:
    'The plan at a glance: project, today’s date for the plan, the handover date and its deadline, what is late, each payment hold (what it pays for, what waits for it and why, when it falls due, where it stands), days off on a calendar ahead (the holiday shutdown, the city inspector away) and the work they hold up, how the plan is built (tasks, groups, milestones, links by type with lags and leads, constraints, deadlines, critical tasks, calendars), each phase with dates and progress, budget and forecast totals, rentals, and who is in the meeting.',
  find_issues:
    'Find problems in the plan (or only those about some tasks, e.g. the selected ones): equipment booked for days it cannot work, tasks forecast over budget, tasks finishing late, crews needed twice on one day. Each issue says the money at stake, how much can still be saved, whether a known fix exists, whether it is worth raising, and which issue already explains it. Sorted with the most worth raising first.',
  get_booking:
    'An equipment booking: the activity it serves, the rental window and day rate, the rental as booked, the idle days and their cost, and what holds the activity up.',
  rental_options:
    'What a rental could be, worked out on the machine\'s own calendar and priced by the day: the rental now, the option to recommend, the alternatives, and what was asked for ("a day either side": pad_before_days 1, pad_after_days 1, pad_in calendar; "a working day either side": pad_in working; or dates someone named). Each option carries the op to pass to draft_plan_edit unchanged. Never work out rental dates or their cost yourself.',
  get_payment_status:
    'Where each rental stands: its dates, what they come to, whether it is paid, processing or failed, and the receipt; and each invoice sent to the client (the tenant) through PayPal: what it bills, its total, whether it is a draft, sent or paid, its PayPal number and when it was sent or paid, as last checked. This is the app’s record; check_with_paypal asks PayPal itself.',
  read_documents:
    'The project’s documents, newest first: kind, name, the task it belongs to, a one-line summary and the text (shortened). Use it to quote the supplier’s quotation or a payment receipt; name the document you rely on.',
  stay_quiet:
    'Use instead of writing anything when there is nothing worth saying: an app event with no issue worth raising (or the people are already handling it), or a library drop with no similar place. Give the reason; nothing is shown.',
  ...PLAN_TOOL_DESCRIPTIONS,
  ...FACT_TOOL_DESCRIPTIONS,
  ...INVOICE_TOOL_DESCRIPTIONS,
  ...ODDS_TOOL_DESCRIPTIONS,
  ...PAYMENT_TOOL_DESCRIPTIONS,
  ...PAYPAL_TOOL_DESCRIPTIONS,
  ...SCREEN_TOOL_DESCRIPTIONS,
  ...QUERY_TOOL_DESCRIPTIONS,
};


function withoutNulls(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

export async function runDataTool(name: DataToolName, rawArgs: unknown, ctx: ToolContext): Promise<unknown> {
  if (isPlanTool(name)) return runPlanTool(name, rawArgs, ctx);
  if (isFactTool(name)) return runFactTool(name, rawArgs, ctx);
  if (isInvoiceTool(name)) return runInvoiceTool(name, rawArgs, ctx);
  if (isOddsTool(name)) return runOddsTool(name, rawArgs, ctx);
  if (isPaymentTool(name)) return runPaymentTool(name, rawArgs, ctx);
  if (isPayPalTool(name)) return runPayPalTool(name, rawArgs, ctx);
  if (isScreenTool(name)) return runScreenTool(name, rawArgs, ctx);
  if (isQueryTool(name)) return runQueryTool(name, rawArgs, ctx);
  const parsed = DataToolSchemas[name].safeParse(rawArgs);
  if (!parsed.success) throw new ToolRefusal(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
  const args = withoutNulls(parsed.data as Record<string, unknown>);
  const { plan } = ctx;
  switch (name) {
    case 'reply':
      return { delivered: true };
    case 'stay_quiet':
      return { quiet: true };
    case 'get_plan_overview': {
      const handover = findTask(plan, plan.handoverTaskId);
      const phases = plan.tasks
        .filter((task) => task.parentId === null)
        .map((phase) => {
          const leaves = plan.tasks.filter((task) => task.isLeaf && task.phase === phase.name && !task.isMilestone);
          const done = leaves.length ? Math.round(leaves.reduce((sum, task) => sum + task.percentDone, 0) / leaves.length) : 0;
          return { name: phase.name, starts: phase.start, last_day: lastDay(phase.end), percent_done: done };
        });
      const leaves = plan.tasks.filter((task) => task.isLeaf);
      const budget = leaves.reduce((sum, task) => sum + task.budgetMinor, 0);
      const forecast = leaves.reduce((sum, task) => sum + task.forecastMinor, 0);
      const linkCount = (type: number) => plan.dependencies.filter((link) => link.type === type).length;
      const floats = Object.values(scheduleFloat(plan));
      const state = planState(plan, planDay(ctx.planDate ?? null));
      return {
        project: plan.projectName,
        today: state.today,
        plan_as_of: plan.statusDate,
        handover: handover?.start ?? null,
        handover_deadline: handover?.deadline ?? null,
        // The shape of the plan, for questions about how it is built (query_plan reads any of it in detail).
        model: {
          tasks: leaves.filter((task) => !task.isMilestone).length,
          milestones: leaves.filter((task) => task.isMilestone).length,
          groups: plan.tasks.length - leaves.length,
          links: { finish_to_start: linkCount(2), start_to_start: linkCount(0), finish_to_finish: linkCount(3), start_to_finish: linkCount(1), with_lag: plan.dependencies.filter((link) => link.lag > 0).length, with_lead: plan.dependencies.filter((link) => link.lag < 0).length, switched_off: plan.dependencies.filter((link) => link.active === false).length },
          constrained: plan.tasks.filter((task) => task.constraintType).length,
          with_deadline: plan.tasks.filter((task) => task.deadline).length,
          manually_scheduled: plan.tasks.filter((task) => task.manuallyScheduled).length,
          inactive: plan.tasks.filter((task) => task.inactive).length,
          critical_tasks: floats.filter((float) => float.critical).length,
          payment_holds: plan.tasks.filter((task) => task.payGate).length,
          calendars: ['Mon-Fri (standard)', 'Mon-Sat (site)'],
        },
        // Where the plan stands today: what is late, what waits for a payment and why, and days off on a calendar.
        late: state.late,
        payment_holds: state.holds,
        days_off: state.daysOff,
        phases,
        budget_minor: budget,
        forecast_minor: forecast,
        text: { budget: usd(budget), forecast: usd(forecast), over_by: usd(forecast - budget), handover: handover ? day(handover.start) : null },
        rentals: rentalStatuses(plan, ctx.workflow).map((rental) => ({ booking_id: rental.booking_id, first_day: rental.first_day, last_day: rental.last_day, payment: rental.payment })),
        people: ctx.present.map((member) => ({ name: member.name, can_see_costs: member.canViewCosts })),
      };
    }
    case 'find_issues': {
      const picked = (args.task_ids as number[] | undefined) ?? [];
      const within = new Set(picked);
      // A picked group covers the tasks under it.
      for (let grew = picked.length > 0; grew; ) {
        grew = false;
        for (const task of plan.tasks) if (task.parentId !== null && within.has(task.parentId) && !within.has(task.id)) within.add(task.id), (grew = true);
      }
      const issues = findIssues(plan, args.kinds as IssueKind[] | undefined).filter((issue) => within.size === 0 || issue.task_ids.some((id) => within.has(id)));
      for (const issue of issues) ctx.issues.set(issue.id, issue);
      return {
        plan_as_of: plan.statusDate,
        count: issues.length,
        issues: issues.slice(0, 8).map((issue) => ({
          ...issue,
          already_being_fixed: issue.booking_id !== null && openProposal(ctx.workflow, issue.booking_id) !== null,
          text: { at_stake: usd(issue.at_stake_minor), can_still_save: usd(issue.avoidable_minor) },
        })),
        truncated: issues.length > 8,
      };
    }
    case 'get_booking': {
      const booking = bookingById(plan, args.booking_id as string | undefined);
      const task = taskById(plan, booking.taskId);
      const resource = resourceById(plan, booking.resourceId);
      const issue = findIssues(plan, ['idle_equipment']).find((candidate) => candidate.booking_id === booking.id) ?? null;
      if (issue) ctx.issues.set(issue.id, issue);
      const bookedDays = rentalDays(booking.billableStart, booking.billableEnd);
      const bookedMinor = bookedDays * booking.rentalRateMinor;
      return {
        booking_id: booking.id,
        equipment: resource.name,
        supplier: booking.supplierName,
        activity: { task_id: task.id, name: task.name, starts: task.start, last_day: lastDay(task.end) },
        rental: {
          from: booking.billableStart,
          last_day: lastDay(booking.billableEnd),
          rate_per_day_minor: booking.rentalRateMinor,
          works_on: resource.calendar === 'site' ? 'Mon-Sat' : 'Mon-Fri',
          billable_days: bookedDays,
          billed_on: 'every calendar day on rent, weekends included',
          booked_minor: bookedMinor,
        },
        idle: issue
          ? { days: Number(issue.facts.idle_days_before_start) + Number(issue.facts.idle_days_after_finish), before_the_work: Number(issue.facts.idle_days_before_start), after_the_work: Number(issue.facts.idle_days_after_finish), cost_minor: issue.at_stake_minor, held_up_by: issue.facts.held_up_by }
          : { days: 0, before_the_work: 0, after_the_work: 0, cost_minor: 0, held_up_by: null },
        text: { rate: `${usd(booking.rentalRateMinor)} a day, every day on rent`, booked_rental: usd(bookedMinor), rental_from: day(booking.billableStart), activity_starts: day(task.start) },
      };
    }
    case 'rental_options': {
      const byTask = typeof args.task_id === 'number' ? plan.bookings.find((booking) => booking.taskId === args.task_id) : undefined;
      if (typeof args.task_id === 'number' && !byTask) throw new ToolRefusal('No rental is booked on that task.');
      return rentalChoices(plan, {
        bookingId: (args.booking_id as string | undefined) ?? byTask?.id,
        padBefore: (args.pad_before_days as number | null | undefined) ?? undefined,
        padAfter: (args.pad_after_days as number | null | undefined) ?? undefined,
        padIn: (args.pad_in as 'calendar' | 'working' | null | undefined) ?? undefined,
        firstDay: (args.first_day as string | null | undefined) ?? undefined,
        lastDay: (args.last_day as string | null | undefined) ?? undefined,
      });
    }
    case 'get_payment_status':
      await ctx.refresh();
      return {
        rentals: rentalStatuses(ctx.plan, ctx.workflow),
        // Where PayPal says each invoice stands, as the card or a person last asked it.
        invoices: (ctx.workflow.invoices ?? [])
          .filter((invoice) => invoice.status !== 'cancelled')
          .map((invoice) => ({
            title: invoice.title,
            to: invoice.client_name,
            total_minor: invoice.amount_minor,
            status: invoice.status,
            number: invoice.paypal_number,
            sent_on: invoice.sent_at?.slice(0, 10) ?? null,
            paid_on: invoice.paid_at?.slice(0, 10) ?? null,
            checked: invoice.updated_at.slice(0, 16),
            text: { total: usd(invoice.amount_minor) },
          })),
      };
    case 'read_documents': {
      const limit = (args.limit as number | undefined) ?? 5;
      const documents = ctx.workflow.documents
        .filter((document) => !args.kind || document.kind === args.kind)
        .filter((document) => !args.task_id || document.task_id === args.task_id)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const budget = 6_000;
      let used = 0;
      const out = documents.slice(0, limit).map((document) => {
        const room = Math.max(400, Math.min(2_500, budget - used));
        const text = document.text_content ?? '';
        const shown = text.length > room ? `${text.slice(0, room)}…` : text;
        used += shown.length;
        return {
          kind: document.kind,
          name: document.name,
          task: document.task_id ? { id: document.task_id, name: findTask(plan, document.task_id)?.name ?? null } : null,
          summary: document.summary,
          filed: document.created_at.slice(0, 10),
          text: shown || null,
          text_truncated: text.length > shown.length,
        };
      });
      return { count: documents.length, documents: out };
    }
  }
}
