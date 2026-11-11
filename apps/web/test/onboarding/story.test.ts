/**
 * The steps check themselves off from the project's data, and what is offered above the message box
 * is always the current step's. Rentals: the rule, a fix, the rest decided, the payment, the receipts.
 * Floors: the assistant's piece, the floors that hold it, the billing rule, then each floor finished
 * and billed. Every step says where the coach points.
 */
import type { ProjectModel } from '@bryntum/gantt';
import type { WatchPlan, WatchRuleRow } from '@collab/shared';
import { describe, expect, it } from 'vitest';
import { currentStep, floorsStory, offerOf, rentalsStory, storyFor, type Floor, type FloorFacts, type RentalFacts } from '../../src/onboarding/story';
import type { WorkflowSnapshot } from '../../src/workflow/api';

describe('rentalsStory', () => {
  const fresh: RentalFacts = { watching: false, undecided: 0, accepted: 0, unpaid: 0, paid: 0, receipts: 0 };
  const at = (facts: Partial<RentalFacts>) => currentStep(rentalsStory({ ...fresh, ...facts }))?.key ?? null;

  it('walks from the rule through the fixes to the receipts', () => {
    expect(at({})).toBe('rule');
    expect(at({ watching: true, undecided: 3 })).toBe('accept');
    expect(at({ watching: true, undecided: 2, accepted: 1, unpaid: 1 })).toBe('decide');
    expect(at({ watching: true, undecided: 0, accepted: 2, unpaid: 2 })).toBe('pay');
    expect(at({ watching: true, undecided: 0, accepted: 2, paid: 2, receipts: 1 })).toBe('receipts');
    expect(at({ watching: true, undecided: 0, accepted: 2, paid: 2, receipts: 2 })).toBeNull();
  });

  it('goes back when a declined rental comes back with new numbers', () => {
    expect(at({ watching: true, undecided: 1, accepted: 1, unpaid: 1 })).toBe('decide');
  });

  it('asks again for the payment PayPal refused', () => {
    // A refused payment stays payable, so the step stays open.
    expect(at({ watching: true, undecided: 0, accepted: 2, unpaid: 2, paid: 0 })).toBe('pay');
  });

  it('is settled when everything is declined, with nothing to pay', () => {
    expect(at({ watching: true, undecided: 0, accepted: 0 })).toBeNull();
  });

  it('offers the rule, nothing while the card leads, then the next project once paid', () => {
    const nextProject = { id: 'harbor', name: 'Harbor Street Offices' };
    expect(offerOf(rentalsStory({ ...fresh, nextProject }))?.label).toContain('rented equipment');
    expect(offerOf(rentalsStory({ ...fresh, watching: true, undecided: 3, nextProject }))).toBeNull();
    expect(offerOf(rentalsStory({ ...fresh, watching: true, accepted: 2, paid: 2, receipts: 2, nextProject }))).toEqual({ kind: 'open-project', label: 'Open Harbor Street Offices', projectId: 'harbor' });
    expect(offerOf(rentalsStory({ ...fresh, watching: true, nextProject }))).toBeNull();
  });
});

