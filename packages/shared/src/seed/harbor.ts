/**
 * "Harbor Street Offices": a four-story steel-framed office building, from an empty lot to the tenant
 * moving in. The site and its footings, the slab on grade, the steel and metal deck under a tower
 * crane, a concrete deck poured on each level, the roof and the glass, a lobby on the ground floor,
 * then three office floors built out one after another.
 *
 * Every pour is a group of its own, the way a concrete crew works it: forms, rebar, the pour, the cure.
 * Each row of the plan is something that can be seen on the building (fx3d/building.ts reads the names),
 * so the plan and the 3D model are the same thing seen two ways.
 *
 * The plan is one waterfall: every task waits for the one above it, finish to start, so a piece of work
 * added between two tasks moves everything below it and nothing else. What a person would add with a
 * library piece is left out: there are no light fixtures yet, and they belong after a floor's ceiling
 * grid (they hang from it, on the rough-in cabling) and before its ceiling tiles close it up.
 *
 * Two machines are on rent. The tower crane is booked from five days before the steel can start to two
 * days after it is up, a weekend at each end: seven days on rent with nothing to lift. The scissor lift is
 * booked for level 1's ceiling tiles on the dates they have today.
 *
 * The tenant, Larkspur Analytics, is who the project bills: a change it asks for (new light fixtures) goes on
 * a change order, invoiced through PayPal.
 *
 * Pure data, loaded by Node's type stripping as well as by Vite and Vitest (see build.ts).
 */
import { idleRentalDays } from '../rental-days.ts';
import {
  addDays,
  buildSeed,
  must,
  SEED_MEMBERS,
  withRentalDates,
  type DependencySpec,
  type IsoDate,
  type SeedEquipmentBooking,
  type SeedProject,
  type SeedRecords,
  type SeedResourceRow,
  type SummarySpec,
} from './build.ts';

/** The ids of Harbor, or of one of its copies: the project, its two rentals and the crane's written quote. */
export interface HarborIds {
  readonly project: string;
  /** The tower crane's rental, the project's first. */
  readonly booking: string;
  readonly liftBooking: string;
  readonly craneQuote: string;
}

export const HARBOR_IDS = {
  project: '00000000-0000-4000-8000-000000000002',
  /** The tower crane's rental, the project's first. */
  booking: '00000000-0000-4000-8000-000000000251',
  liftBooking: '00000000-0000-4000-8000-000000000252',
  craneQuote: '00000000-0000-4000-8000-000000000261',
} as const satisfies HarborIds;

/** How many private copies of Harbor the hosted demo keeps, one per visitor at a time (`copy_pool`). */
export const HARBOR_COPY_COUNT = 12;

/**
 * The ids of copy `n` (1 to 12). Every row that has an id of its own (the project, its rentals, its quote) gets one
 * per copy: `00000000-0000-4000-8000-0000000` + a kind (100 the project, 151 the crane's rental, 152 the lift's,
 * 161 the crane's quote) + the copy's number in two digits. Copy 1 is `…000000010001`, copy 12 `…000000010012`.
 */
export function harborCopyIds(n: number): HarborIds {
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error(`Seed is inconsistent: there is no Harbor copy ${n}`);
  const id = (kind: string) => `00000000-0000-4000-8000-0000000${kind}${String(n).padStart(2, '0')}`;
  return { project: id('100'), booking: id('151'), liftBooking: id('152'), craneQuote: id('161') };
}

/** Project start: Monday, October 19, 2026, so the film's week finds the foundations done and the frame still to come. */
export const HARBOR_START: IsoDate = '2026-10-19';

const CARPENTERS = 1;
const ELECTRICIANS = 2;
const CEILINGS = 3;
const PAINTERS = 4;
const FLOORING = 5;
const CLEANERS = 6;
const DELIVERIES = 7;
const SITEWORK = 8;
const CONCRETE = 9;
const STEEL = 10;
const ROOFERS = 11;
const GLAZIERS = 12;
const CRANE = 13;
const LIFT = 14;

/** Each floor as built: the size the assistant prices fit-out packages from. */
const FLOOR_NOTE =
  'An office floor of about 4,000 sq ft: about 3,000 sq ft of open plan, 600 sq ft of offices and meeting rooms, and 400 sq ft of corridor, under a 2x4 lay-in ceiling grid. Agreed prices for each light fixture added: $18 to deliver, and Halden Electrical at $108 to install and $10 to test.';

