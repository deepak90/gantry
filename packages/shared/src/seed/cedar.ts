/**
 * "Cedar Park Clinic": a small clinic build, one waterfall with a single fork, and four machines on
 * rent starting in January 2027. Three of the rentals have something wrong with them, and they are
 * connected: moving the second pour off the concrete pump's double booking pushes the steel back,
 * which leaves the crane and the scissor lift standing idle for longer.
 *
 * Pure data, loaded by Node's type stripping as well as by Vite and Vitest (see build.ts).
 */
import { idleRentalDays } from '../rental-days.ts';
import { buildSeed, must, SEED_MEMBERS, withRentalDates, type DependencySpec, type IsoDate, type SeedEquipmentBooking, type SeedProject, type SeedRecords, type SeedResourceRow, type SummarySpec } from './build.ts';

export const CEDAR_IDS = {
  project: '00000000-0000-4000-8000-000000000004',
  /** The crane's rental, the project's first. */
  booking: '00000000-0000-4000-8000-000000000401',
  pumpBooking: '00000000-0000-4000-8000-000000000402',
  liftBooking: '00000000-0000-4000-8000-000000000403',
  excavatorBooking: '00000000-0000-4000-8000-000000000404',
  craneQuote: '00000000-0000-4000-8000-000000000411',
  pumpQuote: '00000000-0000-4000-8000-000000000412',
  liftQuote: '00000000-0000-4000-8000-000000000413',
} as const;

/** Project start: Monday, January 11, 2027. */
export const CEDAR_START: IsoDate = '2027-01-11';

const EXCAVATOR = 1;
const PUMP = 2;
const CRANE = 3;
const LIFT = 4;
const SITE_CREW = 5;
const GROUNDWORKS = 6;
const EAST_CONCRETE = 7;
const WEST_CONCRETE = 8;
const STEEL = 9;
const ROOFERS = 10;
const ENVELOPE = 11;
const MEP = 12;
const INTERIORS = 13;
const COMMISSIONING = 14;

const resources: SeedResourceRow[] = [
  { id: EXCAVATOR, name: 'Excavator', trade: 'Equipment rental', kind: 'equipment', company: 'Ironwood Earthmoving', eventColor: '#7a5c2e', iconCls: 'fa fa-tractor' },
  { id: PUMP, name: 'Concrete pump', trade: 'Equipment rental', kind: 'equipment', company: 'Ridgeway Concrete Pumping', eventColor: '#357153', iconCls: 'fa fa-truck', imageUrl: '/crews/concrete-pump.png' },
  { id: CRANE, name: 'Crane', trade: 'Equipment rental', kind: 'equipment', company: 'Northgate Equipment Rental', eventColor: '#6c6433', iconCls: 'fa fa-weight-hanging', imageUrl: '/crews/crane.png' },
  { id: LIFT, name: 'Scissor lift', trade: 'Equipment rental', kind: 'equipment', company: 'Apex Access Rentals', eventColor: '#5b4f86', iconCls: 'fa fa-elevator' },
  { id: SITE_CREW, name: 'Ashford Builders', trade: 'General contractor', kind: 'labor', company: 'Ashford Builders', eventColor: '#46576c', iconCls: 'fa fa-helmet-safety', imageUrl: '/crews/logos/ashford-builders.png' },
  { id: GROUNDWORKS, name: 'Redline Groundworks', trade: 'Groundworks', kind: 'labor', company: 'Redline Groundworks', eventColor: '#7a5c2e', iconCls: 'fa fa-person-digging', imageUrl: '/crews/logos/redline-groundworks.png' },
  { id: EAST_CONCRETE, name: 'Granite Concrete', trade: 'Concrete', kind: 'labor', company: 'Granite Concrete', eventColor: '#4e5c6b', iconCls: 'fa fa-cubes-stacked', imageUrl: '/crews/logos/granite-concrete.png' },
  { id: WEST_CONCRETE, name: 'Stonebridge Concrete', trade: 'Concrete', kind: 'labor', company: 'Stonebridge Concrete', eventColor: '#5c6b4e', iconCls: 'fa fa-cubes-stacked', imageUrl: '/crews/logos/stonebridge-concrete.png' },
  { id: STEEL, name: 'Summit Steel Erectors', trade: 'Structural steel', kind: 'labor', company: 'Summit Steel Erectors', eventColor: '#3e6596', iconCls: 'fa fa-industry', imageUrl: '/crews/logos/summit-steel-erectors.png' },
  { id: ROOFERS, name: 'Keystone Roofing', trade: 'Roofing', kind: 'labor', company: 'Keystone Roofing', eventColor: '#695086', iconCls: 'fa fa-house', imageUrl: '/crews/logos/keystone-roofing.png' },
  { id: ENVELOPE, name: 'Clearline Envelope', trade: 'Exterior walls', kind: 'labor', company: 'Clearline Envelope', eventColor: '#2e7065', iconCls: 'fa fa-table-cells-large', imageUrl: '/crews/logos/clearline-envelope.png' },
  { id: MEP, name: 'Halden Mechanical', trade: 'Mechanical & electrical', kind: 'labor', company: 'Halden Mechanical', eventColor: '#3e6596', iconCls: 'fa fa-bolt', imageUrl: '/crews/logos/halden-mechanical.png' },
  { id: INTERIORS, name: 'Oakmere Interiors', trade: 'Interiors', kind: 'labor', company: 'Oakmere Interiors', eventColor: '#5e6a37', iconCls: 'fa fa-hammer', imageUrl: '/crews/logos/oakmere-interiors.png' },
  { id: COMMISSIONING, name: 'Brightline Commissioning', trade: 'Commissioning', kind: 'labor', company: 'Brightline Commissioning', eventColor: '#64594c', iconCls: 'fa fa-list-check', imageUrl: '/crews/logos/brightline-commissioning.png' },
];

