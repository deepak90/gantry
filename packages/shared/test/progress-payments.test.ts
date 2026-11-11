import { describe, expect, it } from 'vitest';
import { newPayGate, paidAfter, progressPayment, readPayGate, type ProgressTask } from '../src/progress-payments';

const task = (id: number, firm: string | null, valueDollars: number, percentDone: number, paidDollars = 0): ProgressTask => ({
  id,
  name: `Task ${id}`,
  firm,
  valueMinor: valueDollars * 100,
  percentDone,
  paidMinor: paidDollars * 100,
});

describe('progressPayment', () => {
  it('values each firm by its tasks, earned by percent complete, less 10% kept back and what was paid', () => {
    const payment = progressPayment([
      task(1, 'Oakmere Interiors', 14_800, 100),
      task(2, 'Oakmere Interiors', 11_200, 50),
      task(3, 'Halden Electrical', 9_600, 100, 4_000),
      task(4, 'Skyline Ceilings', 6_400, 0),
    ]);
    const oakmere = payment.firms.find((firm) => firm.firm === 'Oakmere Interiors')!;
    expect(oakmere.earnedMinor).toBe(2_040_000);
    expect(oakmere.retainedMinor).toBe(204_000);
    expect(oakmere.dueMinor).toBe(1_836_000);
    expect(oakmere.percentDone).toBeCloseTo((20_400 / 26_000) * 100);
    const halden = payment.firms.find((firm) => firm.firm === 'Halden Electrical')!;
    expect(halden.dueMinor).toBe(864_000 - 400_000);
    expect(payment.firms.find((firm) => firm.firm === 'Skyline Ceilings')!.dueMinor).toBe(0);
    expect(payment.dueMinor).toBe(1_836_000 + 464_000);
    expect(payment.firms[0]!.firm).toBe('Oakmere Interiors');
  });

  it('never owes a firm paid ahead of its work, and leaves out work with no firm or no value', () => {
    const payment = progressPayment([task(1, 'Linwood Painting', 7_900, 20, 5_000), task(2, null, 3_000, 100), task(3, 'Brightside Cleaning', 0, 100)]);
    expect(payment.firms.map((firm) => firm.firm)).toEqual(['Linwood Painting']);
    expect(payment.dueMinor).toBe(0);
  });

  it('writes back exactly what it pays, task by task', () => {
    const payment = progressPayment([task(1, 'A', 1_000.33, 33.3), task(2, 'A', 999.99, 66.7, 10)]);
    const paid = paidAfter(payment);
    const total = [...paid.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBe(payment.dueMinor + payment.paidBeforeMinor);
    expect(paid.get(1)).toBe(payment.firms[0]!.items.find((item) => item.taskId === 1)!.dueMinor);
  });

  it('writes back only the firms named, when only some were paid', () => {
    const payment = progressPayment([task(1, 'A', 1_000, 100), task(2, 'B', 500, 100)]);
    const paid = paidAfter(payment, new Set(['A']));
    expect([...paid.keys()]).toEqual([1]);
  });

  it('keeps back what the gate says, within reason', () => {
    expect(progressPayment([task(1, 'A', 1_000, 100)], 0.05).dueMinor).toBe(95_000);
    expect(progressPayment([task(1, 'A', 1_000, 100)], 0.9).retainage).toBe(0.5);
  });
});

describe('payment gates', () => {
  it('reads back what it writes and nothing else', () => {
    const gate = newPayGate([100]);
    expect(readPayGate(JSON.parse(JSON.stringify(gate)))).toEqual(gate);
    expect(readPayGate(null)).toBeNull();
    expect(readPayGate({ pays: [] })).toBeNull();
  });
});