const resources: SeedResourceRow[] = [
  { id: CARPENTERS, name: 'Oakmere Interiors', trade: 'Carpentry', kind: 'labor', company: 'Oakmere Interiors', eventColor: '#5e6a37', iconCls: 'fa fa-hammer', imageUrl: '/crews/logos/oakmere-interiors.png' },
  { id: ELECTRICIANS, name: 'Halden Electrical', trade: 'Electrical', kind: 'labor', company: 'Halden Electrical', eventColor: '#3e6596', iconCls: 'fa fa-bolt', imageUrl: '/crews/logos/halden-electrical.png' },
  { id: CEILINGS, name: 'Skyline Ceilings', trade: 'Ceilings', kind: 'labor', company: 'Skyline Ceilings', eventColor: '#2e7065', iconCls: 'fa fa-table-cells', imageUrl: '/crews/logos/skyline-ceilings.png' },
  { id: PAINTERS, name: 'Linwood Painting', trade: 'Painting', kind: 'labor', company: 'Linwood Painting', eventColor: '#695086', iconCls: 'fa fa-paint-roller', imageUrl: '/crews/logos/linwood-painting.png' },
  { id: FLOORING, name: 'Tessera Flooring', trade: 'Flooring', kind: 'labor', company: 'Tessera Flooring', eventColor: '#4e5c6b', iconCls: 'fa fa-border-all', imageUrl: '/crews/logos/tessera-flooring.png' },
  { id: CLEANERS, name: 'Brightside Cleaning', trade: 'Cleaning', kind: 'labor', company: 'Brightside Cleaning', eventColor: '#64594c', iconCls: 'fa fa-broom', imageUrl: '/crews/logos/brightside-cleaning.png' },
  // Freight to site and up to the floors: no work of theirs is in the plan until a package brings it.
  { id: DELIVERIES, name: 'Carrow Freight', trade: 'Deliveries', kind: 'labor', company: 'Carrow Freight', eventColor: '#7d5a1f', iconCls: 'fa fa-truck' },
  { id: SITEWORK, name: 'Pinecrest Sitework', trade: 'Earthwork', kind: 'labor', company: 'Pinecrest Sitework', eventColor: '#7a6334', iconCls: 'fa fa-tractor' },
  { id: CONCRETE, name: 'Granite Ridge Concrete', trade: 'Concrete', kind: 'labor', company: 'Granite Ridge Concrete', eventColor: '#5f6870', iconCls: 'fa fa-trowel' },
  { id: STEEL, name: 'Ironline Steel', trade: 'Structural steel', kind: 'labor', company: 'Ironline Steel', eventColor: '#3c4f66', iconCls: 'fa fa-industry' },
  { id: ROOFERS, name: 'Summit Roofing', trade: 'Roofing', kind: 'labor', company: 'Summit Roofing', eventColor: '#86503c', iconCls: 'fa fa-house-chimney' },
  { id: GLAZIERS, name: 'Clearview Glazing', trade: 'Curtain wall', kind: 'labor', company: 'Clearview Glazing', eventColor: '#2f6a86', iconCls: 'fa fa-table-columns' },
  { id: CRANE, name: 'Tower crane', trade: 'Equipment rental', kind: 'equipment', company: 'Northgate Equipment Rental', eventColor: '#6c6433', iconCls: 'fa fa-weight-hanging', imageUrl: '/crews/crane.png' },
  { id: LIFT, name: 'Scissor lift', trade: 'Equipment rental', kind: 'equipment', company: 'Apex Access Rentals', eventColor: '#5b4f86', iconCls: 'fa fa-elevator' },
];

/** A concrete deck on the metal deck of one level: forms at its edge, the bars, the pour, the cure. */
function deck(level: 1 | 2 | 3): SummarySpec {
  const base = 40 + level * 10;
  const where = `level ${level}`;
  return {
    id: base,
    name: `Concrete deck, ${where}`,
    note: 'About 50 cubic yards of 3,000 psi concrete, 3 1/4 inches over the 2-inch metal deck.',
    children: [
      { id: base + 1, name: `Edge forms and shoring, ${where}`, duration: 1, budget: 5_200, people: 4, assign: [CONCRETE] },
      { id: base + 2, name: `Rebar and mesh, ${where}`, duration: 1, budget: 6_900, people: 4, assign: [CONCRETE] },
      { id: base + 3, name: `Pour deck, ${where}`, duration: 1, budget: 18_600, people: 7, assign: [CONCRETE], note: 'By pump from the street side, finished with a power trowel.' },
      { id: base + 4, name: `Cure deck, ${where}`, duration: 2, budget: 1_100, people: 1, assign: [CONCRETE] },
    ],
  };
}

