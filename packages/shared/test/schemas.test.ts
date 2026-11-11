import { describe, expect, it } from 'vitest';
import {
  ActiveView,
  ActorKind,
  AffectedTask,
  ApprovalScope,
  ApprovalStatus,
  CommandStatus,
  CostComparison,
  DecisionNoteKind,
  Evaluation,
  HandoverImpact,
  MemberRoleSchema,
  PaymentStatus,
  ProposalAssumption,
  ProposalInputs,
  ProposalState,
  ReviewKind,
  ScheduleImpact,
  SupplierConfirmationStatus,
  bryntumId,
  dateOnly,
  decimalAmount,
  minorUnits,
  nonNegativeMinorUnits,
  revisionNo,
  timestamp,
  unresolvedAssumptionKeys,
  uuid,
} from '../src/schemas';

const ID = '00000000-0000-4000-8000-000000000001';

/** Simulates a trip through JSON (Postgres jsonb, Realtime, RPC). */
function viaJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

const inputs: ProposalInputs = {
  new_start: '2026-12-04',
  new_end: '2026-12-10',
};

const resolved: ProposalAssumption = {
  key: 'delivery_date',
  question: 'Can Northgate deliver the crane on Fri, Dec 4?',
  answer: 'Yes',
  resolved_by: 'human',
};

const open: ProposalAssumption = {
  key: 'operator',
  question: 'Does the rental include the crane operator?',
  answer: null,
  resolved_by: null,
};

const scheduleImpact: ScheduleImpact = {
  handover: { published_end: '2026-12-18', proposed_end: '2026-12-18', delta_days: 0 },
  affected_tasks: [
    {
      task_id: 23,
      name: 'Erect steel frame',
      published_start: '2026-11-30',
      published_end: '2026-12-08',
      proposed_start: '2026-12-04',
      proposed_end: '2026-12-12',
    },
    {
      task_id: '_generatedm_7',
      name: 'Phantom task',
      published_start: '2026-12-08',
      published_end: '2026-12-09',
      proposed_start: '2026-12-12',
      proposed_end: '2026-12-13',
    },
  ],
  over_allocations: [
    { resource_id: 7, intervals: [{ start: '2026-12-04', end: '2026-12-06' }] },
  ],
};

const costComparison: CostComparison = {
  currency: 'USD',
  booked_rental_minor: 600000,
  supplier_payment_minor: 360000,
  saving_minor: 240000,
};

const evaluation: Evaluation = {
  source_revision: 12,
  inputs,
  assumptions: [resolved, open],
  schedule_impact: scheduleImpact,
  cost_comparison: costComparison,
  booking_days: { published_billable_days: 10, revised_billable_days: 6, avoided_billable_days: 4, revised_idle_days: 0 },
  unresolved_assumptions: ['operator'],
  evaluated_at: '2026-11-10T14:32:05.123Z',
};

