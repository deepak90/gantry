/**
 * Clip: add a watch rule from a recipe. Gesture: open the Watch tab, go to Rules, scroll to the
 * recipes, Add "Work starting this week"; the rule joins the list and reads as a sentence ("When it is
 * 7:00 AM, every day, if …, then …"). The new rule is answered in the browser (write-free sandbox).
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Recorder, boxOf, clickOn, clipOverlay, glide, openTab, saveClip, signIn, writeFreeSandbox, type ClipMeta, type Crop } from './clip';

const META: ClipMeta = {
  id: 'watch-recipe',
  title: 'Watch the plan with a rule',
  summary: 'Open the Watch tab, pick a recipe under Rules, and Add it: the rule reads as a sentence.',
  steps: [
    'Open the Watch tab on the right.',
    'Go to Rules: under your rules are recipes other teams keep.',
    'Press Add on the one you want, or Adjust it first.',
    'It joins your rules and reads as a sentence: when, if, then.',
  ],
  topics: ['watch', 'rule', 'alert', 'recipe', 'notify', 'notified', 'warn me', 'warned', 'keep an eye', 'monitor'],
};

const RECIPE = 'starts-soon';
const RULE = 'Work starting this week';

test(META.title, async ({ page, context }) => {
  const sandbox = await writeFreeSandbox(context, {
    rpcs: {
      save_watch_rule: (args, box) => {
        const now = new Date().toISOString();
        return box.addRow('watch_rules', {
          id: randomUUID(),
          project_id: args.p_project,
          name: args.p_name,
          scope: args.p_scope,
          condition: args.p_condition,
          trigger: args.p_trigger,
          action: args.p_action,
          enabled: args.p_enabled,
          created_by: null,
          created_at: now,
          updated_at: now,
        });
      },
    },
  });
  await clipOverlay(context);
  await signIn(page);
  await openTab(page, null);
  await page.mouse.move(900, 700);
  await page.waitForTimeout(800);

  // The side panel and its rail, from the top of the plan.
  const side = await boxOf(page.locator('.inspector-rail'));
  const width = 832;
  const crop: Crop = { x: Math.round(side.x + side.width - width), y: Math.round(side.y), width, height: (width * 9) / 16 };

  const recorder = new Recorder(page, crop).start();
  await page.waitForTimeout(700);
  await clickOn(page, page.getByTestId('inspector-tab-alerts'), { steps: 30, pause: 350 });
  const panel = page.getByTestId('alerts-panel');
  await expect(panel).toBeVisible();
  await page.waitForTimeout(900);
  await clickOn(page, page.getByTestId('watch-part-rules'), { steps: 25, pause: 300 });
  // A fresh project has no rules yet (the list is read when the plan opens): the recipes come first.
  await expect(page.getByTestId(`watch-recipe-add-${RECIPE}`)).toBeVisible();
  const before = await page.getByTestId('watch-rule').count();
  await page.waitForTimeout(1_000);

  // The panel fits the window: the camera moves down to the recipes, and back up to the rules.
  const recipe = page.getByTestId('watch-recipe').filter({ has: page.getByTestId(`watch-recipe-add-${RECIPE}`) });
  const rail = await boxOf(page.locator('.inspector-rail'));
  const recipeBox = await boxOf(recipe);
  const lowest = rail.y + rail.height - crop.height;
  const down = { ...crop, y: Math.round(Math.min(lowest, Math.max(crop.y, recipeBox.y + recipeBox.height + 40 - crop.height))) };
  await glide(page, { x: recipeBox.x + recipeBox.width * 0.4, y: Math.min(recipeBox.y, down.y + 200) }, 20);
  await recorder.panTo(down, 1_100);
  await glide(page, { x: recipeBox.x + recipeBox.width * 0.4, y: recipeBox.y + recipeBox.height * 0.6 }, 20);
  await page.waitForTimeout(1_200);
  const add = page.getByTestId(`watch-recipe-add-${RECIPE}`);
  await clickOn(page, add, { steps: 25, pause: 450 });
  await expect(add).toHaveText('Added');
  await page.waitForTimeout(1_000);

  // The new rule is last in the list of rules.
  const added = page.getByTestId('watch-rule').filter({ hasText: RULE });
  await expect(added).toHaveCount(1);
  const ruleBox = await boxOf(added);
  const up = { ...crop, y: Math.round(Math.min(down.y, Math.max(crop.y, ruleBox.y + ruleBox.height + 24 - crop.height))) };
  if (up.y !== down.y) await recorder.panTo(up, 1_000);
  await glide(page, { x: ruleBox.x + ruleBox.width * 0.45, y: ruleBox.y + ruleBox.height * 0.5 }, 25);
  await page.waitForTimeout(2_200);
  const recording = await recorder.stop();

  // The outcome: one more rule, reading as a sentence; answered in the browser, nothing else written.
  await expect(page.getByTestId('watch-rule')).toHaveCount(before + 1);
  await expect(added.locator('.watch-sentence')).toContainText(/When it is 7:00 AM, every day, if .+, then /);
  expect(sandbox.calls.map((call) => call.fn)).toEqual(['save_watch_rule']);
  expect(sandbox.calls[0]!.args).toMatchObject({ p_name: RULE, p_condition: { kind: 'starts_soon', days: 5 }, p_trigger: { kind: 'daily', at: '07:00' } });
  expect(sandbox.blocked).toEqual([]);

  await saveClip(page, META, recording);
});
