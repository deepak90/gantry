/**
 * The film, as a walkthrough on Harbor Street Offices (`?rails=film`): twelve steps, one press of Next each, played
 * like a call with the assistant. You walk into a plan your team is already working in; the assistant tells you what
 * changed and what it costs; you add the light fixtures by talking; the site view shows the building and the crane on
 * rent with nothing to lift, day by day; the assistant books it for its work and opens the payment for review, and
 * Send payout is yours to press; the building goes back into the chart.
 *
 * Every number the assistant says is read off the screen or the plan at that moment, never written here: a rental's
 * days and dollars come from the site view's own words, the change from the changelog. The teammates are simulated in
 * the page (no account, nothing written), so the walkthrough needs nothing but a browser.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { ASSISTANT_NAME } from '../../assistant/identity';
import { placeFor, showRow } from '../place';
import type { RailScript, RailStep } from '../types';
import { find, findLast } from '../wait';
import { askStep, costStep, dropStep, floorsStep, lookStep } from './floors';

/** Harbor Offices (`HARBOR_IDS.project` in packages/shared/src/seed/harbor.ts). */
const HARBOR = '00000000-0000-4000-8000-000000000002';
const REPLY_MS = 150_000;
const id = (testId: string) => `[data-testid="${testId}"]`;
const SITE = '.fxb.is-shown';
const APPLY = `${id('assistant-card-edit')} ${id('assistant-edit-apply')}:not(:disabled)`;
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const count = (n: number) => WORDS[n] ?? String(n);

const dayOf = (value: Date | string): number => {
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).getTime();
};
const next = (at: number) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
};

/** Machines booked around their work, from the plan itself: the days on rent with no work planned, and the work. */
export function idleRentals(project: ProjectModel): { machine: string; days: number; task: TaskModel }[] {
  const found: { machine: string; days: number; task: TaskModel }[] = [];
  for (const record of (project.assignmentStore as unknown as { allRecords: unknown[] }).allRecords) {
    const assignment = record as { rentalStart?: string | null; rentalEnd?: string | null; event?: TaskModel | null; resource?: { name?: string } | null };
    const task = assignment.event;
    if (!assignment.rentalStart || !assignment.rentalEnd || !task?.startDate || !task.endDate) continue;
    const [from, to] = [dayOf(assignment.rentalStart), dayOf(assignment.rentalEnd)];
    const [start, end] = [dayOf(task.startDate as Date), dayOf(task.endDate as Date)];
    let days = 0;
    for (let at = from; at < to && days < 400; at = next(at)) if (at < start || at >= end) days += 1;
    if (days > 0) found.push({ machine: assignment.resource?.name ?? 'A machine', days, task });
  }
  return found.sort((a, b) => b.days - a.days);
}

/** Opens the site view through the toolbar, if it isn't open, and waits for the building to be up. */
export async function siteView(context: Parameters<RailStep['run']>[0]): Promise<void> {
  if (find(SITE)) return;
  const toggle = await context.wait(() => find<HTMLButtonElement>(id('view-site')), { what: 'the Site view button' });
  await context.hand.click(toggle, context.signal);
  await context.wait(() => find(SITE), { what: 'the site view', timeout: 20_000 });
}

/** Back to the chart, if the site view is up: Close, and the pieces set down as the bars. */
export async function chartView(context: Parameters<RailStep['run']>[0], { quietly = false } = {}): Promise<void> {
  const shut = find<HTMLButtonElement>(id('site-view-close'));
  if (!shut || !find(SITE)) return;
  if (quietly) shut.click();
  else await context.hand.click(shut, context.signal);
  await context.wait(() => (find('.fxb.is-shown') || document.documentElement.classList.contains('fx3d-inset') ? null : true), { what: 'the chart', timeout: 12_000 });
}

/**
 * Into the site view through one bar, as a person goes: a right-click on the bar, then "Show in the site view" in its
 * menu. The camera drops through the bar into its piece. Bryntum opens its menu only for a real right-click, so with
 * the cursor on the bar the menu is opened for it, where the right-click would have.
 */
