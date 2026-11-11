/**
 * The assistant's shared vocabulary, used by the agent service (apps/agent), the browser and the
 * database: the cards the model may put on screen (each a tool the model fills in), the thread's
 * messages, the commands the agent asks a person's browser to carry out, and the events streamed on
 * the private Realtime topic `project:{id}:agent` while the assistant is writing.
 *
 * How the parts talk:
 * - A person writes to the assistant (or clicks a card button) through the RPC `post_agent_message`;
 *   a trigger announces the new row as `message` on the agent topic.
 * - The agent service (service role) hears it, runs a turn and streams `stream` events (text as it is
 *   written, card drafts, tool progress) on the same topic, then stores the finished reply as an
 *   `agent_messages` row (announced as `message` again).
 * - To put a fix on the table, the agent inserts an `agent_commands` row for the person who asked
 *   (announced as `command`); one of that person's tabs claims it (`claim_agent_command`), runs it
 *   through the workflow controller under that person's login (`created_via 'agent'`) and reports the
 *   outcome (`complete_agent_command`). The agent never approves or pays; nothing here can.
 */
import { z } from 'zod';
import { ClipId } from './clips';
import { SnippetDraft } from './library';
import { PlanEditOp } from './plan-edit';
import { ProposalAssumption, ProposalInputs, CommandStatus, timestamp, uuid } from './schemas';
import { WatchAction, WatchCondition, WatchScope, WatchTrigger } from './watch';

export function agentTopic(projectId: string): string {
  return `project:${projectId}:agent`;
}

/** Broadcast event names on the agent topic. `message` and `command` come from the database (id only). */
export const AGENT_EVENTS = { message: 'message', command: 'command', stream: 'stream', thread: 'thread' } as const;

// -----------------------------------------------------------------------------------------
// The card catalog (generative UI)
// -----------------------------------------------------------------------------------------

const decimal = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'decimal text such as "2400.00"')
  .describe('Amount as decimal text exactly as a tool returned it, e.g. "2400.00" (no symbol, no commas)');
const date = z.iso.date().describe('Calendar date YYYY-MM-DD taken from a tool result');
const short = (max: number) => z.string().min(1).max(max);

export const IssueCard = z.object({
  issue_id: z.string().describe('The id find_issues returned for this issue'),
  headline: short(90).describe('One plain sentence, e.g. "The crane is booked 5 days with no work planned"'),
  detail: short(260).describe('Why it happens and what it costs, in plain words'),
  severity: z.enum(['high', 'medium', 'low']),
  money: z
    .object({ label: short(40).describe('e.g. "Idle crane days booked"'), amount: decimal })
    .nullable()
    .describe('The headline amount, or null'),
  timeline: z
    .object({
      label: short(40).describe('e.g. "Crane on rent"'),
      rental_from: date.describe('First booked day of the rental'),
      work_starts: date.describe('Day the activity can actually start'),
      work_last_day: date.describe('Last day of the activity'),
      rental_last_day: date.describe('Last booked day of the rental'),
    })
    .nullable()
    .describe('A strip showing the booked rental days, with the idle ones before and after the work; null when not about a rental'),
  facts: z.array(z.object({ label: short(28), value: short(48) })).max(4).describe('Up to four short facts'),
  remedy: short(200).nullable().describe('The fix on offer, in one sentence, or null'),
  actions: z
    .array(z.object({ label: short(28), kind: z.enum(['prepare_fix', 'not_now']) }))
    .max(2)
    .describe('Buttons; prepare_fix sends "Yes, prepare the fix" on the viewer’s behalf'),
});
export type IssueCard = z.infer<typeof IssueCard>;


export const Choices = z.object({
  question: short(140),
  choices: z.array(z.object({ label: short(32), reply: short(200).describe('Sent as the viewer’s message when picked') })).min(2).max(3),
});
export type Choices = z.infer<typeof Choices>;

const taskIdList = (max: number) => z.array(z.int().positive()).max(max);

/** Tasks of the plan as a list; the app fills in their live dates, crews and progress. */
export const TasksCard = z.object({
  title: short(80).describe('e.g. "On the critical path"'),
  task_ids: taskIdList(30).min(1).describe('Task ids from a tool result, in the order to show'),
  note: short(200).nullable().describe('One line under the title, or null'),
  show_in_plan: z.boolean().describe('true also selects these tasks in the plan of the person who asked'),
});
export type TasksCard = z.infer<typeof TasksCard>;

/** One task in detail; the app draws it from the live plan (dates, crews, links, float). */
export const TaskCard = z.object({
  task_id: z.int().positive().describe('Task id from a tool result'),
  note: short(220).nullable().describe('What to notice about it, or null'),
});
export type TaskCard = z.infer<typeof TaskCard>;

export const CHART_KINDS = ['crew_workload', 'phase_progress', 'phase_cost', 'task_float', 'cost_section', 'cost_ledger', 'cash_flow'] as const;
/** How a cost ledger opens: by who is paid, by floor, or by the month it falls due. */
export const COST_BREAKDOWNS = ['payee', 'floor', 'month'] as const;

