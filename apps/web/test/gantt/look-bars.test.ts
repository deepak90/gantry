/**
 * The bar language (docs/design/bar-language.md) as the renderers decide it: status fill, the
 * shapes for checks and rented equipment, the critical keel, the slipped tail, the PayPal pulse,
 * brackets for phases; what sits beside a bar (only what needs attention) and the hover card.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DomConfig, ProjectModel, TaskModel } from '@bryntum/gantt';
import type { ProjectInlineData } from '@collab/shared';
import {
  barLook,
  carriesWhiteText,
  trackerBadge,
  renderAfterLabel,
  renderTaskBar,
  renderTaskTooltip,
  slipShare,
  type Decorations,
  type LookState,
} from '../../src/gantt/look';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';
import { buildTracker } from '../../src/workflow/decorations';
import { rentalStanding } from '../../src/workflow/rental';
import { snapshotAt, type Stage } from '../workflow/tracker-fixtures';

/** The crane fix's tracker at a stage, as decoration data. */
function buildTrackerBadges(stage: Stage) {
  const snapshot = snapshotAt(stage);
  const booking = { ...snapshot.bookings[0]!, quoted_start: '2026-12-01' };
  const tracker = buildTracker(rentalStanding(snapshot, booking), { canViewCosts: false, currency: 'USD', receiptFiled: false })!;
  return { tracker, badges: [trackerBadge(tracker)] };
}

/** Mon–Fri, 24-hour days like the seed; Monday, November 2, 2026 is day one. */
const DATA: ProjectInlineData = {
  project: { calendar: 'standard', startDate: '2026-11-02', hoursPerDay: 24, daysPerWeek: 5, daysPerMonth: 20 },
  calendarsData: [
    {
      id: 'standard',
      name: 'Standard (Mon-Fri)',
      unspecifiedTimeIsWorking: true,
      intervals: [{ recurrentStartDate: 'on Sat', recurrentEndDate: 'on Mon', isWorking: false }],
    },
  ],
  tasksData: [
    {
      id: 100,
      name: 'Structure',
      expanded: true,
      children: [
        {
          id: 110,
          name: 'Frame',
          expanded: true,
          children: [
            { id: 1, name: 'Pour slab', startDate: '2026-11-02', duration: 2, durationUnit: 'day', percentDone: 100 },
            { id: 2, name: 'Excavate footings', startDate: '2026-11-04', duration: 2, durationUnit: 'day', percentDone: 50 },
            { id: 3, name: 'Inspect footings (hold point)', startDate: '2026-11-06', duration: 1, durationUnit: 'day' },
            { id: 4, name: 'Erect steel frame', startDate: '2026-11-09', duration: 5, durationUnit: 'day' },
            {
              id: 5,
              name: 'Drywall partitions',
              startDate: '2026-11-02',
              duration: 4,
              durationUnit: 'day',
              budgetMinor: 100_000,
              forecastMinor: 150_000,
              baselines: [{ startDate: '2026-11-02', endDate: '2026-11-04' }],
            },
            { id: 6, name: 'Building dried in', startDate: '2026-11-16', duration: 0, durationUnit: 'day' },
          ],
        },
      ],
    },
  ],
  dependenciesData: [
    { id: 1, fromEvent: 1, toEvent: 2, type: 2, lag: 0, lagUnit: 'day' },
    { id: 2, fromEvent: 2, toEvent: 3, type: 2, lag: 0, lagUnit: 'day' },
    { id: 3, fromEvent: 3, toEvent: 4, type: 2, lag: 0, lagUnit: 'day' },
    { id: 4, fromEvent: 4, toEvent: 6, type: 2, lag: 0, lagUnit: 'day' },
  ],
  resourcesData: [
    { id: 1, name: 'Crane', kind: 'equipment', eventColor: '#c2410c' },
    { id: 2, name: 'Site crew', kind: 'labor', eventColor: '#eab308' },
  ],
  assignmentsData: [
    { id: 1, event: 4, resource: 1 },
    { id: 2, event: 4, resource: 2 },
    { id: 3, event: 2, resource: 2 },
  ],
};

const projects: ProjectModel[] = [];

async function load(): Promise<ProjectModel> {
  const project = createProjectModel();
  projects.push(project);
  await loadCollaborativeProject(project, structuredClone(DATA), 'client-1');
  return project;
}

afterEach(() => {
  projects.splice(0).forEach((project) => project.destroy());
});

const task = (project: ProjectModel, id: number) => project.taskStore.getById(id) as TaskModel;

function look(overrides: Partial<LookState> = {}): LookState {
  return { decorations: new Map(), canViewCosts: false, moneyColumns: false, currency: 'USD', groupBy: 'phase', colorBy: 'phase', ...overrides };
}

/** A DomClassList stand-in: collects what the renderer adds. */
function classList() {
  const names = new Set<string>();
  return { names, add: (...added: string[]) => added.forEach((name) => names.add(name)) };
}

