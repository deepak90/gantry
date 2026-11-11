/**
 * The steps of the work on a project, one list per kind of project, worked out from the project's own
 * data so they check themselves off on every screen, whoever did them. One list feeds three things:
 * the rail in the header, the coach that points at the next thing after a pause, and the one suggestion
 * above the message box, so they can never disagree.
 *
 * - Rentals (several machines on rent): a rule finds what they cost, you decide, PayPal pays the firms.
 * - Floors (a plan of "Level n" groups): a package of work on every floor, billed as the floors finish.
 *
 * A step's offer is what one press can do for it. There is none where the assistant's newest card
 * already says what is next.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { conditionsOf, type CurrencyCode, type WatchDismissalRow, type WatchPlan, type WatchRuleRow } from '@collab/shared';
import type { WorkflowSnapshot } from '../workflow/api';
import { rentalReview, type RentalReview } from '../workflow/review';
import { ASSISTANT_NAME } from '../assistant/identity';

export type NextStep =
  | { kind: 'say'; label: string }
  | { kind: 'library'; label: string }
  | { kind: 'finish'; label: string; taskIds: number[] }
  | { kind: 'open-project'; label: string; projectId: string };

export interface StoryStep {
  key: string;
  label: string;
  hint: string;
  done: boolean;
  /** Where the coach points: selectors, the first one on screen wins. */
  targets: string[];
  /** The side panel this step happens in. */
  panel: 'assistant' | 'library';
  offer?: NextStep;
}

export interface Story {
  /** What the steps are about, in one line. */
  pitch: string;
  /** What "done" looks like. */
  goal: string;
  steps: StoryStep[];
  /** What is offered once every step is done. */
  then?: NextStep;
}

const tab = (id: string) => `[data-testid="inspector-tab-${id}"]`;
const id = (testId: string) => `[data-testid="${testId}"]`;
const CHIP = id('assistant-next-chip');

// ---- rentals ---------------------------------------------------------------------------------------

export interface RentalFacts {
  /** A rule watches for idle or twice-booked rentals. */
  watching: boolean;
  /** What the rule found that nobody has accepted or declined yet. */
  undecided: number;
  /** Fixes accepted so far, paid ones included. */
  accepted: number;
  /** Accepted fixes not paid yet. */
  unpaid: number;
  paid: number;
  receipts: number;
  /** The project to go on to when this one is settled. */
  nextProject?: { id: string; name: string };
}

export function rentalsStory(facts: RentalFacts): Story {
  const decided = facts.watching && facts.undecided === 0;
  const settled = decided && facts.unpaid === 0;
  return {
    pitch: 'Find the rentals that cost too much, fix them and pay the firms.',
    goal: 'Every rental is settled',
    then: settled && facts.paid > 0 && facts.nextProject ? { kind: 'open-project', label: `Open ${facts.nextProject.name}`, projectId: facts.nextProject.id } : undefined,
    steps: [
      {
        key: 'rule',
        label: 'Set a rule on the rentals',
        hint: `Tell ${ASSISTANT_NAME} what to watch for, in your own words, then press Start watching.`,
        done: facts.watching,
        targets: [id('rule-start'), CHIP, tab('assistant')],
        panel: 'assistant',
        offer: { kind: 'say', label: 'Tell me when rented equipment is sitting idle or booked twice, and suggest a fix' },
      },
      {
        key: 'accept',
        label: 'Accept a fix',
        hint: 'Press Accept on a rental. The work moves and the numbers on the others update.',
        done: facts.accepted > 0 || decided,
        targets: [id('review-accept'), tab('assistant')],
        panel: 'assistant',
      },
      {
        key: 'decide',
        label: 'Decide the rest',
        hint: 'Accept or decline each rental that is left. Payment opens when none is left.',
        done: decided,
        targets: [id('review-accept'), tab('assistant')],
        panel: 'assistant',
      },
      {
        key: 'pay',
        label: 'Pay with PayPal',
        hint: 'Review payment shows each firm, PayPal’s fee and the total; Send payout pays them from your PayPal balance.',
        done: settled,
        targets: [id('review-pay-confirmed'), id('review-pay'), tab('assistant')],
        panel: 'assistant',
      },
      {
        key: 'receipts',
        label: 'Receipts filed',
        hint: 'A PDF receipt is filed on each task once PayPal confirms the payment.',
        done: settled && facts.receipts >= facts.paid,
        targets: [id('review-receipt'), tab('assistant')],
        panel: 'assistant',
      },
    ],
  };
}

