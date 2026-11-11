/**
 * Cost lines on snippet tasks, carried into a plan copy, and totaled by payee: what is due now (an
 * order once the task starts, a delivery or completion once the task is done), what comes later, and
 * what is paid.
 */
import { describe, expect, it } from 'vitest';
import { planSnippet, SnippetDraft, type Snippet } from '../src/library';
import { payablesByPayee, TaskCostLine, type PayableTask } from '../src/payables';

const fixtures: Snippet = {
  id: '00000000-0000-4000-8000-00000000f001',
  name: 'Light fixtures',
  summary: 'Order, deliver, install and test the light fixtures of one floor',
  icon: 'lightbulb',
  unit: { one: 'floor', many: 'floors' },
  children: [
    { key: 'order', name: 'Order light fixtures', duration: 1, costs: [{ label: 'LED panels, 48', payee: 'Lumen & Co Lighting', amount: 18_400, due: 'on_order' }] },
    { key: 'deliver', name: 'Deliver fixtures to the floor', duration: 1, costs: [{ label: 'Delivery', payee: 'Lumen & Co Lighting', amount: 600, due: 'on_delivery' }] },
    { key: 'install', name: 'Install light fixtures', duration: 4, crews: [{ name: 'Electrical' }], costs: [{ label: 'Installation labor', payee: 'Halden Electrical', amount: 6_200, due: 'on_completion' }] },
    { key: 'test', name: 'Test and tag lighting', duration: 1, costs: [{ label: 'Testing and certificate', payee: 'Calder Commissioning', amount: 900, due: 'on_completion' }] },
  ],
  links: [
    { from: 'order', to: 'deliver', lag: 10 },
    { from: 'deliver', to: 'install' },
    { from: 'install', to: 'test' },
  ],
};

describe('costs on snippet tasks', () => {
  it('accepts costs on tasks: whole dollars, a payee and when it falls due', () => {
    expect(SnippetDraft.safeParse(fixtures).success).toBe(true);
    const bad = (cost: object) => SnippetDraft.safeParse({ ...fixtures, children: [{ key: 'x', name: 'X', duration: 1, costs: [cost] }] }).success;
    expect(bad({ label: 'Panels', payee: 'Lumen', amount: 18400.5, due: 'on_order' })).toBe(false);
    expect(bad({ label: 'Panels', payee: 'Lumen', amount: -1, due: 'on_order' })).toBe(false);
    expect(bad({ label: 'Panels', payee: 'Lumen', amount: 100, due: 'monthly' })).toBe(false);
    expect(bad({ label: '', payee: 'Lumen', amount: 100, due: 'on_order' })).toBe(false);
  });

  it('carries each task\'s costs into every copy of the plan', () => {
    const plan = planSnippet(fixtures, { name: '', scale: 1, repeats: 2 });
    for (const copy of plan.copies) {
      expect(copy.costs).toEqual([]);
      expect(copy.children.map((task) => task.costs.map((cost) => cost.amount))).toEqual([[18_400], [600], [6_200], [900]]);
    }
  });
});

const line = (label: string, payee: string, dollars: number, due: TaskCostLine['due'], paid_ref: string | null = null): TaskCostLine => ({ label, payee, amount_minor: dollars * 100, due, paid_ref });

const floor = (n: number, start: string, end: string, done: number): PayableTask[] => [
  { id: n * 10 + 1, name: `Order light fixtures, level ${n}`, startDate: start, endDate: start, percentDone: done > 0 ? 100 : 0, costLines: [line('LED panels, 48', 'Lumen & Co Lighting', 18_400, 'on_order')] },
  { id: n * 10 + 3, name: `Install light fixtures, level ${n}`, startDate: start, endDate: end, percentDone: done, costLines: [line('Installation labor', 'Halden Electrical', 6_200, 'on_completion')] },
];

describe('payablesByPayee', () => {
  const today = '2026-11-20';

  it('totals by payee: orders due once the task starts, labor once the task is done', () => {
    const tasks = [...floor(1, '2026-11-16', '2026-11-20', 100), ...floor(2, '2026-11-23', '2026-11-27', 0)];
    const payees = payablesByPayee(tasks, today);
    expect(payees.map((payee) => [payee.payee, payee.dueMinor, payee.upcomingMinor])).toEqual([
      ['Lumen & Co Lighting', 1_840_000, 1_840_000],
      ['Halden Electrical', 620_000, 620_000],
    ]);
    const lumen = payees[0]!;
    expect(lumen.lines.map((entry) => [entry.taskName, entry.state, entry.dueDate])).toEqual([
      ['Order light fixtures, level 1', 'due', '2026-11-16'],
      ['Order light fixtures, level 2', 'upcoming', '2026-11-23'],
    ]);
    // A completion is due on the task's last working day (its end is exclusive).
    expect(payees[1]!.lines[0]).toMatchObject({ state: 'due', dueDate: '2026-11-19' });
  });

  it('counts paid lines apart, and an order already under way as due even before its start date', () => {
    const tasks: PayableTask[] = [
      { id: 1, name: 'Order', startDate: '2026-12-01', endDate: '2026-12-02', percentDone: 10, costLines: [line('Panels', 'Lumen', 1_000, 'on_order')] },
      { id: 2, name: 'Install', startDate: '2026-11-01', endDate: '2026-11-05', percentDone: 100, costLines: [line('Labor', 'Halden', 2_000, 'on_completion', 'PAYOUT-ITEM-1')] },
      { id: 3, name: 'No costs', startDate: '2026-11-01', endDate: '2026-11-02', percentDone: 0, costLines: null },
    ];
    const payees = payablesByPayee(tasks, today);
    expect(payees.map((payee) => [payee.payee, payee.dueMinor, payee.upcomingMinor, payee.paidMinor])).toEqual([
      ['Lumen', 100_000, 0, 0],
      ['Halden', 0, 0, 200_000],
    ]);
  });

  it('reads nothing from a plan without cost lines', () => {
    expect(payablesByPayee([], today)).toEqual([]);
  });
});