/** The same trades on every office floor; ids n11..n18 on floor n. */
function floor(level: 1 | 2 | 3): SummarySpec {
  const base = level * 100;
  const where = `level ${level}`;
  return {
    id: base,
    name: `Level ${level} build-out`,
    code: `L0${level}`,
    note: FLOOR_NOTE,
    children: [
      { id: base + 11, name: `Lay out partitions, ${where}`, duration: 1, budget: 1_200, assign: [CARPENTERS] },
      { id: base + 12, name: `Frame partitions, ${where}`, duration: 5, budget: 14_800, assign: [CARPENTERS] },
      { id: base + 13, name: `Electrical rough-in, ${where}`, duration: 3, budget: 9_600, assign: [ELECTRICIANS], note: 'Cabling to the light locations in the ceiling space and to the floor boxes.' },
      { id: base + 15, name: `Hang and tape drywall, ${where}`, duration: 4, budget: 11_200, assign: [CARPENTERS] },
      { id: base + 14, name: `Ceiling grid, ${where}`, duration: 2, budget: 6_400, assign: [CEILINGS] },
      { id: base + 16, name: `Ceiling tiles, ${where}`, duration: 2, budget: 5_800, assign: level === 1 ? [CEILINGS, LIFT] : [CEILINGS] },
      { id: base + 17, name: `Paint, ${where}`, duration: 4, budget: 7_900, assign: [PAINTERS] },
      { id: base + 18, name: `Floor finishes, ${where}`, duration: 2, budget: 12_400, assign: [FLOORING] },
    ],
  };
}

export const HARBOR_HANDOVER_TASK = 412;
/**
 * The date in the lease: the tenant moves in by Friday, June 11, 2027. The plan aims at Thursday, May 27, ten working
 * days ahead of it (Memorial Day falls between), as a builder keeps float in hand before a contract date.
 */
export const HARBOR_CONTRACT_DATE: IsoDate = '2027-06-11';
/** The payment milestone after the footings: the slab waits until they are paid for. */
export const HARBOR_FOOTINGS_PAID = 25;
/** Erect steel and metal deck: the crane's work. */
export const HARBOR_STEEL_TASK = 41;