export async function throughBar(context: Parameters<RailStep['run']>[0], task: TaskModel): Promise<void> {
  const { hand, signal, app } = context;
  const gantt = app.gantt();
  if (!gantt) return siteView(context);
  await showRow(app, task, signal);
  await (gantt as unknown as { scrollTaskIntoView(task: TaskModel, options?: object): Promise<unknown> }).scrollTaskIntoView(task, { block: 'center', animate: false }).catch(() => undefined);
  const bar = await context.wait(() => find<HTMLElement>(`.b-gantt-task-wrap[data-task-id="${String(task.id)}"] .b-gantt-task`), { what: `the bar of “${task.name}”` });
  await hand.rightClick(bar, signal);
  const item = () => find<HTMLElement>('.b-menu .b-menu-item', { text: 'Show in the site view' });
  if (!(await context.wait(item, { what: 'the bar’s menu', timeout: 500 }).catch(() => null))) {
    const menu = (gantt.features as unknown as { taskMenu?: { showContextMenuFor(task: TaskModel, options: { targetElement: HTMLElement }): void } }).taskMenu;
    menu?.showContextMenuFor(task, { targetElement: bar });
  }
  await hand.click(await context.wait(item, { what: '“Show in the site view” in the bar’s menu', timeout: 4000 }), signal);
  await context.wait(() => find(SITE), { what: 'the site view', timeout: 20_000 });
}

const plain = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** Money as said: "$424,000", not "$424,000.00". */
const spokenMoney = (text: string) => text.replace(/(\$[\d,]+)\.00\b/g, '$1');

const WEEKDAYS: Readonly<Record<string, string>> = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

/** When, as said: the changelog's "Mon, Nov 2 2:12 PM" is "on Monday"; older dates go unsaid. */
function spokenWhen(when: string): string {
  const day = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.exec(when)?.[1];
  if (day) return ` on ${WEEKDAYS[day]}`;
  const near = /^(today|yesterday)\b/i.exec(when)?.[1];
  return near ? ` ${near.toLowerCase()}` : '';
}

/** The first work on a floor, by date. */
export function firstWorkOn(project: ProjectModel, floor: string): TaskModel | null {
  const group = placeFor(project, floor);
  if (!group) return null;
  const leaves: TaskModel[] = [];
  (group as unknown as { traverse(visit: (node: TaskModel) => void, skipSelf?: boolean): void }).traverse((node) => {
    if (node.isLeaf && node.startDate) leaves.push(node);
  }, true);
  return leaves.sort((a, b) => (a.startDate as Date).getTime() - (b.startDate as Date).getTime())[0] ?? null;
}

const arrive: RailStep = {
  key: 'arrive',
  label: 'A busy plan',
  caption: { lead: 'Walk into a busy plan.', text: 'Your team is already in it, on their own rows. The assistant joins you like a colleague joining a call.' },
  async prepare(context) {
    context.app.openPanel('assistant');
    // The plan opens on its first weeks, mostly blank; the walkthrough opens where the floors' work is, bars and all.
    const gantt = context.app.gantt() as unknown as { scrollToDate?(date: Date, options?: object): Promise<unknown> } | undefined;
    // By its whole name: "level 1" alone also finds the concrete deck of level 1, under Structure.
    const first = firstWorkOn(context.app.project, 'Level 1 build-out');
    if (gantt?.scrollToDate && first?.startDate) await gantt.scrollToDate(first.startDate as Date, { block: 'start', edgeOffset: 120, animate: false }).catch(() => undefined);
  },
  async run(context) {
    const names = (await context.app.team?.start(2)) ?? [];
    await context.pause(900);
    await context.join();
    const first = names.map((name) => name.split(' ')[0]);
    // Whoever is signed in, by first name.
    const you = context.app.you?.trim().split(/\s+/)[0];
    const hi = you ? `Hi ${you}.` : 'Hi.';
    await context.say(first.length > 0 ? `${hi} ${first.join(' and ')} are in the plan with us.` : `${hi} I’m on.`);
  },
};

const catchUp: RailStep = {
  key: 'catchup',
  label: 'What changed',
  caption: { lead: 'What changed, and what it costs.', text: 'Every change keeps its author and time; the Costs tab keeps the ones that moved money.' },
  you: { text: 'I was out last week. What changed?' },
  async run(context) {
    const { hand, signal, app } = context;
    app.openPanel('history');
    const tab = await context.wait(() => find<HTMLButtonElement>(id('changelog-filter-costs')), { what: 'the changelog’s Costs tab' });
    void context.say('Here’s what moved money.');
    await hand.click(tab, signal);
    const entry = await context.wait(() => find<HTMLElement>('.changelog-entry'), { what: 'a change on the Costs tab', timeout: 8000 }).catch(() => null);
    if (entry) await hand.moveTo(entry, signal);
    const change = spokenMoney(plain(entry?.querySelector('.changelog-line')?.textContent));
    const when = spokenWhen(plain(entry?.querySelector('.changelog-time')?.textContent));
    const idle = idleRentals(app.project)[0];
    const lines = [change ? `${change}${when}.` : 'Nothing that moved money.', idle ? `And the ${idle.machine.toLowerCase()} is on rent ${count(idle.days)} days with nothing to lift.` : ''];
    await context.say(lines.filter(Boolean).join(' '));
  },
};