/** A chart the app computes from the live plan, so its numbers are always the plan's own. */
export const ChartCard = z.object({
  title: short(80),
  kind: z
    .enum(CHART_KINDS)
    .describe(
      'crew_workload: crew-days per week; phase_progress: percent done per phase; phase_cost: budget against forecast per phase; task_float: days each task can slip; cost_section: what the work costs floor by floor, each floor split by task and who is paid; cost_ledger: who gets paid and how much, switchable to by floor or by month; cash_flow: the running total of money going out as each payment falls due along the plan',
    ),
  crews: z.array(short(80)).max(8).nullable().describe('crew_workload only: these crews; null for all'),
  from: date.nullable().describe('crew_workload only: first day, or null for the rest of the plan'),
  to: date.nullable().describe('crew_workload only: last day, or null for the rest of the plan'),
  task_ids: z
    .array(z.int().positive())
    .max(200)
    .nullable()
    .optional()
    .describe('cost_section, cost_ledger and cash_flow: the tasks whose costs to show, ids from a tool result (a group brings all its tasks); null for the whole plan'),
  by: z.enum(COST_BREAKDOWNS).nullable().optional().describe('cost_ledger only: how it opens: payee (who gets paid: the firm, supplier or crew), floor, or month; null for payee'),
  note: short(200).nullable(),
});
export type ChartCard = z.infer<typeof ChartCard>;

/** Problems found by a check of the schedule, each with its tasks and an optional "Fix this" button. */
export const FindingsCard = z.object({
  title: short(80),
  summary: short(200).nullable(),
  findings: z
    .array(
      z.object({
        severity: z.enum(['high', 'medium', 'low']),
        text: short(180),
        task_ids: taskIdList(12),
        fix_message: short(200).nullable().describe('Sent as the viewer’s message by a "Fix this" button, e.g. "Link the tasks that wait for nothing"; null for no button'),
      }),
    )
    .min(1)
    .max(8),
});
export type FindingsCard = z.infer<typeof FindingsCard>;

/** What the model writes for a plan edit: the draft is named by id; the service fills in its operations. */
export const PlanEditCardInput = z.object({
  edit_id: z.string().min(1).max(64).describe('The edit_id draft_plan_edit returned'),
  title: short(90).describe('What it does, e.g. "Add a moisture test before the vinyl"'),
  reason: short(240).describe('Why, in one or two plain sentences'),
  selectable: z.boolean().describe('true lets people uncheck single operations before applying (e.g. one per room)'),
});
/** The stored card: the checked operations and their plain-words lines. */
export const PlanEditCard = PlanEditCardInput.extend({
  operations: z.array(PlanEditOp).min(1).max(40),
  lines: z.array(z.string().max(300)).max(40),
  warnings: z.array(z.string().max(300)).max(8),
});
export type PlanEditCard = z.infer<typeof PlanEditCard>;

/** What the model writes for snippet drafts: named by id; the service fills in the drafts. */
export const SnippetsCardInput = z.object({
  title: short(80).describe('e.g. "Worth keeping in the library"'),
  drafts: z.array(z.object({ draft_id: z.string().min(1).max(64).describe('A draft_id from draft_snippet or find_repeating_work'), why: short(220) })).min(1).max(4),
});
export const SnippetsCard = z.object({
  title: short(80),
  drafts: z
    .array(
      z.object({
        draft_id: z.string().min(1).max(64),
        why: short(220),
        snippet: SnippetDraft,
        /** Where the draft was found in the plan (empty for one the assistant wrote). */
        source_task_ids: taskIdList(8),
      }),
    )
    .min(1)
    .max(4),
});
export type SnippetsCard = z.infer<typeof SnippetsCard>;

/** Two or three next steps as tappable chips; unlike show_choices it does not end the turn. */
export const FollowUps = z.object({
  suggestions: z.array(z.object({ label: short(40), message: short(200).describe('Sent as the viewer’s message when tapped') })).min(1).max(3),
});
export type FollowUps = z.infer<typeof FollowUps>;

/** What the model writes for a how-to clip: the clip by id, or the task in a few words; the service finds the clip. */
export const HowToCardInput = z.object({
  clip: short(80).describe('A clip id from the list in this tool’s description (e.g. "link-tasks"), or what the person wants to do in a few words (e.g. "link two tasks")'),
});
/** The stored card: the clip (apps/web/public/clips/<clip_id>.webm) with its title and steps from the clip list. */
export const HowToCard = z.object({
  clip_id: ClipId,
  title: short(60),
  steps: z.array(short(120)).min(1).max(6),
});
export type HowToCard = z.infer<typeof HowToCard>;

/**
 * A rule the assistant worked out from what someone wrote, in blocks: when, what it watches, the
 * conditions, what happens. The app draws it, says what it would find right now, and saves it only when
 * the person presses Start watching.
 */
export const RuleDraftCard = z.object({
  name: short(120).describe('A short name for the rule, e.g. "Rented equipment idle or booked twice"'),
  trigger: WatchTrigger.describe('When to check: {"kind":"change"} unless they asked for a time of day'),
  scope: WatchScope.describe('What it watches: {"kind":"plan"} for everything, or {"kind":"tasks","task_ids":[...]} with task ids from a tool result'),
  condition: WatchCondition.describe('One condition, or {"kind":"any","of":[...]} / {"kind":"all","of":[...]} of two or three. "Booked twice" about machines: crew_overbooked with equipment_only true'),
  action: WatchAction.describe('ask_assistant when they want suggestions, prepare_invoice when they want to bill for finished work, alert otherwise'),
  left_out: z.array(short(120)).max(3).describe('Parts of what they wrote that no condition can check, in their words; [] when everything fits'),
});
export type RuleDraftCard = z.infer<typeof RuleDraftCard>;

/** What a rule found about rented equipment, for a person to accept or decline; the app draws each row from the live plan. */
export const ReviewCard = z.object({
  rule_id: uuid.describe('The rule named in the event'),
});
export type ReviewCard = z.infer<typeof ReviewCard>;

/** The invoices a rule prepared for finished work; the app draws them from the live plan and sends them through PayPal. */
export const InvoicesCard = z.object({
  rule_id: uuid.describe('The rule named in the event'),
});
export type InvoicesCard = z.infer<typeof InvoicesCard>;