function render(state: LookState, record: TaskModel) {
  const renderData = { cls: classList(), wrapperCls: classList(), style: '', iconCls: '' };
  const content = renderTaskBar(state, { taskRecord: record, renderData });
  return { content, wrapper: [...renderData.wrapperCls.names], bar: [...renderData.cls.names], style: renderData.style as string };
}

/** Every text in a DomConfig tree, in order. */
function texts(config: unknown): string[] {
  if (Array.isArray(config)) return config.flatMap(texts);
  if (!config || typeof config !== 'object') return [];
  const node = config as { text?: string; children?: unknown[] };
  return [...(node.text ? [node.text] : []), ...(node.children ?? []).flatMap(texts)];
}

function classes(config: unknown): string[] {
  if (Array.isArray(config)) return config.flatMap(classes);
  if (!config || typeof config !== 'object') return [];
  const node = config as { className?: string; children?: unknown[] };
  return [...(node.className ? node.className.split(' ') : []), ...(node.children ?? []).flatMap(classes)];
}

describe('barLook', () => {
  it('fills by status: ghost before it starts, solid while it runs, flat once done', async () => {
    const project = await load();
    expect(barLook(task(project, 1), look()).classes).toEqual(expect.arrayContaining(['look-status-done', 'look-done']));
    expect(barLook(task(project, 2), look()).classes).toContain('look-status-active');
    expect(barLook(task(project, 4), look()).classes).toContain('look-status-todo');
  });

  it('gives a finished task a check mark instead of its crew icon', async () => {
    const project = await load();
    expect(barLook(task(project, 1), look()).icon).toBe('check');
    expect(barLook(task(project, 4), look()).icon).toBe('weight-hanging');
  });

  it('shapes checks as hexagons and rented equipment as capsules', async () => {
    const project = await load();
    expect(barLook(task(project, 3), look()).classes).toContain('look-checkpoint');
    expect(barLook(task(project, 4), look()).classes).toContain('look-equipment');
    expect(barLook(task(project, 2), look()).classes).not.toEqual(expect.arrayContaining(['look-checkpoint']));
    expect(barLook(task(project, 2), look()).classes).not.toEqual(expect.arrayContaining(['look-equipment']));
  });

  it('puts a keel on unfinished critical work only', async () => {
    const project = await load();
    expect(task(project, 4).critical).toBe(true);
    expect(barLook(task(project, 4), look()).classes).toContain('look-critical');
    expect(barLook(task(project, 1), look()).classes).not.toContain('look-critical'); // done
    expect(task(project, 5).critical).toBe(false);
    expect(barLook(task(project, 5), look()).classes).not.toContain('look-critical');
  });

  it('measures the slipped tail as a share of the bar', async () => {
    const project = await load();
    // Planned Mon–Tue (end Wed 00:00), now Mon–Thu (end Fri 00:00): the last two of four days slipped.
    expect(slipShare(task(project, 5))).toBeCloseTo(0.5, 2);
    const late = barLook(task(project, 5), look());
    expect(late.classes).toContain('look-late');
    expect(late.slip).toBeCloseTo(0.5, 2);
    expect(barLook(task(project, 4), look()).slip).toBe(0);
  });

  it('pulses only while the money of a task is with PayPal, and passes no verdict on idle equipment', async () => {
    const project = await load();
    const paying: Decorations = new Map([[4, { idle: null, ...buildTrackerBadges('pending') }]]);
    expect(barLook(task(project, 4), look({ decorations: paying })).classes).toContain('look-paying');
    const paid: Decorations = new Map([[4, { idle: { start: '2026-11-05', end: '2026-11-09', days: 2, costMinor: null, equipment: 'Crane' }, ...buildTrackerBadges('succeeded') }]]);
    const classesPaid = barLook(task(project, 4), look({ decorations: paid })).classes;
    expect(classesPaid).not.toContain('look-paying');
    expect(classesPaid).not.toContain('look-has-idle');
  });

  it('draws phases and work packages as brackets of two weights, milestones plain', async () => {
    const project = await load();
    expect(barLook(task(project, 100), look()).classes).toEqual(expect.arrayContaining(['look-summary', 'look-summary-phase']));
    expect(barLook(task(project, 110), look()).classes).toEqual(expect.arrayContaining(['look-summary', 'look-summary-package']));
    expect(barLook(task(project, 6), look()).classes.some((name) => name.startsWith('look-status'))).toBe(false);
  });
});