const site: RailStep = {
  key: 'site',
  label: 'The building',
  caption: { lead: 'In through a bar.', text: 'The plan becomes the ground and the building rises out of it. It comes apart floor by floor, and on the way out every piece flies back to its bar.' },
  you: { text: 'Show me the building.' },
  async prepare(context) {
    await chartView(context, { quietly: true });
  },
  async run(context) {
    const { hand, signal } = context;
    void context.say('Here it is, on its lot.');
    await siteView(context);
    await context.pause(1200);
    // The floors are in the controls, which show as the cursor moves.
    const floors = await context.wait(() => find<HTMLButtonElement>(id('site-view-floors')), { what: 'the floors button' });
    await hand.click(floors, signal);
    const apart = await context.wait(() => find<HTMLButtonElement>('.fxb-floors:not([hidden]) .fxb-apart'), { what: 'Take apart' });
    void context.say('Floor by floor, with the new lights in.');
    await hand.click(apart, signal);
    await context.pause(2400);
    // One floor on its own: the floors above lift away, and a chip says how to get them all back.
    const level = find<HTMLButtonElement>('.fxb-floors li button', { text: /\bLevel 1\b/ });
    if (level) {
      await hand.click(level, signal);
      await context.pause(2600);
      const chip = find<HTMLButtonElement>('.fxb-chip');
      if (chip) await hand.click(chip, signal);
      await context.pause(900);
    }
    await hand.click(apart, signal);
    await hand.click(floors, signal);
    await context.pause(1500);
    void context.say('And back into the plan.');
    await chartView(context);
    await context.pause(600);
  },
};

const days: RailStep = {
  key: 'days',
  label: 'Paying for nothing',
  caption: { lead: 'Paying for nothing.', text: 'Every bar is a way in. The crane’s work opens on its first day on rent, and its days lie on the lot: amber is a day on rent with nothing to lift, and what it costs.' },
  you: { text: 'The client asked about equipment costs on site. What’s the crane doing?' },
  async prepare(context) {
    await chartView(context, { quietly: true });
  },
  async run(context) {
    const { hand, signal, app } = context;
    // The crane, as you asked: after the fixtures go in, the lift may have idle days of its own.
    const rentals = idleRentals(app.project);
    const idle = rentals.find((rental) => /crane/i.test(rental.machine)) ?? rentals[0];
    if (idle) {
      void context.say(`It’s rented for one row, “${plain(idle.task.name)}”. Let me take you in through it.`);
      await throughBar(context, idle.task);
    } else await siteView(context);
    await context.pause(1400);
    // Up onto the crane's hook on an idle day, through the button beside its days: what a day on rent looks like
    // from up there. In 3D the face presses it, not a cursor.
    const ride = idle ? await context.wait(() => find<HTMLButtonElement>(`${id('site-view-ride')}:not([hidden])`), { what: 'the view from the crane', timeout: 4000 }).catch(() => null) : null;
    if (ride) {
      await hand.click(ride, signal);
      await context.say('Here’s what a day on rent buys while the steel isn’t ready: nothing to lift.');
      await context.pause(2400);
      await hand.click(ride, signal);
      await context.pause(1500);
    }
    const button = await context.wait(() => find<HTMLButtonElement>(`${id('site-view-rental-days')}:not([hidden])`), { what: 'the crane’s days' });
    void context.say('Here are its days.');
    await hand.click(button, signal);
    const tag = await context.wait(() => find<HTMLElement>('.fxb-calendar-tag:not([hidden])'), { what: 'the crane’s days on the lot', timeout: 8000 });
    await context.pause(1300);
    await hand.moveTo(tag, signal);
    const title = plain(tag.querySelector('strong')?.textContent);
    const sum = plain(tag.querySelector('span')?.textContent).replace(' · ', ', ');
    await context.say(`${title}. ${sum}: the steel can’t start any sooner, and nothing’s left to lift after it.`);
  },
};