/** What the model writes for a change's invoice: the draft, by id; the service fills in the rest. */
export const ChangeInvoiceCardInput = z.object({
  invoice_id: z.string().min(1).max(64).describe('The invoice_id draft_change_invoice returned'),
});

/** A line of a change's invoice: what it bills, at the plan's own costs. */
export const ChangeInvoiceLine = z.object({
  label: short(200),
  amount_minor: z.int().positive(),
  /** The tasks it is made of, each with its amount (a floor's own work); null for a line of one task. */
  detail: z.string().min(1).max(1000).nullable(),
  task_ids: taskIdList(60).min(1),
});
export type ChangeInvoiceLine = z.infer<typeof ChangeInvoiceLine>;

/**
 * The stored card: the invoice for a change to the plan (a change order) as the service drafted it
 * from the plan, for a person who sees costs to send through PayPal. Nothing is billed until they
 * press Send; the card then follows the invoice recorded on the change's first task (`record_task_id`).
 */
export const ChangeInvoiceCard = ChangeInvoiceCardInput.extend({
  /** The change in a few words, e.g. "New light fixtures, levels 1 to 3". */
  change: short(90),
  /** The invoice's title, and its reference in PayPal: the project and the change (at most 120 characters). */
  title: short(120),
  /** Who it bills: the project's client (Harbor's tenant). */
  recipient: short(120),
  lines: z.array(ChangeInvoiceLine).min(1).max(40),
  total_minor: z.int().positive(),
  currency: z.string().length(3),
  /** Days after sending that it falls due (net terms). */
  due_days: z.int().positive().max(90),
  /** Over what one PayPal payment carries: the payer may pay it in parts. */
  partial_payments: z.boolean(),
  /** Every task of the change, in plan order. */
  task_ids: taskIdList(200).min(1),
  /** The task the invoice is recorded on (invoices.group_task_id): the change's first task. */
  record_task_id: z.int().positive(),
});
export type ChangeInvoiceCard = z.infer<typeof ChangeInvoiceCard>;

/** The cards as the model fills them in (its tools' input schemas). */
export const UI_COMPONENTS = {
  show_issue_card: IssueCard,
  show_choices: Choices,
  show_tasks: TasksCard,
  show_task: TaskCard,
  show_chart: ChartCard,
  show_findings: FindingsCard,
  show_plan_edit: PlanEditCardInput,
  show_snippets: SnippetsCardInput,
  show_how: HowToCardInput,
  suggest_next: FollowUps,
  show_rule_draft: RuleDraftCard,
  show_review: ReviewCard,
  show_invoices: InvoicesCard,
  show_change_invoice: ChangeInvoiceCardInput,
} as const;
export type UiComponentName = keyof typeof UI_COMPONENTS;

/** The tasks an issue is about: the service fills them in from its own records. Older cards have none. */
const namedTasks = { task_ids: taskIdList(30).optional() };
export const StoredIssueCard = IssueCard.extend(namedTasks);
export type StoredIssueCard = z.infer<typeof StoredIssueCard>;

/** The cards as stored and drawn: the same, except those the service fills in by id. */
export const CARD_PROPS: { readonly [N in UiComponentName]: z.ZodType } = {
  ...UI_COMPONENTS,
  show_issue_card: StoredIssueCard,
  show_plan_edit: PlanEditCard,
  show_snippets: SnippetsCard,
  show_how: HowToCard,
  show_change_invoice: ChangeInvoiceCard,
};

export const UI_DESCRIPTIONS: Record<UiComponentName, string> = {
  show_issue_card:
    'Show one problem you noticed as a card both people see: headline, why, the money involved, a strip of the paid-but-idle days, and a button to prepare the fix. Use the ids, amounts and dates the tools returned.',
  show_choices:
    'Ask one short question with two or three tappable answers. Ends your turn: the person’s pick is the next message.',
  show_tasks:
    'Show tasks of the plan as a list (the app fills in their live dates, crews and progress; each opens in the plan). Use the task ids a tool returned. Set show_in_plan to also select them in the asker’s plan.',
  show_task: 'Show one task in detail (dates, crews, what it waits for and what waits for it, how much it can slip), drawn from the live plan.',
  show_chart:
    'Show a chart the app computes from the live plan; it does the sums, so give it the tasks, not numbers. Pick the kind by the question: crew workload by week (crew_workload); progress or budget against forecast by phase (phase_progress, phase_cost); how much each task can slip (task_float); a cost breakdown by floor, or where the money goes in the building (cost_section); who gets paid, by crew, by firm or by month (cost_ledger, with by set to payee, floor or month); when the money goes out, cash flow, or payments over time (cash_flow). For the cost kinds, give task_ids for the work asked about (for example a package on every floor; a group brings its tasks) or null for the whole plan.',
  show_findings: 'Show what a check of the schedule found, most important first, each with its tasks and an optional "Fix this" button.',
  show_plan_edit:
    'Show a plan change you drafted with draft_plan_edit (by its edit_id) so a person can look it over and apply it. The app lists every operation and previews what moves (the handover date included); nothing changes until someone presses Apply.',
  show_snippets: 'Show snippet drafts (from draft_snippet or find_repeating_work, by draft_id) with a small timeline each and a "Save to library" button.',
  show_how:
    'Show a short screen recording of how to do something in this app, playing in the thread with its steps under it. Use it when someone asks how to do something in the app (not for questions about the plan itself). Pass the clip id, or what they want to do in a few words.',
  suggest_next: 'Offer two or three next steps as tappable chips at the end of your answer. Does not end your turn.',
  show_rule_draft:
    'Show a rule you worked out from what someone wrote, as blocks they can check: when it is checked, what it watches, the conditions, what happens. The app shows what it would find right now; nothing is watched until they press Start watching. Put anything no condition can check in left_out.',
  show_review: 'Show what a watch rule found about rented equipment: each rental with its problem, the fix and the money, with Accept and Decline, and the payment once fixes are accepted. The app draws it live from the plan. Pass the rule id from the event.',
  show_invoices: 'Show the invoices a watch rule prepared for finished work, with their lines and a Send button. The app draws them live from the plan. Pass the rule id from the event.',
  show_change_invoice:
    'Show the PayPal invoice you drafted for a change with draft_change_invoice (by its invoice_id): its lines, the total, who it goes to and when it falls due, with a Send button. Nothing is billed until a person who sees costs presses Send; the card then shows the invoice number, where it stands and the link to PayPal.',
};