const EXCAVATE_TASK = 112;
const EAST_POUR_TASK = 113;
const WEST_POUR_TASK = 114;
const ERECT_TASK = 212;
const WALLS_TASK = 312;
export const CEDAR_HANDOVER_TASK = 513;

const phases: SummarySpec[] = [
  {
    id: 100,
    name: 'Site & foundations',
    code: 'SIT',
    children: [
      { id: 111, name: 'Site setup & fencing', people: 4, duration: 3, budget: 9_500, assign: [SITE_CREW] },
      { id: EXCAVATE_TASK, name: 'Excavate foundations', people: 5, duration: 4, budget: 16_400, assign: [EXCAVATOR, GROUNDWORKS] },
      { id: EAST_POUR_TASK, name: 'Pour footings, east wing', people: 6, duration: 3, budget: 18_600, assign: [PUMP, EAST_CONCRETE] },
      { id: WEST_POUR_TASK, name: 'Pour footings, west wing', people: 6, duration: 3, budget: 18_600, assign: [PUMP, WEST_CONCRETE] },
      { id: 115, name: 'Cure & backfill', people: 3, duration: 3, budget: 7_200, assign: [GROUNDWORKS] },
    ],
  },
  {
    id: 200,
    name: 'Steel frame',
    code: 'STL',
    children: [
      { id: 211, name: 'Steel delivery & lay-down', people: 4, duration: 4, budget: 12_800, assign: [STEEL] },
      { id: ERECT_TASK, name: 'Erect steel frame', people: 8, duration: 6, budget: 41_000, assign: [CRANE, STEEL] },
      { id: 213, name: 'Bolt up & inspect frame', people: 4, duration: 2, budget: 6_400, assign: [STEEL] },
    ],
  },
  {
    id: 300,
    name: 'Roof & walls',
    code: 'ENV',
    children: [
      { id: 311, name: 'Roof deck & membrane', people: 5, duration: 5, budget: 28_500, assign: [ROOFERS] },
      { id: WALLS_TASK, name: 'Exterior wall panels', people: 6, duration: 6, budget: 34_200, assign: [LIFT, ENVELOPE] },
      { id: 313, name: 'Windows & doors', people: 4, duration: 3, budget: 19_400, assign: [ENVELOPE] },
    ],
  },
  {
    id: 400,
    name: 'Interior',
    code: 'INT',
    children: [
      { id: 411, name: 'Mechanical & electrical rough-in', people: 4, duration: 6, budget: 38_000, assign: [MEP] },
      { id: 412, name: 'Hang & tape drywall', people: 5, duration: 5, budget: 21_600, assign: [INTERIORS] },
      { id: 413, name: 'Paint', people: 3, duration: 3, budget: 9_800, assign: [INTERIORS] },
      { id: 414, name: 'Floor finishes', people: 4, duration: 3, budget: 14_200, assign: [INTERIORS] },
      { id: 415, name: 'Exam room fit-out', people: 6, duration: 4, budget: 26_400, assign: [INTERIORS] },
    ],
  },
  {
    id: 500,
    name: 'Closeout',
    code: 'CLO',
    children: [
      { id: 511, name: 'Commissioning', people: 2, duration: 3, budget: 11_500, assign: [COMMISSIONING] },
      { id: 512, name: 'Punch list', people: 3, duration: 2, budget: 3_800, assign: [SITE_CREW] },
      { id: CEDAR_HANDOVER_TASK, name: 'Handover', duration: 0, budget: 0 },
    ],
  },
];