describe('renderTaskBar', () => {
  it('puts the bar language on the wrapper and the icon and name in the bar', async () => {
    const project = await load();
    const { content, wrapper } = render(look(), task(project, 3));
    expect(wrapper).toEqual(expect.arrayContaining(['look-phase-0', 'look-status-todo', 'look-checkpoint']));
    expect(texts(content)).toEqual(['Inspect footings (hold point)']);
    expect(classes(content)).toEqual(expect.arrayContaining(['look-bar-icon', 'look-bar-name']));
  });

  it('hands the slipped share to CSS', async () => {
    const project = await load();
    expect(render(look(), task(project, 5)).style).toContain('--look-slip:50.0%');
  });

  it('colors by crew with ink on a light crew color', async () => {
    const project = await load();
    const excavate = render(look({ colorBy: 'crew' }), task(project, 2));
    expect(excavate.style).toContain('--look-phase:#eab308');
    expect(excavate.bar).toContain('look-ink-dark');
    const steel = render(look({ colorBy: 'crew' }), task(project, 4));
    expect(steel.style).toContain('--look-phase:#c2410c'); // equipment leads
    expect(steel.bar).not.toContain('look-ink-dark');
  });

  it('draws nothing inside phase and milestone bars', async () => {
    const project = await load();
    expect(render(look(), task(project, 100)).content).toBe('');
    expect(render(look(), task(project, 6)).content).toBe('');
  });
});

describe('carriesWhiteText', () => {
  it('passes the phase colors and fails light crew colors', () => {
    for (const color of ['#0369a1', '#c2410c', '#6d28d9', '#be185d', '#047857', '#4338ca', '#64748b']) {
      expect(carriesWhiteText(color)).toBe(true);
    }
    expect(carriesWhiteText('#eab308')).toBe(false);
    expect(carriesWhiteText('#0ea5e9')).toBe(false);
    expect(carriesWhiteText('teal')).toBe(true);
  });
});

describe('renderAfterLabel', () => {
  const after = (state: LookState, record: TaskModel) => {
    const content = renderAfterLabel(state, { taskRecord: record });
    return content === '' ? null : (content.children[0] as DomConfig);
  };

  it('no longer repeats crew names beside a bar', async () => {
    const project = await load();
    expect(after(look(), task(project, 4))).toBeNull();
    expect(after(look(), task(project, 2))).toBeNull();
  });

  it('says how late a task is', async () => {
    const project = await load();
    expect(texts(after(look(), task(project, 5)))).toEqual(['2d late']);
  });

  it('shows the forecast cost to cost viewers while a money column is shown, with no budget verdict', async () => {
    const project = await load();
    expect(texts(after(look({ canViewCosts: true }), task(project, 5)))).toEqual(['2d late']);
    expect(texts(after(look({ canViewCosts: true, moneyColumns: true }), task(project, 5)))).toEqual(['2d late', '$1.5K']);
    expect(texts(after(look({ canViewCosts: false, moneyColumns: true }), task(project, 5)))).toEqual(['2d late']);
  });

  it('carries the payment of a rental with new dates, and nothing for one nobody touched', async () => {
    const project = await load();
    const pending: Decorations = new Map([[4, { idle: null, ...buildTrackerBadges('published') }]]);
    const label = after(look({ decorations: pending }), task(project, 4));
    expect(classes(label)).toEqual(expect.arrayContaining(['look-status']));
    expect(texts(label).join(' ')).toContain('Pending payment');
    expect(classes(after(look(), task(project, 4)))).not.toContain('look-status');
  });

  it('keeps the milestone’s name and date', async () => {
    const project = await load();
    const [name, date] = texts(after(look(), task(project, 6)));
    expect(name).toBe('Building dried in');
    expect(date).toMatch(/^[A-Z][a-z]{2}, Nov \d+$/);
  });
});

describe('renderTaskTooltip', () => {
  it('shows planned against current dates for a late task', async () => {
    const project = await load();
    const html = renderTaskTooltip(look(), task(project, 5));
    expect(html).toContain('look-tip-plan is-late');
    expect(html).toContain('Finishes 2 days later than planned');
  });

  it('names the crews, the critical path and the check', async () => {
    const project = await load();
    const steel = renderTaskTooltip(look(), task(project, 4));
    expect(steel).toContain('Crane');
    expect(steel).toContain('Site crew');
    expect(steel).toContain('On the critical path');
    expect(renderTaskTooltip(look(), task(project, 3))).toContain('A check: the work after it waits until it passes');
  });

  it('carries the tracker and its sentence, and money only for cost viewers', async () => {
    const project = await load();
    const decorations: Decorations = new Map([[4, { idle: null, ...buildTrackerBadges('pending') }]]);
    const html = renderTaskTooltip(look({ decorations }), task(project, 4));
    expect(html).toContain('Processing');
    expect(html).not.toContain('Fix proposed');
    expect(html).not.toContain('look-tip-money');
    expect(renderTaskTooltip(look({ canViewCosts: true }), task(project, 5))).toContain('look-tip-money');
  });

  it('names the crews in the hover card instead of beside the bar', async () => {
    const project = await load();
    expect(renderTaskTooltip(look(), task(project, 2))).toContain('look-tip-crew');
  });
});