// ---- floors ----------------------------------------------------------------------------------------

export interface Floor {
  name: string;
  /** The tasks on this floor that came from the library. */
  pieceTaskIds: number[];
  pieceDone: boolean;
}

const childrenOf = (task: TaskModel): TaskModel[] => (Array.isArray(task.children) ? (task.children as TaskModel[]) : []);

/** The floors of the plan ("Level n" groups at its top) and the library work on each. */
export function floorsOf(project: ProjectModel): Floor[] {
  const root = (project.taskStore as unknown as { rootNode: { children?: TaskModel[] | boolean } }).rootNode;
  const tops = Array.isArray(root.children) ? root.children : [];
  return tops
    .filter((task) => /^(level|floor)\s*\d+/i.test(task.name ?? ''))
    .map((floor) => {
      const piece = childrenOf(floor).filter((task) => Boolean((task as TaskModel & { libraryRef?: string | null }).libraryRef) && typeof task.id === 'number');
      return { name: floor.name ?? '', pieceTaskIds: piece.map((task) => task.id as number), pieceDone: piece.length > 0 && piece.every((task) => (task.percentDone ?? 0) >= 100) };
    });
}

export interface FloorFacts {
  floors: readonly Floor[];
  /** The library holds a piece the assistant drafted. */
  assistantPiece: boolean;
  /** A rule prepares invoices. */
  billing: boolean;
  /** Invoices sent, paid ones included. */
  invoicesSent: number;
}

const levelOf = (name: string) => /^(level|floor)\s*\d+/i.exec(name)?.[0] ?? name;

export function floorsStory({ floors, assistantPiece, billing, invoicesSent }: FloorFacts): Story {
  const placed = floors.filter((floor) => floor.pieceTaskIds.length > 0).length;
  // Level 1 is not billed here: the rule watches the others.
  const billed = floors.slice(1);
  const unfinished = billed.find((floor) => !floor.pieceDone);
  const finishOffer: NextStep | undefined = unfinished && { kind: 'finish', label: `Mark the light fixtures on ${levelOf(unfinished.name)} finished`, taskIds: unfinished.pieceTaskIds };
  const first = levelOf(floors[0]?.name ?? 'Level 1');
  return {
    pitch: 'Add a package of work to each floor, then bill the tenant as floors finish.',
    goal: 'Every floor is billed',
    steps: [
      {
        key: 'draft',
        label: 'Draft a package of work',
        hint: `Ask ${ASSISTANT_NAME} for a package with costs, check it, then press Save to library.`,
        done: assistantPiece || placed > 0,
        targets: [id('assistant-save-snippet'), CHIP, tab('assistant')],
        panel: 'assistant',
        offer: { kind: 'say', label: 'Draft a light fixtures package: order, deliver, install and test, with costs' },
      },
      {
        key: 'place',
        label: `Drag it onto ${first}`,
        hint: `Drop it anywhere on the floor. ${ASSISTANT_NAME} says where it fits and why; press that to put it there.`,
        done: placed > 0,
        targets: [id('library-card'), CHIP, tab('library')],
        panel: 'library',
        offer: { kind: 'library', label: `Open the library and drag it onto ${first}` },
      },
      {
        key: 'floors',
        label: 'Add it to the other floors',
        hint: `${ASSISTANT_NAME} finds the other floors and asks to add it there too. One Apply adds them all, as one change you can undo.`,
        done: floors.length > 0 && placed >= floors.length,
        targets: [`${id('assistant-card-edit')} .button.is-primary`, tab('assistant')],
        panel: 'assistant',
      },
      {
        key: 'bill',
        label: 'Set a billing rule',
        hint: 'Say when to bill the tenant, then press Start watching.',
        done: billing,
        targets: [id('rule-start'), CHIP, tab('assistant')],
        panel: 'assistant',
        offer: { kind: 'say', label: 'Bill the tenant when the light fixtures on Levels 2 and 3 are finished' },
      },
      {
        key: 'finish',
        label: 'Finish a floor',
        hint: 'Mark the new work on a floor finished. The rule prepares its invoice.',
        done: billed.some((floor) => floor.pieceDone),
        targets: [CHIP, tab('assistant')],
        panel: 'assistant',
        offer: finishOffer,
      },
      {
        key: 'send',
        label: 'Send its invoice',
        hint: 'Check the lines, then send it with PayPal.',
        done: invoicesSent > 0,
        targets: [id('invoice-send'), tab('assistant')],
        panel: 'assistant',
      },
      {
        key: 'rest',
        label: 'Bill the other floors',
        hint: 'Finish each floor that is left and send its invoice.',
        done: billed.length > 0 && invoicesSent >= billed.length,
        targets: [id('invoice-send'), CHIP, tab('assistant')],
        panel: 'assistant',
        offer: finishOffer,
      },
    ],
  };
}

