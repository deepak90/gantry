/**
 * A scripted stand-in for Claude (AGENT_MODE=mock): reads the same request the real model gets,
 * follows the system prompt's playbook with simple rules, and answers in the Messages API's SSE wire
 * format, so the whole service (SDK stream parsing, tools, commands, grounding, streaming) runs as it
 * would live. Every number it writes is read from a tool result or the event; it computes nothing.
 * It is a test double for development and CI, not a claim about what Claude would say.
 */
import { sseEvents, streamingResponse, type MockBlock, type MockTurn } from './sse';

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Msg = { role: string; content: string | Block[] };
interface ToolRun {
  name: string;
  input: any;
  result: any;
  error: boolean;
}

const blocksOf = (message: Msg): Block[] => (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content);

function turnStart(messages: Msg[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'user' && blocksOf(message).some((block) => block.type === 'text' && /<(app_event|utterance)/.test(block.text ?? ''))) return index;
  }
  return 0;
}

function toolRuns(messages: Msg[], from: number): ToolRun[] {
  const uses = new Map<string, { name: string; input: unknown }>();
  const runs: ToolRun[] = [];
  for (const message of messages.slice(from)) {
    for (const block of blocksOf(message)) {
      if (block.type === 'tool_use' && block.id) uses.set(block.id, { name: block.name ?? '', input: block.input });
      if (block.type === 'tool_result' && block.tool_use_id) {
        const use = uses.get(block.tool_use_id);
        if (!use) continue;
        const raw = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? (block.content as Block[]).map((b) => b.text ?? '').join('') : '';
        let result: unknown = raw;
        try {
          result = JSON.parse(raw);
        } catch {
          // a plain-text error
        }
        runs.push({ name: use.name, input: use.input, result, error: Boolean(block.is_error) });
      }
    }
  }
  return runs;
}