export function isUiComponent(name: string): name is UiComponentName {
  return name in UI_COMPONENTS;
}

/** A finished card in a stored message: validated and grounded by the agent service. */
export const AgentCard = z.object({
  id: z.string().min(1).max(64),
  component: z.enum(Object.keys(UI_COMPONENTS) as [UiComponentName, ...UiComponentName[]]),
  props: z.unknown(),
});
export type AgentCard = z.infer<typeof AgentCard>;

/** A stored card's props checked against its schema (the filled-in one for plan edits and snippets); null when they do not fit. */
export function parseCardProps(component: UiComponentName, props: unknown): Record<string, unknown> | null {
  const parsed = CARD_PROPS[component].safeParse(props);
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}

// -----------------------------------------------------------------------------------------
// The thread
// -----------------------------------------------------------------------------------------

export const AgentMessageRole = z.enum(['assistant', 'person']);
export type AgentMessageRole = z.infer<typeof AgentMessageRole>;

/** How a message reached the thread. `app`: written by the agent on its own, from an event in the app. */
export const AgentChannel = z.enum(['text', 'voice', 'app']);
export type AgentChannel = z.infer<typeof AgentChannel>;

/** Where a library piece landed in the plan (the person dropped it; the assistant may offer it elsewhere). */
export const LibraryDropDetail = z.object({
  snippet_id: z.string().min(1).max(64),
  name: z.string().min(1).max(160),
  /** The new top task of each copy (real ids: sent once the server has numbered them). */
  top_ids: z.array(z.int().positive()).min(1).max(8),
  /** The task it was placed after, or null at the start or end of a group. */
  anchor_id: z.int().positive().nullable(),
  /** The group it went into, or null at the top level. */
  parent_id: z.int().positive().nullable(),
  mode: z.enum(['push', 'fit', 'alongside', 'unlinked']),
});
export type LibraryDropDetail = z.infer<typeof LibraryDropDetail>;

/**
 * What a person did along with their message (the text is what they "said"): a card button, or a
 * library piece dropped into the plan. Mirrors agent_action_canonical in the database.
 */
export const AgentAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prepare_fix'), issue_id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('not_now'), issue_id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('choice'), card_id: z.string().min(1).max(64) }),
  /** Applied a plan change the assistant drafted (the text says what changed). */
  z.object({ kind: z.literal('apply_edit'), card_id: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('dismiss_edit'), card_id: z.string().min(1).max(64) }),
  /** Saved a snippet the assistant drafted into the library. */
  z.object({ kind: z.literal('save_snippet'), card_id: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('library_drop'), detail: LibraryDropDetail }),
]);
export type AgentAction = z.infer<typeof AgentAction>;

/**
 * How a person lets the assistant's drafted plan changes apply (the switch under the composer):
 *   ask    nothing changes until the person presses Apply (the hard stop); Decline is recorded
 *   risky  small changes apply by themselves; deletions, unlinking, handover moves and big edits wait
 *   auto   every change applies as soon as it is checked
 * Approvals and payments are never covered: those always take the person's own click.
 */
export const ApprovalMode = z.enum(['ask', 'risky', 'auto']);
export type ApprovalMode = z.infer<typeof ApprovalMode>;

/** A task the person had selected in the plan when they wrote (what "this task" means). */
export const SelectedTask = z.object({
  id: z.int().positive(),
  name: z.string().max(160),
  /** The WBS code, e.g. "3.4" (null when the plan has none for it). */
  wbs: z.string().max(40).nullable(),
});
export type SelectedTask = z.infer<typeof SelectedTask>;

/** The windows and sheets that can be open over the page, by what they are. */
export const SCREEN_MODALS = ['payment_review', 'invoice', 'drop_card', 'snippet_editor'] as const;

/**
 * What was on the screen of the person who wrote, read by their tab as they sent it (on a call, by the tab of the
 * person speaking): the chart or the 3D site view and its day, the side panel, a window over the page, the open
 * library card, the search and filter, the dates in view. Flat and short; Remy reads it as a <screen> line.
 * Mirrors agent_context_canonical in the database (at most 1,200 bytes, text at most 120 characters).
 */
