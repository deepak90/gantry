/**
 * Clip: invite someone into a private conversation with Remy. Scene (in the browser only,
 * nothing is in the database): Deepak's private conversation "Crane options before the meeting".
 * Gesture: open it from the conversation list in the Remy tab, press Invite, pick Chris; the line
 * under the title now says he reads it too. The invitation is answered in the browser (write-free
 * sandbox).
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { CM, Recorder, boxOf, clickOn, clipOverlay, glide, openTab, saveClip, signIn, writeFreeSandbox, type ClipMeta, type Crop } from './clip';

const META: ClipMeta = {
  id: 'invite-to-conversation',
  title: 'Invite someone into a conversation',
  summary: 'Open a private conversation, press Invite and pick a project member: they read it from then on.',
  steps: [
    'In the Remy tab, open the conversation from the list.',
    'Private conversations show a lock: only you and Remy read them.',
    'Press Invite and pick a project member.',
    'They read all of it from then on, earlier messages included; the line under the title says who reads it.',
  ],
  topics: ['invite', 'share', 'conversation', 'thread', 'private', 'add someone', 'chat', 'assistant', 'collaborate', 'teammate'],
};

const TITLE = 'Crane options before the meeting';

test(META.title, async ({ page, context }) => {
  const thread = randomUUID();
  const asked = Date.now() - 5 * 60_000;
  const at = (offset: number) => new Date(asked + offset).toISOString();
  const sandbox = await writeFreeSandbox(context, {
    // Deepak's private conversation, in this tab only.
    seed: ({ projectId, userId }) => ({
      agent_threads: [{ id: thread, project_id: projectId, title: TITLE, created_by: userId, created_at: at(0), last_message_at: at(6_000), title_source: 'person', visibility: 'private', costs_shared_by: null, costs_shared_at: null }],
      agent_messages: [
        message(projectId, thread, 'person', userId, 'Let’s work out the crane options here before we take them to the meeting.', at(0)),
        message(projectId, thread, 'assistant', null, 'Starting the rental on Fri, Dec 11 pays Northgate for 7 days instead of 11 and saves $2,400; bringing the frame forward costs nothing but needs Chris to agree to the dates.', at(6_000)),
      ],
    }),
    rpcs: {
      invite_to_agent_thread: (args, box) => {
        box.addRow('agent_thread_members', { thread_id: args.p_thread, user_id: args.p_user, added_by: box.userId, added_at: new Date().toISOString() });
        return box.rows.get('agent_threads')!.find((candidate) => candidate.id === args.p_thread)!;
      },
    },
  });
  await clipOverlay(context);
  await signIn(page, CM);
  await openTab(page, 'assistant');
  await page.mouse.move(900, 700);
  await page.waitForTimeout(1_000);

  // The side panel and its rail, from the top.
  const rail = await boxOf(page.locator('.inspector-rail'));
  const width = 832;
  const crop: Crop = { x: Math.round(rail.x + rail.width - width), y: Math.round(rail.y), width, height: (width * 9) / 16 };

  const recorder = new Recorder(page, crop).start();
  await page.waitForTimeout(700);
  await clickOn(page, page.getByTestId('thread-switcher'), { steps: 30, pause: 350 });
  const option = page.getByTestId('thread-option').filter({ hasText: TITLE });
  await expect(option).toBeVisible();
  await page.waitForTimeout(600);
  await clickOn(page, option, { steps: 20, pause: 400 });
  const audience = page.getByTestId('thread-audience');
  await expect(audience).toContainText('Private: you and Remy');
  await page.waitForTimeout(1_400);

  await clickOn(page, page.getByTestId('thread-invite'), { steps: 25, pause: 400 });
  const member = page.getByTestId('thread-invite-member').filter({ hasText: 'Chris' });
  await expect(member).toBeVisible();
  await page.waitForTimeout(700);
  await clickOn(page, member, { steps: 18, pause: 450 });
  await expect(audience).toContainText('Private: you and Chris');
  await page.waitForTimeout(600);
  const line = await boxOf(audience.locator('.thread-audience-who'));
  await glide(page, { x: line.x + line.width * 0.6, y: line.y + line.height + 26 }, 20);
  await page.waitForTimeout(2_200);
  const recording = await recorder.stop();

  // The outcome: Chris reads it now; the invitation was answered in the browser, nothing else written.
  expect(sandbox.calls.map((call) => call.fn)).toEqual(['invite_to_agent_thread']);
  expect(sandbox.calls[0]!.args).toMatchObject({ p_thread: thread });
  expect(sandbox.blocked).toEqual([]);

  await saveClip(page, META, recording);
});

function message(projectId: string, threadId: string, role: 'person' | 'assistant', authorId: string | null, text: string, createdAt: string) {
  return { id: randomUUID(), project_id: projectId, thread_id: threadId, turn_id: 'clip-turn', role, author_id: authorId, channel: 'text', text, cards: [], action: null, context: null, created_at: createdAt };
}