/**
 * One waterfall, finish-to-start, with a single fork: both pours follow the excavation, the west one
 * a day behind, so they overlap for two days and both want the one concrete pump.
 */
const dependencies: DependencySpec[] = [
  { from: 111, to: EXCAVATE_TASK },
  { from: EXCAVATE_TASK, to: EAST_POUR_TASK },
  { from: EXCAVATE_TASK, to: WEST_POUR_TASK, lag: 1 },
  { from: EAST_POUR_TASK, to: 115 },
  { from: WEST_POUR_TASK, to: 115 },
  { from: 115, to: 211 },
  { from: 211, to: ERECT_TASK },
  { from: ERECT_TASK, to: 213 },
  { from: 213, to: 311 },
  { from: 311, to: WALLS_TASK },
  { from: WALLS_TASK, to: 313 },
  { from: 313, to: 411 },
  { from: 411, to: 412 },
  { from: 412, to: 413 },
  { from: 413, to: 414 },
  { from: 414, to: 415 },
  { from: 415, to: 511 },
  { from: 511, to: 512 },
  { from: 512, to: CEDAR_HANDOVER_TASK },
];

const built = buildSeed({ start: CEDAR_START, phases, dependencies, resources });

export const cedarParkRecords: SeedRecords = built.records;

const taskOf = (id: number) => must(cedarParkRecords.tasks.find((task) => task.id === id), `task ${id}`);
const startOf = (id: number): IsoDate => taskOf(id).startDate;

function rental(taskId: number, resourceId: number, supplier: string, slug: string, rateDollars: number, start: IsoDate, end: IsoDate): SeedEquipmentBooking {
  const idle = idleRentalDays({ start, end }, { start: startOf(taskId), end: taskOf(taskId).endDate });
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
    evidence_path: `evidence/${slug}-quote.pdf`,
  };
}

/**
 * The crane comes on rent three days before the steel can go up and stays four days after the frame is
 * done, a weekend among them: 15 days at $600, $9,000, of which seven are idle. The work needs six, with a
 * weekend inside them.
 */
const craneRental = rental(ERECT_TASK, CRANE, 'Northgate Equipment Rental', 'northgate', 600, '2027-02-01', '2027-02-16');
/** The west pour's own three days on the pump, which the east pour is also using for the first two. */
const pumpRental = rental(WEST_POUR_TASK, PUMP, 'Ridgeway Concrete Pumping', 'ridgeway', 450, startOf(WEST_POUR_TASK), '2027-01-26');
/** The lift arrives four days before the panels start, over a weekend, with two spare days after them. */
const liftRental = rental(WALLS_TASK, LIFT, 'Apex Access Rentals', 'apex', 180, '2027-02-19', '2027-03-05');
/** Booked from the first day it works to the last: the weekend inside is paid, but nothing to find here. */
const excavatorRental = rental(EXCAVATE_TASK, EXCAVATOR, 'Ironwood Earthmoving', 'ironwood', 380, startOf(EXCAVATE_TASK), '2027-01-20');

export const cedarParkClinic: SeedProject = {
  name: 'Cedar Park Clinic',
  currency: 'USD',
  handover_task_id: CEDAR_HANDOVER_TASK,
  members: SEED_MEMBERS,
  inlineData: withRentalDates(built.inlineData, [craneRental, pumpRental, liftRental, excavatorRental]),
  booking: craneRental,
  moreBookings: [
    { id: CEDAR_IDS.pumpBooking, ...pumpRental },
    { id: CEDAR_IDS.liftBooking, ...liftRental },
    { id: CEDAR_IDS.excavatorBooking, ...excavatorRental },
  ],
  library: 'none',
  // Only Harbor is offered in the menu: Cedar Park opens by its link, still as the demo it plays.
  unlisted: true,
  template: 'cedar',
};

/** The rentals' written quotes, filed on their tasks by scripts/seed-documents.ts. */
export const CEDAR_QUOTES = [
  { documentId: CEDAR_IDS.craneQuote, booking: craneRental, number: 'NER-Q-27-0118', equipment: 'Crane with operator, for the steel frame erection' },
  { documentId: CEDAR_IDS.pumpQuote, booking: pumpRental, number: 'RCP-Q-27-0044', equipment: 'Concrete pump with operator, for the west wing footings' },
  { documentId: CEDAR_IDS.liftQuote, booking: liftRental, number: 'AAR-Q-27-0207', equipment: 'Scissor lift, for the exterior wall panels' },
] as const;