export const ScreenContext = z.object({
  view: z.enum(['chart', 'site']),
  /** The 3D site view: the day on show, whether its days are playing, up on the crane, the level looked at. */
  site_day: z.iso.date().nullish(),
  playing: z.boolean().nullish(),
  crane_ride: z.boolean().nullish(),
  level: z.string().max(60).nullish(),
  /** The side panel's tab, when one is open ("task" is the task editor). */
  panel: z.string().max(30).nullish(),
  /** A window or sheet over the page, and what it is about. */
  modal: z.enum(SCREEN_MODALS).nullish(),
  modal_about: z.string().max(120).nullish(),
  /** The odds panel beside the chart. */
  odds: z.boolean().nullish(),
  /** The library card open in the library panel. */
  snippet: z.string().max(120).nullish(),
  search: z.string().max(80).nullish(),
  /** The filter on the chart, in words ("Halden Electrical · Dec 1 to Dec 31", "In progress"). */
  filter: z.string().max(120).nullish(),
  /** The chart's visible dates, first and last, and its zoom. */
  from: z.iso.date().nullish(),
  to: z.iso.date().nullish(),
  zoom: z.string().max(30).nullish(),
  /** On a call: whether this tab hosts it. */
  call: z.enum(['host', 'guest']).nullish(),
});
export type ScreenContext = z.infer<typeof ScreenContext>;

/** What a person's message carries besides its words. Mirrors agent_context_canonical in the database. */
export const AgentMessageContext = z.object({
  selected_tasks: z.array(SelectedTask).max(30).optional(),
  approval_mode: ApprovalMode.optional(),
  /** A screen that doesn't fit is left out, never the message with it (nor a thread that holds one). */
  screen: ScreenContext.optional().catch(undefined),
});
export type AgentMessageContext = z.infer<typeof AgentMessageContext>;

/** Who reads a thread: everyone in the project, or its starter and the people they invite. */
export const AgentThreadVisibility = z.enum(['project', 'private']);
export type AgentThreadVisibility = z.infer<typeof AgentThreadVisibility>;

/**
 * Where a thread's title came from: the first words of its first message ('auto', which the
 * assistant replaces once with a short name, 'agent'), or a person ('person', never replaced).
 */
export const AgentThreadTitleSource = z.enum(['auto', 'agent', 'person']);
export type AgentThreadTitleSource = z.infer<typeof AgentThreadTitleSource>;

export const AgentThreadRow = z.object({
  id: uuid,
  project_id: uuid,
  title: z.string().min(1).max(80),
  created_by: uuid.nullable(),
  created_at: timestamp,
  last_message_at: timestamp,
  title_source: AgentThreadTitleSource.default('person'),
  visibility: AgentThreadVisibility.default('project'),
  /**
   * Who chose to share the costs in this conversation with people who cannot otherwise see them (by
   * inviting one, or sharing it with the project), and when; null while nobody has. Once shared, the
   * assistant speaks amounts to everyone in it.
   */
  costs_shared_by: uuid.nullable().default(null),
  costs_shared_at: timestamp.nullable().default(null),
});
export type AgentThreadRow = z.infer<typeof AgentThreadRow>;

/** Someone invited into a private thread (its starter is in it without a row). */
export const AgentThreadMemberRow = z.object({
  thread_id: uuid,
  user_id: uuid,
  added_by: uuid.nullable(),
  added_at: timestamp,
});
export type AgentThreadMemberRow = z.infer<typeof AgentThreadMemberRow>;

/** The Realtime topic a private thread's live reply streams on (only the people in it may join). */
export const threadTopic = (projectId: string, threadId: string): string => `project:${projectId}:thread:${threadId}`;