const whole = (text: string): string => text.replace(/\.00\b/g, '');
const decimal = (minor: number): string => (minor / 100).toFixed(2);
const usd = (minor: number): string => whole(`$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const day = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
};
const addDays = (iso: string, days: number): string => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const first = (name: string): string => name.split(' ')[0] ?? name;

let counter = 0;
const call = (name: string, input: unknown): MockBlock => ({ type: 'tool_use', id: `toolu_mock_${(++counter).toString().padStart(5, '0')}`, name, input });
const reply = (text: string): MockBlock => call('reply', { text });
const tool = (blocks: MockBlock[]): MockTurn => ({ blocks, stop_reason: 'tool_use' });
const end = (blocks: MockBlock[] = []): MockTurn => ({ blocks, stop_reason: 'end_turn' });

function issueCard(issue: any, options: any): Record<string, unknown> {
  const f = issue.facts;
  return {
    issue_id: issue.id,
    headline: `The crane is booked ${f.idle_days_before_start + f.idle_days_after_finish} days with no work planned`,
    detail: `${f.supplier} delivers the crane on ${day(f.rental_from)}, but ${String(f.held_up_by).replace(/ \(finishes (.*)\)$/, ' only finishes on $1')}, so the frame starts on ${day(f.activity_starts)}.`,
    severity: issue.severity,
    money: { label: 'Rental for idle crane days', amount: decimal(issue.at_stake_minor) },
    timeline: { label: 'Crane on rent', rental_from: f.rental_from, work_starts: f.activity_starts, work_last_day: f.activity_last_day, rental_last_day: f.rental_to_last_day },
    facts: [
      { label: 'Crane rate', value: `${usd(f.rental_rate_minor)} a day` },
      { label: 'Idle days', value: `${f.idle_days_before_start} before the work, ${f.idle_days_after_finish} after` },
      { label: 'Paid so far', value: 'Nothing yet' },
      { label: 'Recommended', value: options.recommended ? options.recommended.text.change : 'Keep it' },
    ],
    remedy: issue.remedy,
    actions: [
      { label: 'Prepare the fix', kind: 'prepare_fix' },
      { label: 'Not now', kind: 'not_now' },
    ],
  };
}

function parseBlock(text: string, tag: string): any {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[1]!);
  } catch {
    return null;
  }
}

/** The rental options the agent worked out most recently (from an event's <prechecked> or rental_options). */
function offeredOptions(messages: Msg[]): any {
  let found: any = null;
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (block.type === 'text' && block.text?.includes('<prechecked>')) {
        const prechecked = parseBlock(block.text, 'prechecked');
        if (prechecked?.options) found = prechecked.options;
      }
    }
  }
  return toolRuns(messages, 0).filter((run) => run.name === 'rental_options' && !run.error).at(-1)?.result ?? found;
}

/** What someone asked for about a rental, in working days; null when they asked for nothing of the kind. */
function padAsked(said: string): { before: number; after: number } | null {
  const count = (word: string | undefined): number => (word === undefined ? 0 : word === 'a' || word === 'one' ? 1 : word === 'two' ? 2 : word === 'three' ? 3 : Number(word));
  if (/either side|each side|both sides/.test(said)) {
    const both = count(/\b(a|one|two|three|\d+)\b[^.]*either side|\b(a|one|two|three|\d+)\b[^.]*(?:each|both) sides?/.exec(said)?.[1] ?? 'a');
    return { before: both, after: both };
  }
  const before = /\b(a|one|two|three|\d+) (?:working )?(?:days?|spare days?) (?:before|ahead)/.exec(said)?.[1];
  const after = /\b(a|one|two|three|\d+) (?:working )?(?:days?|spare days?) (?:after|past)/.exec(said)?.[1];
  if (before || after) return { before: count(before), after: count(after) };
  if (/spare day|extra day|one more day/.test(said)) return { before: 0, after: 1 };
  return null;
}

export function decide(body: { messages: Msg[] }): MockTurn {
  const messages = body.messages;
  const start = turnStart(messages);
  const text = blocksOf(messages[start]!)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
  const inTurn = toolRuns(messages, start);
  const ran = (name: string): ToolRun | undefined => [...inTurn].reverse().find((run) => run.name === name);
  const failed = inTurn.find((run) => run.error && run.name !== 'reply' && !run.name.startsWith('show_'));
  if (failed) {
    if (ran('reply') && inTurn.indexOf(ran('reply')!) > inTurn.indexOf(failed)) return end();
    return tool([reply(`I couldn't do that: ${String(failed.result).replace(/^Invalid arguments: /, '').split('\n')[0]}`)]);
  }

  // ---- a watch rule asked for a look ------------------------------------------------------------
  if (text.includes('type="watch_fired"')) {
    const findings = parseBlock(text, 'findings') ?? { rule: 'A watch rule', condition: '', found: [] };
    const found = (findings.found ?? []) as { title: string; task_ids: number[] }[];
    // The app draws these cards itself, live from the plan: only the words are left.
    if (findings.card) {
      if (ran('reply')) return end();
      return tool([
        reply(
          findings.card === 'show_invoices'
            ? `${found[0]?.title ?? 'The work is finished'}: the invoice is ready to send.`
            : `I found ${found.length === 1 ? 'one rental' : `${found.length} rentals`} to look at. Start with any machine booked twice: moving that work changes how long the others stand idle.`,
        ),
      ]);
    }
    if (findings.condition === 'idle_rental') {
      const issues = ran('find_issues');
      if (!issues) return tool([call('find_issues', {})]);
      const issue = (issues.result.issues as any[]).find((candidate) => candidate.kind === 'idle_equipment' && candidate.booking_id);
      if (issue) {
        const evaluated = ran('rental_options');
        if (!evaluated) return tool([call('rental_options', { booking_id: issue.booking_id })]);
        if (ran('show_issue_card')) return end();
        if (evaluated) {
          const options = evaluated.result;
          return tool([
            reply(
              `Your rule “${findings.rule}” is right: the crane arrives ${options.now.text.from} but ${options.activity.name} can't start until ${day(options.activity.first_day)}. ` +
                `I'd go with ${String(options.recommended?.label ?? 'the days of the work').toLowerCase()}, which ${options.recommended?.text.change ?? 'keeps it as it is'}. Want me to prepare it?`,
            ),
            call('show_issue_card', issueCard(issue, options)),
          ]);
        }
      }
    }
    if (ran('reply')) return end();
    const ids = [...new Set(found.flatMap((item) => item.task_ids))].slice(0, 30);
    const top = found[0]?.title ?? 'something worth a look';
    const blocks = [
      reply(
        `Your rule “${findings.rule}” found ${found.length === 1 ? 'one thing' : `${found.length} things`}: ${top}${found.length > 1 ? ', and more' : ''}. ` +
          'Options: move the work that holds it up, put another crew on it, or accept it and tell the team — shall I check the schedule around it first?',
      ),
    ];
    if (ids.length > 0) blocks.push(call('show_tasks', { title: `What “${findings.rule}” found`, task_ids: ids, note: null, show_in_plan: true }));
    return tool(blocks);
  }

  // ---- app events, and "what is wrong?" ------------------------------------------------------
  const asked = (/<utterance[^>]*>\s*([\s\S]*?)\s*<\/utterance>/.exec(text)?.[1] ?? '').toLowerCase().split('\n')[0]!;
  const askedWhatsWrong = /what('|’)?s wrong|what is wrong|any (problems|issues)|needs? (my )?attention|problem with|issue with|why is the crane idle|anything wrong/.test(asked);
  if (/type="(meeting_started|plan_changed)"/.test(text) || askedWhatsWrong) {
    let issue: any;
    let options: any;
    const prechecked = parseBlock(text, 'prechecked');
    const selected = ((/<selected_tasks count="\d+">([\s\S]*?)<\/selected_tasks>/.exec(text)?.[1] ?? '').match(/"id":(\d+)/g) ?? []).map((part) => Number(part.slice(5)));
    if (prechecked) {
      issue = prechecked.issue;
      options = prechecked.options;
    } else {
      const found = ran('find_issues');
      if (!found) return tool([call('find_issues', selected.length ? { task_ids: selected } : {})]);
      if (askedWhatsWrong && found.result.count === 0) {
        return ran('reply') ? end() : tool([reply(selected.length ? 'I checked the selected tasks and found nothing wrong with them.' : 'I looked over the plan and found nothing worth raising.')]);
      }
      issue = (found.result.issues as any[]).find((candidate) => candidate.worth_raising && !candidate.explained_by && !candidate.already_being_fixed);
      if (!issue && askedWhatsWrong) {
        const minor = (found.result.issues as any[])[0];
        return ran('reply') ? end() : tool([reply(`Nothing urgent: the biggest thing I see is that ${String(minor.title).replace(/^./, (c: string) => c.toLowerCase())}.`)]);
      }
      if (!issue) return ran('stay_quiet') ? end() : tool([call('stay_quiet', { reason: 'Nothing worth raising: the rest has no fix on offer or is already handled.' })]);
      if (!issue.booking_id) {
        return tool([
          reply(`Heads-up: ${String(issue.title).replace(/^./, (c: string) => c.toLowerCase())}. ${issue.why} There is no fix on offer for it yet.`),
          call('show_issue_card', { issue_id: issue.id, headline: issue.title, detail: issue.why, severity: issue.severity, money: null, timeline: null, facts: [], remedy: null, actions: [{ label: 'Not now', kind: 'not_now' }] }),
        ]);
      }
      const evaluated = ran('rental_options');
      if (!evaluated) return tool([call('rental_options', { booking_id: issue.booking_id })]);
      options = evaluated.result;
    }
    if (ran('show_issue_card')) return end();
    return tool([
      reply(
        `I noticed the crane arrives ${options.now.text.from} but ${options.activity.name} can't start until ${day(options.activity.first_day)}, so ${options.now.idle_days_before + options.now.idle_days_after} booked days have no work planned. ` +
          `Nothing is paid yet: ${String(options.recommended?.label ?? 'the days of the work').toLowerCase()} ${options.recommended?.text.change ?? 'keeps it as it is'} — want me to prepare it?`,
      ),
      call('show_issue_card', issueCard(issue, options)),
    ]);
  }

  // ---- people talking --------------------------------------------------------------------------
  // What the person typed, without the context the browser sends along with it (the action, the
  // selected tasks, the approval mode): "<approval_mode>" alone would read as asking about approvals.
  const said = (/<utterance[^>]*>\s*([\s\S]*?)\s*<\/utterance>/.exec(text)?.[1] ?? '').split(/\n?<(?:action|selected_tasks|approval_mode)\b/)[0]!.toLowerCase();
  const speaker = /speaker="([^"]+)"/.exec(text)?.[1] ?? 'Someone';
  const all = toolRuns(messages, 0);
  const action = parseBlock(text, 'action');

  // ---- the plan and the library ------------------------------------------------------------------
  if (action?.kind === 'library_drop') {
    const detail = action.detail;
    const places = ran('find_similar_places');
    if (!places) return tool([call('find_similar_places', { top_ids: detail.top_ids, anchor_id: detail.anchor_id, parent_id: detail.parent_id })]);
    const fitting = (places.result.places as any[]).filter((place) => place.add_snippet);
    if (fitting.length === 0) return ran('stay_quiet') ? end() : tool([call('stay_quiet', { reason: 'No other place in the plan looks like where it was dropped.' })]);
    const drafted = ran('draft_plan_edit');
    if (!drafted) {
      // Buying and delivery happen once for the whole building: the other places get the rest, and the one order buys for all.
      const dropped = (places.result.dropped ?? []) as { id: number; name: string; cost_dollars: number; buys: boolean }[];
      // Buying is once for the building; deliveries stay with each floor.
      const once = dropped.filter((task) => task.buys);
      const split = once.length > 0 && once.length < dropped.length;
      const order = split ? once.find((task) => /order|buy|purchas|procur/i.test(task.name) && task.cost_dollars > 0) : undefined;
      const serves = fitting.length + 1;
      return tool([
        reply(
          `${first(speaker)}, ${fitting.length === 1 ? 'one other place looks' : `${fitting.length} other places look`} the same.${
            split ? ` The materials are bought once for the whole building, so I'd add just the rest there${order ? ' and have the one order cover them all' : ''}.` : ''
          } Add “${detail.name}” there too?`,
        ),
        call('draft_plan_edit', {
          title: `Add “${detail.name}” to ${fitting.length} more place${fitting.length === 1 ? '' : 's'}`,
          operations: [
            ...fitting.map((place) => ({
              op: 'add_snippet',
              snippet_id: detail.snippet_id,
              mode: detail.mode,
              ...place.add_snippet,
              ...(split ? { leave_out: once.map((task) => task.name), waits_for: once.at(-1)!.id } : {}),
            })),
            ...(order ? [{ op: 'set_cost', task: order.id, amount: order.cost_dollars * serves, label: `${detail.name}, ${serves} places` }] : []),
          ],
        }),
      ]);
    }
    if (ran('show_plan_edit')) return end();
    return tool([call('show_plan_edit', { edit_id: drafted.result.edit_id, title: `Add “${detail.name}” to the similar places`, reason: 'These places are laid out like the one you dropped it into.', selectable: false })]);
  }

  if (action?.kind === 'apply_edit') return ran('reply') ? end() : tool([reply("Done: it's in everyone's plan.")]);
  if (action?.kind === 'save_snippet') return ran('reply') ? end() : tool([reply('It’s in the library. Drag it onto any floor and I’ll say where it fits before it goes in.')]);

  // ---- a piece of work for the library, and rules in plain words ------------------------------------
  if (/\bdraft\b.*\blight fixtures?\b/.test(said)) {
    const drafted = ran('draft_snippet');
    if (!drafted) {
      const task = (key: string, name: string, duration: number, amount: number, payee: string, crew: string | null) => ({
        key,
        name,
        duration,
        ...(crew ? { crews: [{ name: crew }] } : {}),
        costs: [{ label: name, payee, amount, due: 'on_completion' }],
      });
      return tool([
        call('draft_snippet', {
          name: 'Light fixtures',
          summary: 'Order, deliver, install and test the light fixtures on one floor.',
          icon: 'lightbulb',
          unit: { one: 'floor', many: 'floors' },
          children: [
            task('order', 'Order light fixtures', 1, 12400, 'Lumen & Co Lighting', null),
            task('deliver', 'Deliver light fixtures', 1, 900, 'Lumen & Co Lighting', null),
            task('install', 'Install light fixtures', 3, 6200, 'Halden Electrical', 'Halden Electrical'),
            task('test', 'Test light fixtures', 1, 1400, 'Halden Electrical', 'Halden Electrical'),
          ],
          links: [
            { from: 'order', to: 'deliver' },
            { from: 'deliver', to: 'install' },
            { from: 'install', to: 'test' },
          ],
        }),
      ]);
    }
    if (ran('show_snippets') || drafted.error) return end();
    return tool([
      reply('Here’s a light fixtures package: four tasks one after another, with costs. Save it and you can drop it on any floor.'),
      call('show_snippets', { title: 'Light fixtures, ready for the library', drafts: [{ draft_id: drafted.result.draft_id, why: 'Order, deliver, install and test, one after another, so it drops between two tasks and the plan stays one line.' }] }),
    ]);
  }
  if (/\b(idle|booked twice)\b/.test(said) && /\b(tell me|watch|keep an eye|let me know)\b/.test(said)) {
    if (ran('show_rule_draft')) return end();
    return tool([
      reply('I’ll watch every rental for days it sits idle or is booked twice, and bring you fixes when something turns up.'),
      call('show_rule_draft', {
        name: 'Rented equipment idle or booked twice',
        trigger: { kind: 'change' },
        scope: { kind: 'plan' },
        condition: { kind: 'any', of: [{ kind: 'idle_rental' }, { kind: 'crew_overbooked', equipment_only: true }] },
        action: { kind: 'ask_assistant', note: 'Suggest a fix for each rental.' },
        left_out: [],
      }),
    ]);
  }
  if (/\b(bill|invoice)\b/.test(said) && /\b(finished|done|complete)\b/.test(said)) {
    const levels = /levels? 2 and 3/.test(said) ? ['Level 2', 'Level 3'] : ['Level 2'];
    const runs = inTurn.filter((run) => run.name === 'find_tasks');
    if (runs.length < levels.length) return tool([call('find_tasks', { text: 'light', phase: levels[runs.length], leaves_only: true, limit: 12 })]);
    if (ran('show_rule_draft')) return end();
    const ids = runs.flatMap((run) => (run.result.tasks as { id: number; name: string }[]).filter((task) => /light fixture/i.test(task.name)).map((task) => task.id));
    return tool([
      reply('When the light fixtures on each of those floors are finished, I’ll prepare an invoice to the tenant for you to send.'),
      call('show_rule_draft', {
        name: 'Bill the tenant when the light fixtures are finished',
        trigger: { kind: 'change' },
        scope: { kind: 'tasks', task_ids: ids },
        condition: { kind: 'all_done' },
        action: { kind: 'prepare_invoice' },
        left_out: [],
      }),
    ]);
  }
  // A change order: the tenant is billed for the change just added; a person sends it from the card.
  if (/\b(bill|invoice)\b.*\b(tenant|client)\b|\bchange order\b/.test(said)) {
    const drafted = ran('draft_change_invoice');
    if (!drafted) return tool([call('draft_change_invoice', {})]);
    if (ran('show_change_invoice')) return end();
    const already = drafted.result.already_invoiced;
    if (already && already.status !== 'draft' && already.status !== 'failed') {
      return ran('reply') ? end() : tool([reply(`That change is already invoiced${already.number ? `: invoice ${already.number}` : ''}, ${already.status}.`)]);
    }
    return tool([reply('Here’s the PayPal invoice for the change. Send it?'), call('show_change_invoice', { invoice_id: drafted.result.invoice_id })]);
  }

  // ---- how to use the app: a clip, found by what they want to do ------------------------------
  const howTo = /^(?:how (?:do|can|should|would) (?:i|we|you)|show me how(?: to| do i)?|how to)\s+(.+?)[\s?.!]*$/.exec(said.split('\n')[0]!.trim());
  if (howTo) {
    const shown = ran('show_how');
    if (!shown) return tool([reply('Here’s a short clip of how it’s done; the steps are under it.'), call('show_how', { clip: howTo[1] })]);
    if (!shown.error) return end();
    const replied = ran('reply');
    if (replied && inTurn.indexOf(replied) > inTurn.indexOf(shown)) return end();
    return tool([reply("I don't have a clip for that one yet. Tell me what you're trying to do and I'll walk you through it in words.")]);
  }

  if (/handover date|critical path|sets the handover/.test(said)) {
    const path = ran('get_critical_path');
    if (!path) return tool([call('get_critical_path', {})]);
    if (ran('show_tasks')) return end();
    const ids = (path.result.tasks as { id: number }[]).map((task) => task.id).slice(0, 30);
    return tool([
      reply(`The handover on ${path.result.text.finish} is set by a chain of ${path.result.critical_count} tasks with no slack.`),
      call('show_tasks', { title: 'What sets the handover date', task_ids: ids, note: null, show_in_plan: true }),
      call('suggest_next', { suggestions: [{ label: 'Check the schedule', message: 'Check the schedule for problems' }] }),
    ]);
  }

  if (/check the schedule|schedule for problems/.test(said)) {
    const health = ran('check_schedule');
    if (!health) return tool([call('check_schedule', {})]);
    if (ran('show_findings')) return end();
    const failing = (health.result.checks as any[]).filter((check) => !check.passed);
    if (failing.length === 0) return tool([reply(`All ${health.result.total} checks pass.`)]);
    return tool([
      reply(`${health.result.passed} of ${health.result.total} checks pass.`),
      call('show_findings', {
        title: 'Schedule check',
        summary: null,
        findings: failing.slice(0, 8).map((check) => ({ severity: check.severity, text: String(check.detail).slice(0, 180), task_ids: check.task_ids.slice(0, 12), fix_message: null })),
      }),
    ]);
  }

  if (/reusable|repeating/.test(said)) {
    const found = ran('find_repeating_work');
    if (!found) return tool([call('find_repeating_work', {})]);
    if (ran('show_snippets')) return end();
    const drafts = (found.result.candidates as any[]).filter((candidate) => candidate.draft_id && !candidate.already_in_library).slice(0, 2);
    if (drafts.length === 0) return tool([reply('The library already has everything that repeats here.')]);
    return tool([
      reply(`I found ${drafts.length} piece${drafts.length === 1 ? '' : 's'} of work worth keeping.`),
      call('show_snippets', { title: 'Worth keeping in the library', drafts: drafts.map((candidate) => ({ draft_id: candidate.draft_id, why: `${candidate.name}: ${candidate.leaf_count} linked tasks over ${candidate.span_days} working days.` })) }),
    ]);
  }

  if (/workload|overbooked|busy/.test(said)) {
    if (ran('show_chart')) return end();
    return tool([reply("Here is each crew's workload by week."), call('show_chart', { title: 'Crew workload by week', kind: 'crew_workload', crews: null, from: null, to: null, note: null })]);
  }

  // Cost questions: the app does the sums from the live plan; the kind follows the question.
  if (/cost breakdown|break(?:s)? (?:it |the cost )?down|who(?:'s| is| gets) (?:getting )?paid|cash ?flow|money go(?:es)? out|by floor|what .* cost/.test(said)) {
    if (ran('show_chart')) return end();
    const kind = /cash ?flow|money go(?:es)? out|when/.test(said) ? 'cash_flow' : /by floor|floor by floor|each floor/.test(said) ? 'cost_section' : 'cost_ledger';
    const title = kind === 'cash_flow' ? 'When the money goes out' : kind === 'cost_section' ? 'What it costs, floor by floor' : 'Who gets paid';
    return tool([reply('Here it is, from the plan as it stands.'), call('show_chart', { title, kind, crews: null, from: null, to: null, task_ids: null, by: kind === 'cost_ledger' ? (/month/.test(said) ? 'month' : /floor/.test(said) ? 'floor' : 'payee') : null, note: null })]);
  }

  const pad = padAsked(said);
  const preparing = /prepare|go ahead|do it|yes|please/.test(said);
  if (pad || preparing) {
    const worked = ran('rental_options');
    if (!worked) {
      const known = offeredOptions(messages);
      const selected = ((/<selected_tasks count="\d+">([\s\S]*?)<\/selected_tasks>/.exec(text)?.[1] ?? '').match(/"id":(\d+)/g) ?? []).map((part) => Number(part.slice(5)));
      if (!pad && !known) return tool([reply('I have not looked at the rentals yet. Shall I look at the plan for problems first?')]);
      const which = known ? { booking_id: known.booking_id } : selected[0] ? { task_id: selected[0] } : {};
      return tool([call('rental_options', { ...which, ...(pad ? { pad_before_days: pad.before, pad_after_days: pad.after } : {}) })]);
    }
    const option = worked.result.asked ?? worked.result.recommended;
    if (!option) return ran('reply') ? end() : tool([reply('Nothing shorter still covers the work, so I would leave it as it is.')]);
    const drafted = ran('draft_plan_edit');
    if (!drafted) return tool([call('draft_plan_edit', { title: `Crane on rent ${option.text.from} to ${option.text.last_day}`, operations: [option.op] })]);
    if (ran('show_plan_edit')) return end();
    return tool([
      reply(`That puts the crane on rent ${option.text.from} to ${option.text.last_day}: ${option.days} days, ${whole(option.text.cost)}, and it ${option.text.change}.`),
      call('show_plan_edit', { edit_id: drafted.result.edit_id, title: `Crane on rent ${option.text.from} to ${option.text.last_day}`, reason: 'Cover around the work without paying for days nobody needs.', selectable: false }),
    ]);
  }

  if (/who (signs|decides|pays)|approv|final say/.test(said)) {
    return ran('reply') ? end() : tool([reply('Anyone who sees costs pays with one press, within their limit, and the receipt files itself on the task.')]);
  }

  if (/quote|document|receipt/.test(said)) {
    const read = ran('read_documents');
    if (!read) return tool([call('read_documents', { kind: /receipt/.test(said) ? 'receipt' : 'quote' })]);
    if (ran('reply')) return end();
    const doc = read.result.documents?.[0];
    return tool([reply(doc ? `${doc.name}: ${doc.summary ?? 'no summary'}.` : 'There is no such document on file yet.')]);
  }

  if (/status|paid|where are we|payment/.test(said)) {
    const status = ran('get_payment_status');
    if (!status) return tool([call('get_payment_status', {})]);
    if (ran('reply')) return end();
    return tool([reply((status.result.rentals as { supplier: string; payment: string; text: { cost: string } }[]).map((rental) => `${rental.supplier}: ${rental.text.cost}, ${rental.payment}.`).join(' '))]);
  }

  if (/not now|later|no thanks/.test(said)) return tool([reply("Understood — I'll leave the crane booking as it is.")]);
  if (ran('reply')) return end();
  return tool([reply('I can trace what sets the handover date, check the schedule, show crew workload, find reusable work for the library, change a rental’s dates, or tell you where the payment is.')]);
}

/** A `fetch` that answers POST /v1/messages from `decide`. */
export function mockFetch(delayMs = 8) {
  let seq = 0;
  return async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model: string; messages: Msg[] };
    const turn = decide(body);
    seq += 1;
    return streamingResponse(sseEvents(turn, body.model, `msg_mock_${seq.toString().padStart(5, '0')}`), delayMs);
  };
}
