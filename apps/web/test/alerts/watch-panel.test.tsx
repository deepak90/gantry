/**
 * The Watch tab on the seed plan with a stand-in watch list: a fresh plan watches nothing and says how
 * to start, recipes add a rule as they are, a rule reads as a sentence (when / if / then) with how
 * often it spoke up, the form asks what the assistant should look for, and the history links the
 * conversation the assistant opened when this person can see it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProjectModel } from '@bryntum/gantt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCH_RECIPES, type WatchPlan, type WatchRuleRow, type WatchRunRow } from '@collab/shared';
import { AlertsPanel } from '../../src/alerts/AlertsPanel';
import type { RuleInput } from '../../src/alerts/api';
import type { WatchList } from '../../src/alerts/useWatchList';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';
import { seedSnapshot } from '../library/harness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = '00000000-0000-4000-8000-000000000001';
const VIEWER = '00000000-0000-4000-8000-000000000012';

const rule = (overrides: Partial<WatchRuleRow> = {}): WatchRuleRow => ({
  id: '00000000-0000-4000-8000-00000000e001',
  project_id: PROJECT,
  name: 'Idle crane',
  scope: { kind: 'plan' },
  condition: { kind: 'idle_rental' },
  trigger: { kind: 'change' },
  action: { kind: 'ask_assistant' },
  enabled: true,
  created_by: VIEWER,
  thread_id: null,
  created_at: '2026-10-25T09:00:00Z',
  updated_at: '2026-10-25T09:00:00Z',
  ...overrides,
});

const run = (overrides: Partial<WatchRunRow> = {}): WatchRunRow => ({
  id: '00000000-0000-4000-8000-00000000f001',
  project_id: PROJECT,
  rule_id: rule().id,
  situation: `${rule().id}:3104`,
  fingerprint: `${rule().id}:3104:4`,
  severity: 'high',
  title: 'Crane booked 4 days before Erect structural steel frame can start',
  detail: 'Idle crane',
  task_ids: [3104],
  revision: 3,
  thread_id: '00000000-0000-4000-8000-00000000a001',
  fired_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  resolved_at: null,
  ...overrides,
});

/** A plan the form's preview reads: one task with a crane idle in front of it. */
const plan: WatchPlan = {
  today: '2026-10-25',
  tasks: [
    {
      id: 3104,
      name: 'Erect structural steel frame',
      wbs: '2.4.2',
      parentId: null,
      isLeaf: true,
      isMilestone: false,
      start: '2026-12-11',
      end: '2026-12-18',
      startSlipDays: 0,
      finishSlipDays: 0,
      slackDays: 2,
      percentDone: 0,
      budgetMinor: 0,
      forecastMinor: 0,
      spentMinor: 0,
      crewIds: [],
      idle: { days: 4, costMinor: null, equipment: 'Crane' },
    },
  ],
  crews: [],
  overbooked: [],
};

function watchList(overrides: Partial<WatchList> = {}): WatchList & { save: ReturnType<typeof vi.fn> } {
  return {
    ready: true,
    rules: [],
    runs: [],
    freshRuns: [],
    plan: () => plan,
    alerts: [],
    fresh: [],
    error: null,
    save: vi.fn(async (_rule: RuleInput) => true),
    remove: vi.fn(async () => true),
    dismiss: vi.fn(async () => undefined),
    seen: vi.fn(),
    seenRun: vi.fn(),
    ...overrides,
  } as WatchList & { save: ReturnType<typeof vi.fn> };
}

let project: ProjectModel;
let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  project = createProjectModel();
  await loadCollaborativeProject(project, seedSnapshot(), 'watch-panel');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  project.destroy();
});

function render(watch: WatchList, open: (threadId: string) => void = () => undefined, canOpen = true) {
  act(() =>
    root.render(
      <AlertsPanel
        watch={watch}
        project={project}
        viewerId={VIEWER}
        viewerIsPm={false}
        selected={[]}
        prefill={null}
        showTasks={() => undefined}
        askAssistant={() => undefined}
        canOpenConversation={() => canOpen}
        openConversation={open}
      />,
    ),
  );
}

const click = (element: Element | null | undefined) =>
  act(() => {
    (element as HTMLElement).click();
  });
const part = (key: 'now' | 'rules' | 'history') => click(host.querySelector(`[data-testid=watch-part-${key}]`));

describe('the Watch tab', () => {
  it('watches nothing on a fresh plan and says how to start', () => {
    render(watchList());
    expect(host.textContent).toContain('Nothing is watched yet.');
    click(host.querySelector('[data-testid=watch-start]'));
    expect(host.querySelectorAll('[data-testid=watch-recipe]')).toHaveLength(WATCH_RECIPES.length);
  });

  it('adds a recipe as it is', async () => {
    const watch = watchList();
    render(watch);
    part('rules');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid=watch-recipe-add-idle-rental]')!.click();
    });
    const recipe = WATCH_RECIPES.find((candidate) => candidate.key === 'idle-rental')!;
    expect(watch.save).toHaveBeenCalledWith({ id: null, name: recipe.name, scope: recipe.scope, condition: recipe.condition, trigger: recipe.trigger, action: recipe.action, enabled: true });
  });

  it('reads a rule as a sentence with how often it spoke up', () => {
    render(watchList({ rules: [rule()], runs: [run(), run({ id: '00000000-0000-4000-8000-00000000f002', resolved_at: new Date().toISOString() })] }));
    part('rules');
    const item = host.querySelector('[data-testid=watch-rule]')!;
    expect(item.querySelector('.watch-sentence')!.textContent).toBe('When the plan changes, if the whole plan: rented equipment paid while idle, then ask the assistant for alternatives');
    expect(item.textContent).toContain('Spoke up 2 times, last 5 min ago');
  });

  it('asks in the form what the assistant should look for, and does not guess what the rule would find', () => {
    render(watchList());
    click(host.querySelector('[data-testid=watch-add]'));
    const condition = host.querySelector<HTMLSelectElement>('[data-testid=watch-condition]')!;
    act(() => {
      condition.value = 'idle_rental';
      condition.dispatchEvent(new Event('change', { bubbles: true }));
    });
    click(host.querySelector('[data-testid=watch-then-assistant]'));
    const form = host.querySelector('[data-testid=watch-form]')!;
    expect(form.textContent).toContain('What should it look for?');
    expect(form.textContent).not.toMatch(/right now|speak up/i);
  });

  it('keeps the history, with the conversation when this person can see it', () => {
    const open = vi.fn();
    render(watchList({ rules: [rule()], runs: [run()] }), open);
    part('history');
    const item = host.querySelector('[data-testid=watch-run]')!;
    expect(item.textContent).toContain('Idle crane · 5 min ago · still on');
    click([...item.querySelectorAll('button')].find((button) => button.textContent?.includes('Open the conversation')));
    expect(open).toHaveBeenCalledWith(run().thread_id);

    render(watchList({ rules: [rule()], runs: [run()] }), open, false);
    expect(host.querySelector('[data-testid=watch-run]')!.textContent).toContain('Remy answered its author privately.');
  });
});
