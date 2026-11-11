/**
 * A proof of the walkthrough on Harbor Offices, played like a call. You ask for a light fixtures package,
 * and the assistant joins and drafts it with costs. It opens the draft to show you what is in it, and
 * when you say the fixtures cost more, it changes that line in front of you and saves the package to the
 * library. It carries the package onto level 1, slowly, the way a person drags, and takes the suggested
 * spot. Then it asks about the other floors, and on your yes it applies them and leaves.
 */
import type { TaskModel } from '@bryntum/gantt';
import { ASSISTANT_NAME } from '../../assistant/identity';
import { DRAFT_EDITOR as BUILDER, draftTasks as builderTasks, editCost } from '../draft';
import { placePackage } from '../place';
import { amountIn } from '../said';
import type { RailScript, RailStep } from '../types';
import { find, findLast } from '../wait';

/** Harbor Offices (`HARBOR_IDS.project` in packages/shared/src/seed/harbor.ts). */
const HARBOR = '00000000-0000-4000-8000-000000000002';
const ASK = 'We’re putting in new light fixtures on every floor. Can you put together a package for that, from ordering to testing, with some rough costs?';
const TARGET_TASK = 'Paint, level 1';
/** How long a reply from the assistant may take. */
const REPLY_MS = 150_000;

const id = (testId: string) => `[data-testid="${testId}"]`;
const EDIT_FIRST = id('assistant-edit-snippet');
const APPLY = `${id('assistant-card-edit')} ${id('assistant-edit-apply')}:not(:disabled)`;

/** The package the assistant drafted, carried from the step that drafts it to the one that drops it. */
let drafted: string | null = null;
/** The drafts already on screen before you asked, so the new one is the one that wasn't. */
let earlier = new Set<Element>();

/** You ask for the package and the assistant drafts it; `join` brings the assistant onto the call first. */
export const askStep = (join: boolean): RailStep => ({
  key: 'ask',
  label: 'One sentence',
  caption: { lead: 'One sentence.', text: 'The assistant joins like a colleague joining a call, and drafts the work with its costs.' },
  you: { text: ASK, ask: true },
  async prepare(context) {
    context.app.newConversation?.();
    context.app.openPanel('assistant');
    // The new conversation shows no drafts; anything still on screen belongs to an older one.
    await context.wait(() => document.querySelectorAll(EDIT_FIRST).length === 0 || null, { what: 'a fresh conversation', timeout: 3000 }).catch(() => undefined);
    earlier = new Set(document.querySelectorAll(EDIT_FIRST));
  },
  async run(context) {
    if (join) await context.join();
    void context.say(join ? 'Hi, I’m on. Drafting it now: order, deliver, install and test, with costs.' : 'On it. Drafting it now: order, deliver, install and test, with costs.');
    const edit = await context.think(
      context.wait(() => [...document.querySelectorAll<HTMLElement>(EDIT_FIRST)].filter((button) => !earlier.has(button)).at(-1), { what: 'the drafted package', timeout: REPLY_MS }),
    );
    const card = edit.closest('section');
    drafted = card?.querySelector('strong')?.textContent?.trim() ?? null;
    await context.hand.moveTo(card?.querySelector('header') ?? edit, context.signal);
  },
});

export const lookStep: RailStep = {
  key: 'look',
  label: 'What’s in it',
  caption: { lead: 'What’s in it.', text: 'Every task, what it costs and who gets paid, before anything is saved.' },
  you: { text: 'Open it up, let’s see what’s in there.' },
  async prepare(context) {
    context.app.openPanel('assistant');
  },
  async run(context) {
    const { hand, signal } = context;
    const edit = await context.wait(() => findLast<HTMLButtonElement>(EDIT_FIRST), { what: 'Edit first' });
    // Said while the hand works; the next line waits for it, as a newer line takes over from an older one.
    const opening = context.say('Sure, let me open it up.');
    await hand.click(edit, signal);
    await context.wait(() => find(BUILDER), { what: 'the package editor' });
    const tasks = await context.wait(() => {
      const found = builderTasks();
      return found.length > 0 ? found : null;
    }, { what: 'the tasks in the package' });
    await opening;
    void context.say(`${tasks.length} tasks: order, deliver, install and test, and what each one costs.`);
    // Reads down the tasks, then over to what they come to.
    for (const task of tasks.slice(0, 6)) {
      await hand.moveTo(task.cell, signal);
      await context.pause(320);
    }
    await hand.moveTo(() => find(id('builder-cost-total')), signal);
    await context.pause(500);
  },
};