const fix: RailStep = {
  key: 'fix',
  label: 'Book it for the work',
  caption: { lead: 'Change the deal, not the work.', text: 'A rental’s dates are part of the plan: the assistant drafts new ones, one press applies them, and the idle days fold away.' },
  you: { text: 'Can we book the crane only for the days it actually works?', ask: true },
  async prepare(context) {
    context.app.openPanel('assistant');
  },
  async run(context) {
    const { hand, signal } = context;
    const apply = await context.think(context.wait(() => findLast<HTMLButtonElement>(APPLY), { what: 'the crane’s new dates', timeout: REPLY_MS }));
    await hand.moveTo(apply, signal);
    const reply = plain(apply.closest(`${id('assistant-message')}, ${id('assistant-live')}`)?.querySelector('.assistant-text')?.textContent);
    if (reply) await context.say(reply);
    const card = apply.closest(id('assistant-card-edit'));
    await hand.click(apply, signal);
    await context.wait(() => card?.querySelector('.pc-outcome.is-applied') ?? null, { what: 'the new dates to go in', timeout: 60_000 });
    const note = await context.wait(() => find<HTMLElement>('.fxb-toast:not([hidden])'), { what: 'what it saved', timeout: 8000 }).catch(() => null);
    await context.say(plain(note?.querySelector('span')?.textContent) || 'Done. The idle days are gone.');
  },
};

/** Review payment on the rental being paid: the one open in the rentals list, else any, else the rentals card's. */
const REVIEW = [`.rentals-row.is-selected ${id('rental-pay')}`, id('rental-pay'), id('task-equipment-pay'), id('review-pay')].map((testId) => `${testId}:not(:disabled)`);
/** Send payout, in the payout sheet that Review payment opens. */
const SEND = [id('rental-pay-confirmed'), id('task-equipment-pay-confirmed'), id('review-pay-confirmed')].join(', ');

const pay: RailStep = {
  key: 'pay',
  label: 'Pay with PayPal',
  caption: { lead: 'Pay what the plan says.', text: 'The payment is the rental as it stands now, reviewed in PayPal Payouts’ words. You press Send payout; PayPal pays the supplier from your PayPal balance, and the plan shows it paid.' },
  you: { text: 'Good. Let’s pay Northgate.' },
  async run(context) {
    const { hand, signal, app } = context;
    const go = find<HTMLButtonElement>('.fxb-toast:not([hidden]) button:not(.fxb-x)');
    if (go) await hand.click(go, signal);
    else app.openPanel('rentals');
    // The way to the payment may have opened its sheet already; else Review payment opens it. Nothing is paid by either.
    if (!find(SEND)) {
      const review = await context.wait(() => REVIEW.map((selector) => find<HTMLButtonElement>(selector)).find(Boolean), { what: 'Review payment', timeout: 15_000 });
      await hand.click(review, signal);
    }
    const send = await context.wait(() => find<HTMLButtonElement>(SEND), { what: 'Send payout', timeout: 8000 });
    const sheet = send.closest<HTMLElement>('.payout-sheet');
    const firm = plain(sheet?.querySelector('.payout-sheet-firm')?.textContent);
    const total = spokenMoney(plain(sheet?.querySelector('.payout-sheet-total dd')?.textContent));
    const from = plain(sheet?.querySelector('[data-testid$="-from"]')?.textContent).replace(/^Your\b/, 'your');
    // The cursor rests on Send payout, which is the person's to press.
    await hand.moveTo(send, signal);
    await context.say(firm && total ? `It’s ready for you: ${total} to ${firm}, fee included, from ${from || 'your PayPal balance'}. Send payout is yours to press.` : 'It’s ready for you: the crane for the days it works. Send payout is yours to press.');
  },
};

const close: RailStep = {
  key: 'close',
  label: 'Back to the plan',
  caption: { lead: 'One plan, two ways to see it.', text: 'Out the way you came in: back up through the bar, onto the chart. Everyone saw the same changes as they happened.' },
  you: { text: 'That’s it. Thanks, Remy.' },
  async run(context) {
    const { app } = context;
    await chartView(context);
    await context.say('Anytime. I’ll hop off.');
    app.team?.stop();
    await context.leave();
  },
};

export const filmWalk: RailScript = {
  id: 'film',
  projectId: HARBOR,
  assistant: { name: ASSISTANT_NAME },
  steps: [arrive, catchUp, askStep(false), lookStep, costStep, dropStep, floorsStep, site, days, fix, pay, close],
};