describe('floorsStory', () => {
  const bare = (name: string): Floor => ({ name, pieceTaskIds: [], pieceDone: false });
  const levels = (...floors: Partial<Floor>[]): Floor[] => floors.map((floor, index) => ({ ...bare(`Level ${index + 1} build-out`), ...floor }));
  const placed = { pieceTaskIds: [1, 2] };
  const finished = { pieceTaskIds: [3, 4], pieceDone: true };
  const fresh: FloorFacts = { floors: levels({}, {}, {}), assistantPiece: false, billing: false, invoicesSent: 0 };
  const at = (facts: Partial<FloorFacts>) => currentStep(floorsStory({ ...fresh, ...facts }))?.key ?? null;

  it('walks from the piece across the floors to the invoices', () => {
    expect(at({})).toBe('draft');
    expect(at({ assistantPiece: true })).toBe('place');
    expect(at({ assistantPiece: true, floors: levels(placed, {}, {}) })).toBe('floors');
    expect(at({ assistantPiece: true, floors: levels(placed, placed, placed) })).toBe('bill');
    expect(at({ assistantPiece: true, floors: levels(placed, placed, placed), billing: true })).toBe('finish');
    expect(at({ assistantPiece: true, floors: levels(placed, finished, placed), billing: true })).toBe('send');
    expect(at({ assistantPiece: true, floors: levels(placed, finished, placed), billing: true, invoicesSent: 1 })).toBe('rest');
    expect(at({ assistantPiece: true, floors: levels(placed, finished, finished), billing: true, invoicesSent: 2 })).toBeNull();
  });

  it('counts a piece already on a floor as drafted, whoever saved it', () => {
    expect(at({ floors: levels(placed, {}, {}) })).toBe('floors');
  });

  it('offers each step that one press can do, with the next floor to finish', () => {
    const offer = (facts: Partial<FloorFacts>) => offerOf(floorsStory({ ...fresh, ...facts }));
    expect(offer({})?.kind).toBe('say');
    expect(offer({ assistantPiece: true })).toEqual({ kind: 'library', label: 'Open the library and drag it onto Level 1' });
    expect(offer({ assistantPiece: true, floors: levels(placed, {}, {}) })).toBeNull();
    expect(offer({ assistantPiece: true, floors: levels(placed, placed, placed) })?.label).toContain('Bill the tenant');
    expect(offer({ assistantPiece: true, floors: levels(placed, { pieceTaskIds: [5] }, placed), billing: true })).toEqual({ kind: 'finish', label: 'Mark the light fixtures on Level 2 finished', taskIds: [5] });
    expect(offer({ assistantPiece: true, floors: levels(placed, finished, placed), billing: true })).toBeNull();
    expect(offer({ assistantPiece: true, floors: levels(placed, finished, { pieceTaskIds: [6] }), billing: true, invoicesSent: 1 })).toEqual({ kind: 'finish', label: 'Mark the light fixtures on Level 3 finished', taskIds: [6] });
    expect(offer({ assistantPiece: true, floors: levels(placed, finished, finished), billing: true, invoicesSent: 2 })).toBeNull();
  });

  it('sends the library step to the library panel', () => {
    const steps = floorsStory(fresh).steps;
    expect(steps.find((step) => step.key === 'place')?.panel).toBe('library');
    expect(steps.filter((step) => step.key !== 'place').every((step) => step.panel === 'assistant')).toBe(true);
  });
});

describe('storyFor', () => {
  const project = { taskStore: { rootNode: { children: [] } } } as unknown as ProjectModel;
  const snapshot = { bookings: [{}, {}], payments: [] } as unknown as WorkflowSnapshot;
  const rule = { condition: { kind: 'idle_rental' }, action: { kind: 'ask_assistant' } } as unknown as WatchRuleRow;
  const input = { project, snapshot, rules: [] as WatchRuleRow[], plan: () => ({}) as WatchPlan, dismissals: [], currency: 'USD' as const, assistantPiece: false, otherProjects: [] };

  it('has nothing to say on a project with one rental and no floors', () => {
    expect(storyFor({ ...input, snapshot: { ...snapshot, bookings: [{}] } as unknown as WorkflowSnapshot })).toBeNull();
  });

  it('starts the rentals at the rule', () => {
    expect(currentStep(storyFor(input)!)?.key).toBe('rule');
  });

  it('goes quiet rather than take the app down when the rentals cannot be read', () => {
    const plan = () => {
      throw new Error('not ready');
    };
    expect(storyFor({ ...input, rules: [rule], plan })).toBeNull();
  });
});

describe('every step', () => {
  const stories = [
    rentalsStory({ watching: false, undecided: 0, accepted: 0, unpaid: 0, paid: 0, receipts: 0 }),
    floorsStory({ floors: [], assistantPiece: false, billing: false, invoicesSent: 0 }),
  ];

  it('says where the coach points', () => {
    expect(stories.flatMap((story) => story.steps).every((step) => step.targets.length > 0)).toBe(true);
  });

  it('reads like the real thing', () => {
    const words = stories.flatMap((story) => [story.pitch, story.goal, ...story.steps.flatMap((step) => [step.label, step.hint])]).join(' ');
    expect(words).not.toMatch(/\b(demo|sandbox|story|tour|no real money)\b/i);
  });
});