export const costStep: RailStep = {
  key: 'cost',
  label: 'Change a cost',
  caption: { lead: 'Change it together.', text: 'Say what’s off, and the assistant changes it in front of you, then saves it to the library.' },
  you: { text: 'The fixtures should be more like 7,500. That’s what we paid on the last job.' },
  async run(context) {
    const { hand, signal, said } = context;
    // The amount you named and the line your words are about: the hand types what you said.
    const named = amountIn(said);
    if (named === null) throw new Error('No amount was heard. Say the price again, then press Next.');
    await context.wait(() => find(BUILDER), { what: 'the package editor' });
    void context.say(`Got it, ${named.toLocaleString('en-US')}.`);
    // Right in the task's Cost cell, where everyone sees the cursor do it.
    await editCost(hand, said, named, signal);
    await context.pause(300);
    await hand.moveTo(() => find(id('builder-cost-total')), signal);
    await context.pause(700);
    void context.say('Updated. Saving it to the library.');
    const save = await context.wait(() => find<HTMLButtonElement>(`${id('builder-save')}:not(:disabled)`), { what: 'Save to library' });
    await hand.click(save, signal);
    await context.wait(() => (!find(BUILDER) && findLast('.pc-outcome.is-saved')) || null, { what: 'the package in the library', timeout: 30_000 });
  },
};

export const dropStep: RailStep = {
  key: 'drop',
  label: 'Drop it anywhere',
  caption: { lead: 'Drop it anywhere.', text: 'It works out where the work belongs on the floor, then thinks about the floors that look the same.' },
  async prepare({ app }) {
    app.openPanel('library');
  },
  async run(context) {
    const { hand, signal, app } = context;
    const target = (app.project.taskStore as unknown as { allRecords: TaskModel[] }).allRecords.find((task) => task.name === TARGET_TASK);
    if (!target) throw new Error(`There is no task called “${TARGET_TASK}”`);
    void context.say('Let me put it on level 1…');
    // Carried slowly onto the row, then the spot the assistant suggests.
    const placed = await context.think(placePackage(hand, app, () => app.openPanel('library'), drafted ?? 'Light fixtures', target, signal));
    // Where it went, as the library says ("Added Light fixtures. After “Ceiling grid, level 1”."): dropped anywhere on
    // the floor, it goes where the work belongs.
    const after = /After [“"]([^”"]+)[”"]/.exec(placed)?.[1];
    void context.say(after ? `It belongs right after the ${after.charAt(0).toLowerCase()}${after.slice(1)}.` : 'That’s where it fits.');
    app.openPanel('assistant');
    const apply = await context.think(context.wait(() => findLast<HTMLButtonElement>(APPLY), { what: 'the offer for the other floors', timeout: REPLY_MS }));
    await hand.moveTo(apply, signal);
    // What the assistant actually wrote with the offer: the floors, and what it noticed about them.
    const noticed = apply.closest(`${id('assistant-message')}, ${id('assistant-live')}`)?.querySelector('.assistant-text')?.textContent?.replace(/\s+/g, ' ').trim();
    await context.say(noticed || 'Levels 2 and 3 look the same. Want it there too?');
  },
};

export const floorsStep: RailStep = {
  key: 'floors',
  label: 'The other floors',
  caption: { lead: 'The other floors.', text: 'A building orders once: the other floors get just the install and testing, and the one order covers them all. One yes, as one change you can undo.' },
  you: { text: 'Good call. Yes, go ahead.' },
  async prepare(context) {
    context.app.openPanel('assistant');
  },
  async run(context) {
    const apply = await context.wait(() => findLast<HTMLButtonElement>(APPLY), { what: 'the offer for the other floors', timeout: REPLY_MS });
    const card = apply.closest(id('assistant-card-edit'));
    await context.hand.click(apply, context.signal);
    // Done when the card says who applied it, not when the button starts working.
    await context.wait(() => card?.querySelector('.pc-outcome.is-applied') ?? null, { what: 'the change to go in', timeout: 60_000 });
    await context.say('Done. The other floors have it too.');
  },
};

export const leaveStep: RailStep = {
  key: 'leave',
  label: 'The assistant leaves',
  caption: { lead: 'Done.', text: 'Every floor has its install and testing, one order covers the building, and it’s all one change you can undo.' },
  async run(context) {
    await context.say('That’s every floor. I’ll hop off.');
    await context.leave();
  },
};

export const floorsProof: RailScript = {
  id: 'floors',
  projectId: HARBOR,
  assistant: { name: ASSISTANT_NAME },
  steps: [askStep(true), lookStep, costStep, dropStep, floorsStep, leaveStep],
};