describe('primitives', () => {
  it('dateOnly is strict YYYY-MM-DD', () => {
    expect(dateOnly.parse('2026-11-02')).toBe('2026-11-02');
    expect(dateOnly.safeParse('2024-02-29').success).toBe(true);
    for (const bad of ['2026-02-30', '2023-02-29', '2026-1-2', '11/02/2026', '2026-11-02T00:00:00Z', '2026-11-02 ', 20261102]) {
      expect(dateOnly.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('timestamp needs an instant with Z or an offset', () => {
    for (const good of ['2026-11-10T14:32:05Z', '2026-11-10T14:32:05.123Z', '2026-11-10T14:32:05+00:00', '2026-11-10T14:32:05.123456+00:00', '2026-11-10T09:32:05-05:00']) {
      expect(timestamp.safeParse(good).success, good).toBe(true);
    }
    for (const bad of ['2026-11-10', '2026-11-10T14:32:05', '2026-11-10 14:32:05Z', 1762784000000]) {
      expect(timestamp.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('minorUnits accepts safe integers only', () => {
    expect(minorUnits.parse(-30000)).toBe(-30000);
    expect(minorUnits.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const bad of [1.5, 0.1 + 0.2, Number.NaN, 2 ** 53, '100', null, undefined]) {
      expect(minorUnits.safeParse(bad).success, String(bad)).toBe(false);
    }
    expect(nonNegativeMinorUnits.safeParse(0).success).toBe(true);
    expect(nonNegativeMinorUnits.safeParse(-1).success).toBe(false);
    expect(nonNegativeMinorUnits.safeParse(0.5).success).toBe(false);
  });

  it('uuid, revisionNo and bryntumId', () => {
    expect(uuid.safeParse(ID).success).toBe(true);
    expect(uuid.safeParse('not-a-uuid').success).toBe(false);
    expect(revisionNo.safeParse(0).success).toBe(true);
    expect(revisionNo.safeParse(-1).success).toBe(false);
    expect(revisionNo.safeParse(1.5).success).toBe(false);
    expect(bryntumId.parse(7)).toBe(7);
    expect(bryntumId.parse('_generatedm_1')).toBe('_generatedm_1');
    expect(bryntumId.safeParse('').success).toBe(false);
    expect(bryntumId.safeParse(1.5).success).toBe(false);
    expect(bryntumId.safeParse(null).success).toBe(false);
  });

  it('decimalAmount is text with at most two decimals', () => {
    expect(decimalAmount.parse('900.00')).toBe('900.00');
    expect(decimalAmount.parse('1,200.5')).toBe('1,200.5');
    expect(decimalAmount.safeParse('900.123').success).toBe(false);
    expect(decimalAmount.safeParse('nine hundred').success).toBe(false);
    expect(decimalAmount.safeParse(900).success).toBe(false);
    expect(decimalAmount.safeParse(900.5).success).toBe(false);
  });
});

describe('enums', () => {
  it('pin the vocabularies and their order', () => {
    expect(ProposalState.options).toEqual(['draft', 'evaluated', 'in_review', 'approved', 'published', 'cancelled']);
    expect(ApprovalScope.options).toEqual(['schedule', 'payment']);
    expect(ApprovalStatus.options).toEqual(['active', 'invalidated']);
    expect(PaymentStatus.options).toEqual(['authorized', 'submitted', 'pending', 'succeeded', 'failed', 'unknown']);
    expect(ReviewKind.options).toEqual(['correction', 'comment']);
    expect(CommandStatus.options).toEqual(['pending', 'running', 'succeeded', 'failed', 'rejected', 'cancelled']);
    expect(DecisionNoteKind.options).toEqual(['note', 'open_question', 'decision']);
    expect(ActorKind.options).toEqual(['human', 'agent']);
    expect(SupplierConfirmationStatus.options).toEqual(['pending', 'confirmed']);
    expect(MemberRoleSchema.options).toEqual(['pm', 'cm']);
    expect(ActiveView.options).toEqual(['gantt', 'cost', 'history', 'dashboard']);
  });

  it('reject values outside the vocabulary', () => {
    expect(ProposalState.safeParse('Draft').success).toBe(false);
    expect(PaymentStatus.safeParse('SUCCESS').success).toBe(false);
  });
});

describe('ProposalInputs', () => {
  it('round-trips through JSON', () => {
    expect(ProposalInputs.parse(viaJson(inputs))).toEqual(inputs);
  });

  it('rejects bad dates and inverted intervals', () => {
    expect(ProposalInputs.safeParse({ ...inputs, new_start: '2026-12-4' }).success).toBe(false);
    expect(ProposalInputs.safeParse({ ...inputs, new_end: '2026-02-30' }).success).toBe(false);
    const inverted = ProposalInputs.safeParse({ ...inputs, new_end: '2026-12-04' });
    expect(inverted.success).toBe(false);
    expect(inverted.error?.issues[0]?.path).toEqual(['new_end']);
    expect(ProposalInputs.safeParse({ ...inputs, new_end: '2026-12-01' }).success).toBe(false);
  });

  it('rejects unknown keys and missing fields', () => {
    // The change fee and delivery charge are gone: the cost follows from the dates alone.
    expect(ProposalInputs.safeParse({ ...inputs, rebooking_minor: 90000 }).success).toBe(false);
    const { new_end: _omitted, ...partial } = inputs;
    expect(ProposalInputs.safeParse(partial).success).toBe(false);
  });
});

describe('ProposalAssumption', () => {
  it('accepts open and resolved assumptions', () => {
    expect(ProposalAssumption.parse(viaJson(open))).toEqual(open);
    expect(ProposalAssumption.parse(viaJson(resolved))).toEqual(resolved);
    expect(ProposalAssumption.parse({ ...resolved, resolved_by: 'agent' }).resolved_by).toBe('agent');
  });

  it('keeps answer and resolved_by consistent', () => {
    expect(ProposalAssumption.safeParse({ ...open, answer: 'Yes' }).success).toBe(false);
    expect(ProposalAssumption.safeParse({ ...resolved, answer: null }).success).toBe(false);
    expect(ProposalAssumption.safeParse({ ...resolved, resolved_by: 'system' }).success).toBe(false);
    expect(ProposalAssumption.safeParse({ ...open, key: '' }).success).toBe(false);
  });

  it('lists unresolved keys in order', () => {
    expect(unresolvedAssumptionKeys([resolved, open])).toEqual(['operator']);
    expect(unresolvedAssumptionKeys([open, { ...open, key: 'dates' }])).toEqual(['operator', 'dates']);
    expect(unresolvedAssumptionKeys([resolved])).toEqual([]);
    expect(unresolvedAssumptionKeys([])).toEqual([]);
  });
});

describe('ScheduleImpact', () => {
  it('round-trips through JSON', () => {
    expect(ScheduleImpact.parse(viaJson(scheduleImpact))).toEqual(scheduleImpact);
    expect(HandoverImpact.parse({ published_end: '2026-12-18', proposed_end: '2026-12-16', delta_days: -2 }).delta_days).toBe(-2);
  });

  it('rejects malformed dates, fractional deltas and unknown keys', () => {
    expect(HandoverImpact.safeParse({ ...scheduleImpact.handover, delta_days: 0.5 }).success).toBe(false);
    expect(HandoverImpact.safeParse({ ...scheduleImpact.handover, proposed_end: '2026-12-18T00:00:00' }).success).toBe(false);
    const task = scheduleImpact.affected_tasks[0]!;
    expect(AffectedTask.safeParse({ ...task, proposed_end: 'Dec 12' }).success).toBe(false);
    expect(AffectedTask.safeParse({ ...task, task_id: 1.5 }).success).toBe(false);
    expect(AffectedTask.safeParse({ ...task, delta: 4 }).success).toBe(false);
    expect(ScheduleImpact.safeParse({ ...scheduleImpact, over_allocations: [{ resource_id: 7, intervals: [{ start: '2026-12-04' }] }] }).success).toBe(false);
  });

  it('accepts empty impact lists', () => {
    expect(ScheduleImpact.safeParse({ ...scheduleImpact, affected_tasks: [], over_allocations: [] }).success).toBe(true);
  });
});

describe('CostComparison', () => {
  it('round-trips through JSON', () => {
    expect(CostComparison.parse(viaJson(costComparison))).toEqual(costComparison);
  });

  it('rejects a float in any *_minor field', () => {
    const minorFields = Object.keys(costComparison).filter((key) => key.endsWith('_minor'));
    expect(minorFields).toHaveLength(3);
    for (const field of minorFields) {
      const result = CostComparison.safeParse({ ...costComparison, [field]: 1200.5 });
      expect(result.success, field).toBe(false);
      expect(result.error?.issues[0]?.path, field).toEqual([field]);
    }
  });

  it('rejects negative rental amounts but allows a negative saving (a longer rental)', () => {
    expect(CostComparison.safeParse({ ...costComparison, booked_rental_minor: -1 }).success).toBe(false);
    expect(CostComparison.safeParse({ ...costComparison, supplier_payment_minor: -1 }).success).toBe(false);
    expect(CostComparison.safeParse({ ...costComparison, saving_minor: -120000 }).success).toBe(true);
  });

  it('requires the currency and rejects unknown keys', () => {
    const { currency: _omitted, ...withoutCurrency } = costComparison;
    expect(CostComparison.safeParse(withoutCurrency).success).toBe(false);
    expect(CostComparison.safeParse({ ...costComparison, currency: 'EUR' }).success).toBe(false);
    expect(CostComparison.safeParse({ ...costComparison, total: 1 }).success).toBe(false);
  });
});

describe('Evaluation', () => {
  it('round-trips a complete evaluation through JSON', () => {
    expect(Evaluation.parse(viaJson(evaluation))).toEqual(evaluation);
  });

  it('rejects bad nested records', () => {
    expect(Evaluation.safeParse({ ...evaluation, evaluated_at: '2026-11-10' }).success).toBe(false);
    expect(Evaluation.safeParse({ ...evaluation, source_revision: -1 }).success).toBe(false);
    expect(Evaluation.safeParse({ ...evaluation, inputs: { ...inputs, new_end: '2026-12-01' } }).success).toBe(false);
    expect(Evaluation.safeParse({ ...evaluation, unresolved_assumptions: 'operator' }).success).toBe(false);
    expect(Evaluation.safeParse({ ...evaluation, cost_comparison: null }).success).toBe(false);
    const { booking_days: _days, ...withoutDays } = evaluation;
    expect(Evaluation.safeParse(withoutDays).success).toBe(false);
    expect(Evaluation.safeParse({ ...evaluation, booking_days: { ...evaluation.booking_days, revised_idle_days: -1 } }).success).toBe(false);
  });

  it('reports the path of a deep failure', () => {
    const result = Evaluation.safeParse({
      ...evaluation,
      schedule_impact: { ...scheduleImpact, handover: { ...scheduleImpact.handover, delta_days: 'none' } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['schedule_impact', 'handover', 'delta_days']);
  });
});