const phases: SummarySpec[] = [
  {
    id: 10,
    name: 'Site and foundations',
    code: 'SIT',
    collapsed: true,
    note: 'A corner lot on Harbor Street, about 110 by 80 feet, with the building set back from both streets.',
    children: [
      { id: 11, name: 'Mobilize site', duration: 2, budget: 8_500, people: 3, assign: [SITEWORK], percentDone: 100, paid: 7_650, note: 'Fence and gate, site office, toilets, wheel wash.' },
      { id: 12, name: 'Excavate for footings', duration: 5, budget: 22_000, people: 3, assign: [SITEWORK], percentDone: 100, paid: 19_800 },
      {
        id: 20,
        name: 'Footings',
        note: 'Twelve spread footings under the columns and a strip footing under the core, about 42 cubic yards.',
        children: [
          { id: 21, name: 'Form footings', duration: 4, budget: 9_800, people: 4, assign: [CONCRETE], percentDone: 100 },
          { id: 22, name: 'Rebar, footings', duration: 2, budget: 8_600, people: 4, assign: [CONCRETE], percentDone: 100 },
          { id: 23, name: 'Pour footings', duration: 1, budget: 16_400, people: 6, assign: [CONCRETE], percentDone: 100, note: 'By pump; anchor bolts for the columns set in the wet concrete.' },
          { id: 24, name: 'Strip forms and backfill', duration: 3, budget: 7_200, people: 3, assign: [SITEWORK], percentDone: 100 },
          // Pay to proceed: the slab waits until the footings are paid for (gantt/pay-gates.ts).
          { id: HARBOR_FOOTINGS_PAID, name: 'Footings paid', duration: 0, budget: 0, payGate: { pays: [20], retainage: 0.1, state: 'waiting', batchId: null, paidAt: null, amountMinor: null, error: null } },
        ],
      },
      {
        id: 30,
        name: 'Slab on grade',
        note: 'A 5-inch slab over 6 inches of crushed stone and a vapor barrier, about 62 cubic yards.',
        children: [
          { id: 31, name: 'Gravel base and vapor barrier', duration: 3, budget: 6_100, people: 3, assign: [SITEWORK] },
          { id: 32, name: 'Rebar, slab on grade', duration: 3, budget: 7_400, people: 4, assign: [CONCRETE] },
          // The inspector's own calendar: paid late, the rebar is ready after she has left for Thanksgiving week.
          { id: 35, name: 'City inspection, slab', duration: 1, budget: 0, calendar: 'inspector', note: 'The city inspector signs off the base, vapor barrier and rebar before the pour. Away Thanksgiving week.' },
          { id: 33, name: 'Pour slab on grade', duration: 1, budget: 21_800, people: 7, assign: [CONCRETE], note: 'By pump, finished with a power trowel.' },
          { id: 34, name: 'Cure slab on grade', duration: 7, budget: 1_400, people: 1, assign: [CONCRETE] },
        ],
      },
    ],
  },
  {
    id: 40,
    name: 'Structure',
    code: 'STR',
    collapsed: true,
    children: [
      {
        id: HARBOR_STEEL_TASK,
        name: 'Erect steel and metal deck',
        duration: 11,
        budget: 236_000,
        people: 5,
        assign: [STEEL, CRANE],
        note: 'Columns, beams and metal deck from the ground floor up to the roof, one level at a time, lifted by the tower crane.',
      },
      deck(1),
      deck(2),
      deck(3),
    ],
  },
  {
    id: 80,
    name: 'Envelope',
    code: 'ENV',
    collapsed: true,
    children: [
      { id: 81, name: 'Roofing', duration: 3, budget: 48_000, people: 4, assign: [ROOFERS], note: 'Insulation and a white membrane, parapet caps, and the rooftop units set on their curbs.' },
      { id: 82, name: 'Curtain wall', duration: 12, budget: 412_000, people: 5, assign: [GLAZIERS], note: 'Unitized glass panels with aluminum frames, ground floor to level 3, on all four sides.' },
    ],
  },
  {
    id: 90,
    name: 'Ground floor build-out',
    code: 'L00',
    collapsed: true,
    note: 'The entrance lobby, with the stair and elevator core behind it.',
    children: [
      { id: 91, name: 'Storefront and entrance, ground floor', duration: 2, budget: 28_000, people: 3, assign: [GLAZIERS] },
      { id: 92, name: 'Lobby finishes, ground floor', duration: 4, budget: 41_000, people: 5, assign: [CARPENTERS], note: 'Stone floor, an oak slat wall, the reception desk and the lobby lights.' },
    ],
  },
  floor(1),
  floor(2),
  floor(3),
  {
    id: 400,
    name: 'Completion',
    code: 'CMP',
    children: [
      { id: 411, name: 'Final clean, all floors', duration: 3, budget: 3_600, assign: [CLEANERS] },
      { id: HARBOR_HANDOVER_TASK, name: 'Handover to tenant', duration: 0, budget: 0, deadline: HARBOR_CONTRACT_DATE },
    ],
  },
];

/** Every task in the order of the rows, ending with the handover. */
const LINE: readonly number[] = [
  11, 12, 21, 22, 23, 24, HARBOR_FOOTINGS_PAID, 31, 32, 35, 33, 34,
  HARBOR_STEEL_TASK,
  ...[1, 2, 3].flatMap((level) => [1, 2, 3, 4].map((step) => 40 + level * 10 + step)),
  81, 82, 91, 92,
  // A floor in the order the trades follow each other.
  ...[1, 2, 3].flatMap((level) => [11, 12, 13, 15, 14, 16, 17, 18].map((offset) => level * 100 + offset)),
  411,
  HARBOR_HANDOVER_TASK,
];

/** One line from the first task to the handover: each task starts when the one before it is finished. */
const dependencies: DependencySpec[] = LINE.slice(1).map((to, index) => ({ from: LINE[index]!, to }));

