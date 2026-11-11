/**
 * The rule card while the model is still writing it: any field may be missing, at any depth, in any
 * order. A card that throws there takes the whole page with it, so every partial shape must draw.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectModel } from '@bryntum/gantt';
import type { WatchPlan } from '@collab/shared';
import { RuleDraftCardView, type RuleCardEnv } from '../../src/assistant/rule-cards';

const plan: WatchPlan = { today: '2027-01-01', tasks: [], crews: [], overbooked: [] };

const env = (partial: boolean): RuleCardEnv =>
  ({
    currency: 'USD',
    canViewCosts: true,
    active: true,
    partial,
    project: { taskStore: { getById: () => undefined } } as unknown as ProjectModel,
    watch: { rules: [], plan: () => plan, save: async () => true },
    threadId: null,
    dataVersion: 0,
  }) as unknown as RuleCardEnv;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function draw(element: ReactNode): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(element));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('the rule card, half written', () => {
  const halves: unknown[] = [
    {},
    { name: 'A rule' },
    { scope: {} },
    { scope: { kind: 'tasks' } },
    { scope: { kind: 'tasks', task_ids: [12] } },
    { scope: { kind: 'dates' } },
    { scope: { kind: 'crew' } },
    { condition: {} },
    { condition: { kind: 'any' } },
    { condition: { kind: 'any', of: [] } },
    { condition: { kind: 'any', of: [{}] } },
    { condition: { kind: 'any', of: [{ kind: 'idle_rental' }, {}] } },
    { condition: { kind: 'finish_slip' } },
    { trigger: {} },
    { trigger: { kind: 'daily' } },
    { action: {} },
    { action: { kind: 'prepare_invoice' } },
    { left_out: 'not yet a list' },
  ];

  it.each(halves.map((half) => [JSON.stringify(half), half]))('draws %s', (_name, half) => {
    expect(draw(<RuleDraftCardView card={half as never} env={env(true)} />).querySelector('[data-testid="assistant-rule-draft"]')).not.toBeNull();
  });

  it('offers Start watching only once it is whole', () => {
    const drawn = draw(<RuleDraftCardView card={{ name: 'A rule', scope: { kind: 'plan' } }} env={env(true)} />);
    expect(drawn.querySelector('[data-testid="rule-start"]')).toBeNull();
  });

  it('says what it would find when it is whole', () => {
    const drawn = draw(<RuleDraftCardView card={{ name: 'A rule', scope: { kind: 'plan' }, trigger: { kind: 'change' }, condition: { kind: 'idle_rental' }, action: { kind: 'alert' }, left_out: ['the weather'] }} env={env(false)} />);
    expect(drawn.querySelector('[data-testid="rule-now"]')?.textContent).toContain('Nothing to report');
    expect(drawn.querySelector('[data-testid="rule-left-out"]')?.textContent).toContain('the weather');
    expect(drawn.querySelector('[data-testid="rule-start"]')).not.toBeNull();
  });
});