// ---- which story, and where it stands --------------------------------------------------------------

export interface StoryInput {
  project: ProjectModel;
  snapshot: WorkflowSnapshot | null;
  rules: readonly WatchRuleRow[];
  plan(): WatchPlan;
  dismissals: readonly WatchDismissalRow[];
  currency: CurrencyCode | null;
  /** Whether the library holds a piece the assistant drafted. */
  assistantPiece: boolean;
  /** The other projects this person can open. */
  otherProjects: readonly { id: string; name: string }[];
}

const watchesRentals = (rule: WatchRuleRow) => conditionsOf(rule.condition).some((condition) => condition.kind === 'idle_rental' || condition.kind === 'crew_overbooked');

/** The steps for this project, or null where there are none. */
export function storyFor({ project, snapshot, rules, plan, dismissals, currency, assistantPiece, otherProjects }: StoryInput): Story | null {
  const floors = floorsOf(project);
  if (floors.length >= 2) {
    const invoicesSent = (snapshot?.invoices ?? []).filter((invoice) => invoice.status === 'sent' || invoice.status === 'paid').length;
    return floorsStory({ floors, assistantPiece, billing: rules.some((rule) => rule.action.kind === 'prepare_invoice'), invoicesSent });
  }
  if (!snapshot || snapshot.bookings.length < 2) return null;
  const rule = rules.find(watchesRentals) ?? null;
  let review: RentalReview | null = null;
  try {
    review = rule && currency ? rentalReview({ snapshot, project, rule, plan: plan(), dismissals, currency }) : null;
  } catch {
    return null; // The steps run above everything else: they go quiet rather than take the plan down.
  }
  const rows = review?.rows ?? [];
  return rentalsStory({
    watching: rule !== null,
    undecided: rows.filter((row) => row.state === 'open').length,
    accepted: rows.filter((row) => row.state !== 'open' && row.state !== 'declined').length,
    unpaid: rows.filter((row) => row.state === 'paying').length + (review?.payable.length ?? 0),
    paid: review?.paidCount ?? 0,
    receipts: snapshot.payments.filter((payment) => payment.status === 'succeeded' && Boolean(payment.receipt_filed_at)).length,
    nextProject: otherProjects[0],
  });
}

/** The first step not done yet (null when every step is done). */
export function currentStep(story: Story): StoryStep | null {
  return story.steps.find((step) => !step.done) ?? null;
}

/** What is offered above the message box right now. */
export function offerOf(story: Story | null): NextStep | null {
  if (!story) return null;
  const step = currentStep(story);
  return (step ? step.offer : story.then) ?? null;
}