/** A thread's provisional title: the first words of its first message, on one line, at most 60 characters. */
export function provisionalThreadTitle(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim();
  if (words.length <= 60) return words || 'New conversation';
  const cut = words.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[,.;:!?-]+$/, '')}…`;
}

/** The main thread's display name (it has no row). */
export const MAIN_THREAD_TITLE = 'General';

export const AgentMessageRow = z.object({
  id: uuid,
  project_id: uuid,
  /** The thread; null for the project's main thread. */
  thread_id: uuid.nullish(),
  /** The assistant's turn this message belongs to (a person's message starts one). */
  turn_id: z.string().min(1).max(64).nullable(),
  role: AgentMessageRole,
  /** The person who wrote it; null for the assistant. */
  author_id: uuid.nullable(),
  channel: AgentChannel,
  text: z.string().max(4000),
  cards: z.array(AgentCard).max(6),
  action: AgentAction.nullable(),
  /** A person's selection and approval mode when they wrote; null for the assistant's messages. */
  context: AgentMessageContext.nullish(),
  created_at: timestamp,
});
export type AgentMessageRow = z.infer<typeof AgentMessageRow>;

/** What people decided about a change the assistant drafted. Mirrors agent_edit_decisions.decision. */
export const AgentEditDecision = z.enum(['applied', 'auto_applied', 'declined']);
export type AgentEditDecision = z.infer<typeof AgentEditDecision>;

/** One decision, written by the database from the stored card (the changelog lists them). */
export const AgentEditDecisionRow = z.object({
  id: uuid,
  project_id: uuid,
  thread_id: uuid.nullable(),
  card_id: z.string().min(1).max(64),
  message_id: uuid.nullable(),
  decision: AgentEditDecision,
  decided_by: uuid.nullable(),
  title: z.string().min(1).max(200),
  lines: z.array(z.string()),
  created_at: timestamp,
});
export type AgentEditDecisionRow = z.infer<typeof AgentEditDecisionRow>;

// -----------------------------------------------------------------------------------------
// Commands: the agent asks a person's browser to do what only a browser can (put a fix on the
// table, run the odds on the plan's scheduling engine)
// -----------------------------------------------------------------------------------------

export const AgentCommandType = z.enum(['propose_fix', 'revise_fix', 'schedule_odds', 'late_payment_effect', 'ui_action']);
export type AgentCommandType = z.infer<typeof AgentCommandType>;

// -----------------------------------------------------------------------------------------
// Remy on screen (`ui_action`): what she shows in the requester's own tab, with her own cursor. Each action only
// moves what that person sees (the view, a panel, a filter, an editor opened for them, undo and redo of their own
// changes); none approves, pays or bills. The browser checks the arguments against this schema before it runs one.
// -----------------------------------------------------------------------------------------

/** The side panels Remy can bring forward (the rail beside the chart). */
export const UI_PANELS = ['task', 'library', 'rentals', 'documents', 'assistant', 'crews', 'alerts', 'history'] as const;
export const UiPanel = z.enum(UI_PANELS);
export type UiPanel = z.infer<typeof UiPanel>;

const uiTaskId = z.int().positive();
const uiDay = z.iso.date();

/** A task in the plan, by id (the agent's plan resolved a name or a WBS code to it), or by its row as shown on that screen. */
export const UiTaskTarget = z.union([z.object({ task_id: uiTaskId }), z.object({ row: z.int().min(1).max(5000) })]);
export type UiTaskTarget = z.infer<typeof UiTaskTarget>;

export const UiAction = z.discriminatedUnion('action', [
  /** The 3D site view: open it (and look at the tower crane, or ride it), or close it for the chart. */
  z.object({ action: z.literal('site_view'), open: z.boolean(), look: z.enum(['crane', 'from_crane']).nullish() }),
  /** Bring a task into view: open the groups above it, scroll to it, select it and flash its row. */
  z.object({ action: z.literal('go_to_task'), target: UiTaskTarget }),
  /** A cell of a task's row (`column` in words: "start", "days", "crew"), shown and selected; with `edit`, its editor opened. */
  z.object({ action: z.literal('focus_cell'), target: UiTaskTarget, column: z.string().trim().min(1).max(40), edit: z.boolean() }),
  /** The task's editor (what a double-click opens: the task in the side panel). */
  z.object({ action: z.literal('open_editor'), target: UiTaskTarget }),
  /** Show only some of the plan: by words, by crews, by dates; or everything again. */
  z.object({
    action: z.literal('filter'),
    clear: z.boolean(),
    text: z.string().trim().min(1).max(80).nullish(),
    crew_ids: z.array(z.int()).min(1).max(12).nullish(),
    /** How the crews are named on the filter's chip ("Volt Electric"). */
    crew_label: z.string().trim().min(1).max(80).nullish(),
    from: uiDay.nullish(),
    to: uiDay.nullish(),
  }),
  /** Highlight the tasks that match and go to one of them; `step` walks through them; `clear` takes the highlight off. */
  z.object({
    action: z.literal('search'),
    text: z.string().trim().min(1).max(80).nullish(),
    task_ids: z.array(uiTaskId).max(200).nullish(),
    step: z.enum(['first', 'next', 'previous']).nullish(),
    clear: z.boolean().nullish(),
  }),
  /** Open or close one group, or every group. */
  z.object({ action: z.literal('expand'), open: z.boolean(), task_id: uiTaskId.nullish() }),
  /** The timeline: fit the whole project, one step in or out, or a span of days. */
  z.object({ action: z.literal('zoom'), how: z.enum(['fit', 'in', 'out', 'dates']), first_day: uiDay.nullish(), last_day: uiDay.nullish() }),
  z.object({ action: z.literal('open_panel'), panel: UiPanel }),
  /** A payment hold's payment, up for review (the person presses Send payout, never Remy). */
  z.object({ action: z.literal('open_payment'), task_id: uiTaskId }),
  /** The newest tenant invoice in the thread, up for review (the person sends it, never Remy). */
  z.object({ action: z.literal('open_invoice') }),
  /** Undo or redo this person's own last changes, with the toolbar's buttons. */
  z.object({ action: z.literal('history'), direction: z.enum(['undo', 'redo']), steps: z.int().min(1).max(5) }),
  /**
   * Close what is open: the window or sheet over the page, the side panel, or the odds panel. `panel`: the side panel
   * they named ("close the library"), closed only when it is the one open.
   */
  z.object({ action: z.literal('close'), what: z.enum(['modal', 'panel', 'odds']), panel: UiPanel.nullish() }),
  /** A library piece's card in the library panel, opened to show what is in it. */
  z.object({ action: z.literal('open_snippet'), snippet_id: z.string().min(1).max(64) }),
  /**
   * A library piece carried from its card onto a row of the chart, as a person drags it: the card that asks how to tie
   * it in opens there, and the person picks and applies. `zone`: after the row's task, or inside its group.
   */
  z.object({ action: z.literal('drag_snippet'), snippet_id: z.string().min(1).max(64), task_id: uiTaskId, zone: z.enum(['after', 'inside']).nullish() }),
  /** The chart scrolled to a day, its zoom kept. */
  z.object({ action: z.literal('scroll_to_date'), date: uiDay }),
  /** A task's bar brought into view and pointed at. */
  z.object({ action: z.literal('show_bar'), target: UiTaskTarget }),
  /**
   * The 3D site view's days played through, from `from` (default: the day on show) to `to` (default: `days` after the
   * start, else the end), in about `seconds`.
   */
  z.object({
    action: z.literal('site_play'),
    from: uiDay.nullish(),
    to: uiDay.nullish(),
    days: z.int().min(1).max(800).nullish(),
    seconds: z.int().min(2).max(120).nullish(),
  }),
  z.object({ action: z.literal('site_pause') }),
  /** The 3D site view on a day. */
  z.object({ action: z.literal('site_day'), date: uiDay }),
  /** The 3D site view looking at a level ("Level 2", "L2"), or at the whole site (null). */
  z.object({ action: z.literal('site_level'), level: z.string().trim().min(1).max(60).nullish() }),
]);
export type UiAction = z.infer<typeof UiAction>;

/** What a screen action did, for Remy to say: one plain line, and the task it ended on. */
export const UiActionOutcome = z.object({
  did: z.string().min(1).max(600),
  task: z.object({ id: z.int(), name: z.string().max(200), wbs: z.string().max(40).nullable() }).nullish(),
  /** search: how many tasks matched, and which of them is on show (1-based). */
  matches: z.int().nonnegative().nullish(),
  at: z.int().nonnegative().nullish(),
  /** Nothing to do: what they named wasn't open, so nothing changed on screen. */
  nothing: z.boolean().nullish(),
});
export type UiActionOutcome = z.infer<typeof UiActionOutcome>;

/** How long the requester's tab has to pick a screen action up before it is withdrawn, and to finish it. */
export const UI_ACTION_CLAIM_MS = 6_000;
export const UI_ACTION_TIMEOUT_MS = 30_000;

/** How the payment holds are paid in the runs: on the Friday pay run, or when each falls due. Omitted: as the person has it. */
export const OddsPayRule = z.enum(['pay_run', 'when_due']);
export type OddsPayRule = z.infer<typeof OddsPayRule>;

/** Run the plan a thousand times (the odds panel, in the person's browser) and report what the runs gave. */
export const ScheduleOddsArgs = z.object({
  pay: OddsPayRule.nullish(),
});
export type ScheduleOddsArgs = z.infer<typeof ScheduleOddsArgs>;

const isoDay = z.iso.date();
const share = z.number().min(0).max(1);

/**
 * What a run of the odds gave, as the browser read it off the engine's runs: every number here is from the runs,
 * under the assumptions named in `assumptions` (shown on screen).
 */
export const OddsSummary = z.object({
  /** The date the keys must change hands by, and where it comes from (the handover's deadline, ...). */
  contract_date: isoDay,
  contract_from: z.enum(['deadline', 'constraint', 'baseline', 'plan']),
  /** The plan's own handover date, as it stands (no dice). */
  planned_handover: isoDay.nullable(),
  runs: z.int().positive(),
  seed: z.int(),
  /** The assumptions line as the panel shows it. */
  assumptions: z.string().max(400),
  pay: OddsPayRule,
  /** Under the person's pay rule: runs that hand over by the contract date, of `runs`. */
  on_time: z.int().nonnegative(),
  odds: share,
  p50: isoDay,
  p80: isoDay,
  /** With every hold paid when it falls due (the PayPal step), when the rule above was the pay run. */
  paid_when_due: z.object({ on_time: z.int().nonnegative(), odds: share, p50: isoDay, p80: isoDay }).nullable(),
  /** Holds on the pay run: how much later the handover comes than paying when due. */
  holds: z.array(z.object({ name: z.string().max(160), days_later_p50: z.int(), days_later_p80: z.int(), points: z.number() })).max(4),
  /** The tasks the handover follows most closely (rank correlation of their length with the handover). */
  threats: z.array(z.object({ name: z.string().max(160), correlation: share })).max(5),
  /** The ways forward, cheapest gain first: each step with the odds after it and what it adds in cost. */
  ladder: z
    .array(z.object({ step: z.string().max(200), on_time: z.int().nonnegative(), odds: share, p50: isoDay, cost_minor: z.int().nonnegative(), saturdays: z.number().nonnegative() }))
    .max(6),
  /** Someone changed the plan while the runs went: they answer for the plan as it was asked. */
  on_copy: z.boolean(),
});
export type OddsSummary = z.infer<typeof OddsSummary>;

/** Create the proposal for a booking with these inputs, then check it on the scheduling engine. */
export const ProposeFixArgs = z.object({
  booking_id: uuid,
  inputs: ProposalInputs,
  assumptions: z.array(ProposalAssumption).max(8).default([]),
  /** Why, in the person's words, for the history. */
  reason: z.string().min(1).max(500),
});
export type ProposeFixArgs = z.infer<typeof ProposeFixArgs>;

/** Correct the current version (a new version; earlier approvals stop counting), then check it. */
export const ReviseFixArgs = z.object({
  version_id: uuid,
  /** Only the fields that change (the full inputs carry a cross-field check that a partial cannot). */
  changes: z.strictObject(ProposalInputs.shape).partial(),
  answers: z.array(z.object({ key: z.string().min(1).max(64), answer: z.string().min(1).max(500) })).max(8).default([]),
  reason: z.string().min(1).max(500),
});
export type ReviseFixArgs = z.infer<typeof ReviseFixArgs>;

/** What paying a held piece of work on the Friday pay run would do, as the engine in the browser worked it out. */
export const LatePaymentEffect = z.object({
  /** The work the payment holds. */
  held: z.string().max(300),
  /** ISO days. */
  due: z.string(),
  paid_on: z.string(),
  starts_on_time: z.string().nullable(),
  starts_if_late: z.string().nullable(),
  handover_on_time: z.string().nullable(),
  handover_if_late: z.string().nullable(),
  /** Calendar days and working days the handover moves. */
  slip_days: z.number().int(),
  working_days_lost: z.number().int(),
  /** Named days off the move runs over (a public holiday, the shutdown). */
  holidays: z.array(z.string().max(80)).max(10),
  /** A task that now has to wait out something on its own calendar, and until when. */
  waits_for: z.object({ task: z.string().max(200), why: z.string().max(120), from: z.string(), until: z.string(), now_on: z.string() }).nullable(),
});
export type LatePaymentEffect = z.infer<typeof LatePaymentEffect>;

export const AgentCommandResult = z.object({
  proposal_id: uuid.optional(),
  version_id: uuid.optional(),
  version_no: z.int().positive().optional(),
  /** One plain line for the agent (and the thread) when something went wrong. */
  message: z.string().max(500).optional(),
  /** schedule_odds: what the runs gave. */
  odds: OddsSummary.optional(),
  /** late_payment_effect: what waiting for the pay run would do. */
  late_payment: LatePaymentEffect.optional(),
  /** ui_action: what Remy's cursor did on that screen. */
  ui: UiActionOutcome.optional(),
});
export type AgentCommandResult = z.infer<typeof AgentCommandResult>;

export const AgentCommandRow = z.object({
  id: uuid,
  project_id: uuid,
  type: z.string(),
  args: z.unknown(),
  required_revision: z.int().nonnegative().nullable(),
  executor_session: uuid.nullable(),
  status: CommandStatus,
  result: AgentCommandResult.nullable(),
  requested_by: uuid.nullable(),
  created_at: timestamp,
  completed_at: timestamp.nullable(),
});
export type AgentCommandRow = z.infer<typeof AgentCommandRow>;

/** A command no tab of the requester claimed this long after it was made may be run by any member's tab. */
export const AGENT_COMMAND_OPEN_AFTER_MS = 5_000;

// -----------------------------------------------------------------------------------------
// Streaming (broadcast by the agent service as `stream`; nothing here is stored)
// -----------------------------------------------------------------------------------------

export const AgentTurnKind = z.enum(['proactive', 'progress', 'utterance']);
export type AgentTurnKind = z.infer<typeof AgentTurnKind>;

/**
 * The service's signature on a reply, for Remy's voice on a call: base64url HMAC-SHA256 over `project|turn|text`, keyed
 * with the secret it shares with her call worker (REMY_LINE_SECRET), which says only what such a signature covers. On a
 * `tool` event it covers the reply as streamed so far; on `turn_end`, the reply as stored. Absent without the secret.
 */
export const ReplySignature = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const AgentStreamEvent = z.discriminatedUnion('type', [
  /** The assistant started a turn (shows "thinking" at once). `speaker_id`: the person it answers. */
  z.object({
    type: z.literal('turn_start'),
    turn_id: z.string().min(1).max(64),
    kind: AgentTurnKind,
    speaker_id: uuid.nullable(),
    /** The thread the turn answers in (null: the main thread). */
    thread_id: uuid.nullish(),
  }),
  /** More of the reply, in order; `seq` counts deltas within the turn so a lost one shows as a gap. */
  z.object({ type: z.literal('text_delta'), turn_id: z.string().min(1).max(64), seq: z.int().nonnegative(), text: z.string().max(2000) }),
  /** A tool started or finished, for the progress line ("Checking the plan…"). `sig`: the reply so far (ReplySignature). */
  z.object({
    type: z.literal('tool'),
    turn_id: z.string().min(1).max(64),
    tool_id: z.string().min(1).max(64),
    name: z.string().min(1).max(64),
    state: z.enum(['start', 'ok', 'error']),
    summary: z.string().max(300).optional(),
    sig: ReplySignature.optional(),
  }),
  /** A card the model is still writing: the props so far (not yet checked). */
  z.object({ type: z.literal('ui_partial'), turn_id: z.string().min(1).max(64), card_id: z.string().min(1).max(64), component: z.string().min(1).max(64), props: z.unknown() }),
  /**
   * The turn is over; `message_id` is the stored reply (null when the assistant chose to stay quiet). `sig`: the stored
   * reply's text (ReplySignature).
   */
  z.object({ type: z.literal('turn_end'), turn_id: z.string().min(1).max(64), message_id: uuid.nullable(), error: z.string().max(500).optional(), sig: ReplySignature.optional() }),
]);
export type AgentStreamEvent = z.infer<typeof AgentStreamEvent>;

/** Plain words for the tools in the progress line. */
export const AGENT_TOOL_WORDS: Readonly<Record<string, string>> = {
  get_plan_overview: 'Reading the plan',
  find_issues: 'Looking for problems',
  get_booking: 'Reading the rental',
  get_payment_status: 'Checking the payment',
  schedule_odds: 'Running the plan a thousand times',
  late_payment_effect: 'Working out what waiting would do',
  get_progress_payments: 'Reading the progress payments',
  read_documents: 'Reading the documents',
  stay_quiet: 'Deciding',
  find_tasks: 'Searching the plan',
  get_task: 'Reading the task',
  get_critical_path: 'Tracing what sets the handover date',
  get_crew_workload: 'Adding up crew workload',
  check_schedule: 'Checking the schedule',
  list_library: 'Looking through the library',
  find_repeating_work: 'Looking for repeating work',
  calculate: 'Working it out',
  sum_costs: 'Adding up the costs',
  count_working_days: 'Counting working days',
  get_calendars: 'Reading the calendars',
  get_milestones: 'Reading the milestones',
  get_time_ranges: 'Reading the timeline',
  get_plan_changes: 'Reading the change history',
  draft_snippet: 'Drafting a snippet',
  find_similar_places: 'Looking for similar places',
  draft_plan_edit: 'Drafting the change',
  show_issue_card: 'Drawing a card',
  show_choices: 'Drawing a card',
  show_tasks: 'Listing tasks',
  show_task: 'Drawing a card',
  show_chart: 'Drawing a chart',
  show_findings: 'Drawing a card',
  show_plan_edit: 'Laying out the change',
  show_snippets: 'Drawing the drafts',
  show_how: 'Finding the clip',
  suggest_next: 'Thinking of next steps',
  show_rule_draft: 'Working out the rule',
  show_review: 'Laying out what it found',
  show_invoices: 'Preparing the invoices',
  draft_change_invoice: 'Drafting the invoice',
  show_change_invoice: 'Laying out the invoice',
};