const built = buildSeed({ start: HARBOR_START, phases, dependencies, resources });

export const harborOfficesRecords: SeedRecords = built.records;

const taskOf = (id: number) => must(harborOfficesRecords.tasks.find((task) => task.id === id), `task ${id}`);

function rental(taskId: number, resourceId: number, supplier: string, slug: string, rateDollars: number, start: IsoDate, end: IsoDate): SeedEquipmentBooking {
  const task = taskOf(taskId);
  const idle = idleRentalDays({ start, end }, { start: task.startDate, end: task.endDate });
  return {
    task_id: taskId,
    resource_id: resourceId,
    supplier_name: supplier,
    supplier_payout_email: `sb-${slug}@personal.example.com`,
    rental_rate_minor: rateDollars * 100,
    currency: 'USD',
    billable_start: start,
    billable_end: end,
    idle_days: idle.before + idle.after,
    evidence_path: `evidence/${slug}-harbor-quote.pdf`,
  };
}

const steel = taskOf(HARBOR_STEEL_TASK);
/**
 * Booked Wednesday to Wednesday, a week before the steel can start to a week after the frame is up: 29 days at $600,
 * $17,400, fourteen of them with nothing to lift ($8,400). The steel itself runs Wed, Dec 2 to Wed, Dec 16, so two days
 * either side is Monday to Friday, with no weekend to count around.
 */
const craneRental = rental(HARBOR_STEEL_TASK, CRANE, 'Northgate Equipment Rental', 'northgate', 600, addDays(steel.startDate, -7), addDays(steel.endDate, 7));
/** Level 1's ceiling tiles, on the dates they have before any light fixtures go in. */
const liftRental = rental(116, LIFT, 'Apex Access Rentals', 'apex', 180, taskOf(116).startDate, taskOf(116).endDate);

const inlineData = withRentalDates(built.inlineData, [craneRental, liftRental]);

/** Harbor as seeded, under the given ids: the project itself, or one of its copies (the same plan, rentals of its own). */
function harborProject(ids: HarborIds, copy: boolean): SeedProject {
  return {
    name: 'Harbor Street Offices',
    currency: 'USD',
    handover_task_id: HARBOR_HANDOVER_TASK,
    members: SEED_MEMBERS,
    inlineData,
    booking: craneRental,
    moreBookings: [{ id: ids.liftBooking, ...liftRental }],
    // The tenant, who moves in at the handover: Harbor bills it for the changes it asks for (a change order) and for
    // finished fit-out, as PayPal invoices. On a machine with PAYPAL_SANDBOX_PAYEE_EMAIL, scripts/gen-seed-local.ts makes
    // its email that sandbox account, so the invoice can be opened and paid on PayPal's own page.
    client: { name: 'Larkspur Analytics', email: 'sb-larkspur@personal.example.com' },
    library: 'none',
    template: 'harbor',
    // A copy is reached by its visitor's link only, and starts from Harbor's own seed plan.
    ...(copy ? { unlisted: true, copyOf: HARBOR_IDS.project } : {}),
  };
}

export const harborOffices: SeedProject = harborProject(HARBOR_IDS, false);

/** What the crane's quote says, the same in Harbor and in each copy. */
const CRANE_QUOTE = { booking: craneRental, number: 'NER-Q-27-0131', equipment: 'Tower crane with operator, for the steel and metal deck' } as const;

/** The crane's written quote, filed on its task by scripts/seed-documents.ts. */
export const HARBOR_QUOTES = [{ documentId: HARBOR_IDS.craneQuote, ...CRANE_QUOTE }] as const;

/**
 * The private copies of Harbor for the hosted demo: each visitor gets one for the visit, and it is reset when they
 * leave (supabase/migrations, `copy_pool`). Each is Harbor exactly, under ids of its own (`harborCopyIds`), with its
 * own copy of the crane's quote.
 */
export const HARBOR_COPIES: readonly { project: SeedProject; ids: HarborIds; quotes: readonly { documentId: string; booking: SeedEquipmentBooking; number: string; equipment: string }[] }[] =
  Array.from({ length: HARBOR_COPY_COUNT }, (_, index) => {
    const ids = harborCopyIds(index + 1);
    return { project: harborProject(ids, true), ids, quotes: [{ documentId: ids.craneQuote, ...CRANE_QUOTE }] };
  });
