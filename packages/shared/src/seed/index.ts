/**
 * The "Riverside Clinic" seed project: Bryntum inline data plus the commercial records
 * (equipment booking, members) that are not Bryntum stores.
 * Consumers import `riversideClinic` from '@collab/shared/seed'.
 *
 * The project converts a vacant storefront into a community health clinic and adds a two-story
 * steel-framed addition on the rear yard: six phases, each split into work packages, two of which
 * (the services rough-in and the services trim-out) break down one level further.
 *
 * The plan reads as a waterfall: the WBS is written in time order, so with every row expanded each
 * row starts on or after the row above it, every link points down the grid, and no row starts after
 * a gap in the work above it. Long off-site work (the steel fabrication) is one long bar near the top
 * with the sitework cascading below it. packages/shared/test/seed.test.ts and apps/web/test/seed
 * check all of this.
 *
 * This module is pure data and arithmetic. It is loaded by Node's type stripping
 * (scripts/gen-seed-snapshot.ts) as well as by Vite and Vitest, so it must not import a value from
 * another file. apps/web/test/seed proves the schedule below against the real scheduling engine.
 *
 * Conventions:
 * - Dates are plain 'YYYY-MM-DD' strings without timezone information (Bryntum revisions guide:
 *   tasks without TZ info, calendars without TZ info). Segment dates of split tasks too.
 * - Working days are 24 hours long (`hoursPerDay: 24`), so a task that works Mon-Wed starts on
 *   the Monday and ends on the Thursday 00:00: `endDate` is exclusive.
 * - Bryntum ids are integers (bigint in Postgres); calendar ids are the strings 'standard'/'site'.
 * - Money is integer minor units (USD cents) on leaf tasks only. Summary rows carry no money, so
 *   summing every task row gives the same total as summing the leaves.
 */
import { idleRentalDays } from '../rental-days.ts';
import {
  buildSeed,
  must,
  SEED_MEMBERS,
  type DependencySpec,
  type IsoDate,
  type SeedEquipmentBooking,
  type SeedProject,
  type SeedRecords,
  type SeedResourceRow,
  type SummarySpec,
  withRentalDates,
} from './build.ts';
import { CEDAR_IDS, cedarParkClinic } from './cedar.ts';
import { HARBOR_COPIES, HARBOR_IDS, harborOffices } from './harbor.ts';

export * from './build.ts';

/** Fixed identifiers shared by seed.sql, the generated snapshot and the tests. */
export const SEED_IDS = {
  project: '00000000-0000-4000-8000-000000000001',
  booking: '00000000-0000-4000-8000-000000000101',
  pmUser: '00000000-0000-4000-8000-000000000011',
  cmUser: '00000000-0000-4000-8000-000000000012',
  /** The supplier's quote for the crane booking, a project_documents row filed by scripts/seed-documents.ts. */
  quoteDocument: '00000000-0000-4000-8000-000000000201',
} as const;

/** Project start: Monday, November 2, 2026. */
export const SEED_PROJECT_START: IsoDate = '2026-11-02';

// ---------------------------------------------------------------------------------------------
// Authoring specs: ids, durations, dependencies, resources and money are written by hand; dates,
// segments, baselines, cost codes and summary roll-ups are derived so they cannot drift apart.
//
// Ids follow the WBS: phase n00, the work packages (and the sub-packages below them) take the tens,
// and leaves follow their package (311, 312, ...). Two leaves keep older fixed ids that other records
// point at: 15, the crane erection (the equipment booking), and 42, the Handover milestone. Their
// `wbs` gives the number they would otherwise have, which their cost code uses. Phase 2 keeps the
// leaf ids the end-to-end tests drive (211-216 the spread footings, 231-234 the steel chain), so its
// packages are numbered after their leaves: the steel design package (230) comes before the spread
// footings (210) in the grid because the fabrication starts first.
// ---------------------------------------------------------------------------------------------

const SITE_CREW = 1;
const ELECTRICIANS = 2;
const PLUMBERS = 3;
const CRANE = 4;
const STEEL_ERECTORS = 5;
const CARPENTERS = 6;
const COMMISSIONING = 7;
const VENTILATION = 8;
const PAINTERS = 9;
const MEDICAL_ENGINEERS = 10;
const IT_ENGINEERS = 11;
const CONCRETE_PUMP = 12;

const STEEL_ERECTION_TASK = 15;
const HANDOVER_TASK = 42;

/**
 * Crews go by their firm's name, with their trade as a label; equipment by what it is. Muted
 * mid-tones that carry white text (WCAG AA), apart from each other and never red, orange or pink
 * (those mean danger and caution in the app).
 */
const resources: SeedResourceRow[] = [
  { id: SITE_CREW, name: 'Calloway Construction', trade: 'General contractor', kind: 'labor', company: 'Calloway Construction', eventColor: '#64594c', iconCls: 'fa fa-helmet-safety', imageUrl: '/crews/site-crew.png' },
  { id: ELECTRICIANS, name: 'Halden Electrical', trade: 'Electrical', kind: 'labor', company: 'Halden Electrical', eventColor: '#3e6596', iconCls: 'fa fa-bolt', imageUrl: '/crews/electricians.png' },
  { id: PLUMBERS, name: 'Brightwater Plumbing', trade: 'Plumbing', kind: 'labor', company: 'Brightwater Plumbing', eventColor: '#296b88', iconCls: 'fa fa-faucet-drip', imageUrl: '/crews/plumbers.png' },
  { id: CRANE, name: 'Crane', trade: 'Equipment rental', kind: 'equipment', company: 'Northgate Equipment Rental', eventColor: '#6c6433', iconCls: 'fa fa-weight-hanging', imageUrl: '/crews/crane.png', calendar: 'site' },
  { id: STEEL_ERECTORS, name: 'Castlegate Steel', trade: 'Structural steel', kind: 'labor', company: 'Castlegate Steel', eventColor: '#4e5c6b', iconCls: 'fa fa-industry', imageUrl: '/crews/steel-erectors.png', calendar: 'site' },
  { id: CARPENTERS, name: 'Oakmere Interiors', trade: 'Carpentry', kind: 'labor', company: 'Oakmere Interiors', eventColor: '#5e6a37', iconCls: 'fa fa-hammer', imageUrl: '/crews/carpenters.png' },
  { id: COMMISSIONING, name: 'Calder Commissioning', trade: 'Commissioning', kind: 'labor', company: 'Calder Commissioning', eventColor: '#2e7065', iconCls: 'fa fa-clipboard-check', imageUrl: '/crews/commissioning-engineers.png' },
  { id: VENTILATION, name: 'Northwind Air Systems', trade: 'HVAC', kind: 'labor', company: 'Northwind Air Systems', eventColor: '#1f7074', iconCls: 'fa fa-fan', imageUrl: '/crews/ventilation-fitters.png' },
  { id: PAINTERS, name: 'Linwood Painting', trade: 'Painting', kind: 'labor', company: 'Linwood Painting', eventColor: '#695086', iconCls: 'fa fa-paint-roller', imageUrl: '/crews/painters.png' },
  { id: MEDICAL_ENGINEERS, name: 'Meridian Medical Systems', trade: 'Medical equipment', kind: 'labor', company: 'Meridian Medical Systems', eventColor: '#585493', iconCls: 'fa fa-stethoscope', imageUrl: '/crews/medical-equipment-engineers.png' },
  { id: IT_ENGINEERS, name: 'Kestrel Networks', trade: 'IT & data', kind: 'labor', company: 'Kestrel Networks', eventColor: '#4c6e44', iconCls: 'fa fa-network-wired', imageUrl: '/crews/it-data-engineers.png' },
  { id: CONCRETE_PUMP, name: 'Concrete pump', trade: 'Equipment rental', kind: 'equipment', company: 'Ridgeway Concrete Pumping', eventColor: '#357153', iconCls: 'fa fa-truck', imageUrl: '/crews/concrete-pump.png' },
];

const phases: SummarySpec[] = [
  {
    id: 100,
    name: 'Site setup & demolition',
    code: 'MOB',
    collapsed: true,
    children: [
      {
        id: 110,
        name: 'Site mobilization',
        children: [
          {
            id: 111, name: 'Construction fence, gates & site signs', duration: 2, budget: 18_500, incurred: 18_500, paid: 18_500, percentDone: 100, assign: [SITE_CREW],
            note: 'Wood fence along the property line. The pharmacy next door stays open, so its pedestrian route is kept clear throughout.',
          },
          {
            id: 112, name: 'Job trailers & site office', duration: 2, budget: 24_000, incurred: 24_000, paid: 24_000, percentDone: 100, assign: [CARPENTERS],
            note: 'Two stacked trailers in the yard: office, break room, drying room and restrooms.',
          },
          {
            id: 113, name: 'Disconnect & cap existing utilities', duration: 1, budget: 6_800, incurred: 6_800, paid: 6_800, percentDone: 100, assign: [ELECTRICIANS, PLUMBERS],
            note: 'Power, water and gas to the old store cut and capped so the strip-out can start safely.',
          },
          {
            id: 114, name: 'Temporary power, lighting & water', duration: 2, budget: 14_500, incurred: 14_500, paid: 14_500, percentDone: 100, assign: [ELECTRICIANS],
            note: "A temporary power service, site lighting and a water hookup, put in once the store's own utilities are capped.",
          },
        ],
      },
      {
        id: 120,
        name: 'Surveys & demolition',
        children: [
          {
            id: 121, name: 'Asbestos abatement (specialty contractor)', duration: 2, budget: 38_000, forecast: 43_600, incurred: 43_600, paid: 43_600, percentDone: 100,
            note: 'Extra asbestos-containing board turned up behind the wall paneling. Nobody else works in the area until the air clearance test passes.',
          },
          {
            id: 122, name: 'Layout & dimensional survey', duration: 1, budget: 9_000, incurred: 9_000, percentDone: 100, assign: [SITE_CREW],
            note: "Grid lines and footing locations laid out from the engineer's drawings, and the existing walls measured so the steel fabricator can finish the shop drawings.",
          },
          {
            id: 123, name: 'Test pits & underground utility scan', duration: 2, budget: 5_400, incurred: 5_400, paid: 5_400, percentDone: 100, assign: [SITE_CREW],
            note: 'The yard scanned for buried cables and pipes, and a test pit dug at every footing location. The hole on grid line C hit an old concrete footing.',
          },
          { id: 124, name: 'Selective demolition of existing interior', duration: 2, budget: 27_000, forecast: 26_400, incurred: 26_400, paid: 26_400, percentDone: 100, assign: [CARPENTERS] },
        ],
      },
    ],
  },
  {
    id: 200,
    name: 'Foundations & steel frame',
    code: 'STR',
    children: [
      {
        id: 230,
        name: 'Steel design & fabrication',
        children: [
          {
            id: 231, name: 'Steel shop drawings & approval', duration: 2, budget: 14_000, incurred: 14_000, paid: 14_000, percentDone: 100,
            note: "Castlegate's fabrication drawings, checked against the dimensional survey and approved by the structural engineer before any steel is cut.",
          },
          {
            id: 232, name: 'Fabricate steel off-site', duration: 17, budget: 182_000, forecast: 187_500, incurred: 18_750, paid: 18_750, percentDone: 10,
            note: "About 38 tons of beams and columns made in Castlegate's shop while the footings go in. A mill price surcharge added $5,500 to the forecast.",
          },
        ],
      },
      {
        id: 210,
        name: 'Spread footings',
        children: [
          {
            id: 211, name: 'Saw-cut yard slab for spread footings', duration: 2, budget: 18_000, forecast: 23_500, incurred: 11_750, percentDone: 50, assign: [SITE_CREW],
            note: 'The old concrete footing found under grid line C has to come out as well. Breaking it out and hauling off the extra spoil put this task over budget.',
          },
          {
            id: 212, name: 'Excavate spread footings', duration: 3, budget: 31_000, assign: [SITE_CREW],
            note: "Dug to the depth on the engineer's drawings; the spoil goes straight into dump trucks because the yard has no room to stockpile it.",
          },
          {
            id: 213, name: 'Inspect footing excavations (hold point)', duration: 1, budget: 650,
            note: 'Hold point: the building inspector must see the bottoms of the excavations before any concrete goes in.',
          },
          {
            id: 214, name: 'Place rebar & cast-in anchor bolts', duration: 2, budget: 24_000, assign: [SITE_CREW],
            note: 'Bolts set in plywood templates; the steel erector checks every position before the pour.',
          },
          {
            id: 215, name: 'Pour spread footings', duration: 1, budget: 17_000, assign: [SITE_CREW, CONCRETE_PUMP],
            note: 'About 40 cubic yards placed by pump in one day, with test cylinders taken from every load.',
          },
          {
            id: 216, name: 'Cure spread footings', duration: 7, budget: 1_500,
            note: "The 7-day test cylinders must reach the engineer's strength before the frame bears on the footings.",
          },
        ],
      },
      {
        id: 240,
        name: 'Steel delivery & frame erection',
        children: [
          {
            id: 233, name: 'Shop-prime steel', duration: 4, budget: 16_000,
            note: 'Primed in the shop as pieces come off the line, finishing two days after the last piece is fabricated.',
          },
          {
            id: 234, name: 'Deliver & lay down steel', duration: 5, budget: 9_500, assign: [SITE_CREW],
            note: 'Three loads; the roof beams arrive last, on Thursday, December 10. Every piece is checked off and laid out by grid line before lifting starts.',
          },
          {
            id: STEEL_ERECTION_TASK,
            wbs: 241,
            name: 'Erect structural steel frame',
            duration: 6,
            budget: 96_000,
            forecast: 98_400,
            calendar: 'site',
            note: 'Crane rented from Northgate Equipment Rental for 11 days from Mon, Dec 7, 2026. Erection starts once all the steel is on site.',
            assign: [CRANE, STEEL_ERECTORS],
          },
          {
            id: 242, name: 'Plumb, line, level & final bolt-up', duration: 2, budget: 12_000, assign: [STEEL_ERECTORS],
            note: 'Frame surveyed and every bolt torqued; the structural engineer signs off on the frame before the baseplates are grouted.',
          },
          {
            id: 243, name: 'Grout base plates', duration: 1, budget: 3_800, assign: [SITE_CREW],
            note: 'Non-shrink grout packed under every baseplate once the engineer has signed off on the frame.',
          },
        ],
      },
      {
        id: 250,
        name: 'Slab on grade',
        children: [
          {
            id: 251, name: 'Subbase, insulation & vapor barrier', duration: 1, budget: 12_500, assign: [SITE_CREW],
            note: 'Compacted stone, insulation boards and the membrane laid between the spread footings and lapped onto the existing floor: the last job before the holiday shutdown.',
          },
          {
            id: 252, name: 'Pour slab-on-grade infill', duration: 2, budget: 46_000, assign: [SITE_CREW, CONCRETE_PUMP],
            note: 'Poured around the grouted baseplates in the first week back after the shutdown. Insulated blankets go down if a freeze is forecast.',
          },
        ],
      },
    ],
  },
  {
    id: 300,
    name: 'Envelope & rough-in',
    code: 'ENV',
    children: [
      {
        id: 310,
        name: 'Roof & exterior walls',
        children: [
          {
            id: 311, name: 'Metal roof deck & edge trim', duration: 3, budget: 58_000, assign: [STEEL_ERECTORS],
            note: 'Profiled steel deck installed from scissor lifts standing on the new slab: walkable, but not yet watertight.',
          },
          {
            id: 312, name: 'Roof insulation & single-ply membrane', duration: 4, budget: 64_000,
            note: 'Roofing subcontractor. The membrane seams can only be welded in dry weather, a real risk in January.',
          },
          {
            id: 313, name: 'Insulated metal wall panels', duration: 5, budget: 118_000, forecast: 116_200, assign: [STEEL_ERECTORS],
            note: 'Factory-made panels on an eight-week lead time, already ordered.',
          },
          {
            id: 314, name: 'Windows & entrance doors', duration: 4, budget: 96_000, forecast: 103_500,
            note: 'Aluminum windows and automatic doors from Clearview Glazing. The clinic asked for wider, fully accessible entrance doors, adding $7,500.',
          },
          {
            id: 315, name: 'Building dried in', duration: 0, budget: 0,
            note: 'Roof, walls and windows closed: the fire protection, the floor topping and the inside trades can start.',
          },
        ],
      },
      {
        id: 320,
        name: 'Fireproofing & floor topping',
        children: [
          {
            id: 321,
            name: 'Intumescent fireproofing on steel',
            duration: 5,
            segments: [
              { name: 'First coat', duration: 3 },
              { name: 'Second coat', duration: 2, gapBefore: 3 },
            ],
            budget: 36_000,
            assign: [PAINTERS],
            note: 'Two coats for a one-hour fire rating, applied once the building is dry. The first coat must cure and the inspector takes thickness readings before the second coat goes on.',
          },
          {
            id: 322, name: 'Pumped floor topping', duration: 3, budget: 31_000, assign: [SITE_CREW, CONCRETE_PUMP],
            note: 'A self-leveling floor topping over the existing floor and the new slab, laid as soon as the building is weathertight so it has eight weeks to dry before the vinyl goes down.',
          },
        ],
      },
      {
        id: 330,
        name: 'MEP & partitions rough-in',
        children: [
          {
            id: 340,
            name: 'Above-ceiling MEP',
            children: [
              {
                id: 341,
                name: 'Electrical rough-in: conduit & cabling',
                duration: 10,
                segments: [
                  { name: 'Conduit & tray', duration: 4 },
                  { name: 'Cable pulling', duration: 6, gapBefore: 3 },
                ],
                budget: 118_000,
                assign: [ELECTRICIANS],
                note: 'Cable trays go up first, in the existing building while the first coat cures on the new steel. The electricians step off for three days while the main ductwork is hung in the same ceiling space, then come back to pull the cables.',
              },
              {
                id: 342, name: 'Ventilation ductwork & air handling unit', duration: 7, budget: 126_000, assign: [VENTILATION],
                note: 'Treatment rooms need ten air changes an hour, which sets the duct sizes. The air handling unit is lifted onto the roof by a truck-mounted crane.',
              },
              {
                id: 343, name: 'Medical gas piping (oxygen, vacuum)', duration: 4, budget: 72_000, forecast: 76_800, assign: [PLUMBERS],
                note: 'Brazed copper piping run through the ceiling space behind the ductwork. Copper prices are up, adding $4,800 to the forecast.',
              },
            ],
          },
          {
            id: 350,
            name: 'Partitions & in-wall MEP',
            children: [
              {
                id: 351, name: 'Metal stud partitions & door frames', duration: 8, budget: 68_000, assign: [CARPENTERS],
                note: 'Studs, door frames and the first side of drywall, room by room behind the ductwork. Acoustic insulation between exam rooms keeps conversations private.',
              },
              { id: 352, name: 'Hot & cold water & drainage rough-in', duration: 5, budget: 62_000, assign: [PLUMBERS] },
              { id: 353, name: 'Structured data cabling', duration: 5, budget: 42_000, assign: [IT_ENGINEERS] },
              {
                id: 354, name: 'Fire alarm & nurse call rough-in', duration: 3, budget: 34_000, assign: [ELECTRICIANS],
                note: 'Cabling for detectors, horn strobes and a nurse-call point in every exam room, treatment room and restroom.',
              },
              {
                id: 355, name: 'Heating piping & radiators', duration: 3, budget: 48_000, assign: [PLUMBERS],
                note: 'Low-surface-temperature radiators throughout, as patient areas require.',
              },
            ],
          },
          {
            id: 331, name: 'Above-ceiling & in-wall MEP inspection (hold point)', duration: 1, budget: 3_500, assign: [COMMISSIONING],
            note: 'Hold point: no drywall or ceiling tiles until every service in the walls and ceiling space has been checked and photographed.',
          },
        ],
      },
    ],
  },
  {
    id: 400,
    name: 'Interior build-out & trim-out',
    code: 'FIN',
    children: [
      {
        id: 410,
        name: 'Partitions & ceilings',
        children: [
          {
            id: 411, name: 'Hang, tape & finish drywall partitions', duration: 6, budget: 54_000, assign: [CARPENTERS],
            note: 'The second side of drywall goes on once the services inspection has passed. Impact-resistant board in the corridors.',
          },
          {
            id: 412, name: 'X-ray room lead lining & shielded door', duration: 3, budget: 46_000, forecast: 49_800, assign: [MEDICAL_ENGINEERS],
            note: "Lead-lined board and a shielded door to the medical physicist's design, installed while the carpenters hang drywall in the other rooms. Lead sheet went up in price, adding $3,800.",
          },
          {
            id: 413, name: 'Suspended ceilings', duration: 5, budget: 58_000, assign: [CARPENTERS],
            note: 'Wipe-clean tiles in treatment rooms, with access panels at every valve and damper.',
          },
        ],
      },
      {
        id: 420,
        name: 'Painting & wall tile',
        children: [
          {
            id: 421,
            name: 'Painting',
            duration: 6,
            segments: [
              { name: 'Primer & first coats', duration: 4 },
              { name: 'Final coat', duration: 2, gapBefore: 6 },
            ],
            budget: 38_000,
            assign: [PAINTERS],
            note: 'Primer and first coats go on before the trim-out; the painters come back for the final coat once the electricians and plumbers have finished.',
          },
          {
            id: 422, name: 'Wall tile in restrooms & clinical rooms', duration: 3, budget: 21_000,
            note: 'Tile subcontractor. Backsplashes and restroom walls are tiled before the sinks and toilets go in.',
          },
        ],
      },
      {
        id: 430,
        name: 'MEP trim-out',
        children: [
          {
            id: 440,
            name: 'Electrical & ventilation',
            children: [
              { id: 441, name: 'Electrical trim-out: lighting, outlets & switches', duration: 5, budget: 62_000, assign: [ELECTRICIANS] },
              { id: 442, name: 'Grilles, registers & diffusers', duration: 2, budget: 18_000, assign: [VENTILATION] },
            ],
          },
          {
            id: 450,
            name: 'Plumbing & medical gas',
            children: [
              {
                id: 451, name: 'Plumbing fixtures & clinical hand-wash sinks', duration: 3, budget: 47_000, assign: [PLUMBERS],
                note: 'Hands-free faucets on every clinical sink, per infection-control guidance.',
              },
              {
                id: 452, name: 'Medical gas outlets & headwall units', duration: 2, budget: 26_000, assign: [PLUMBERS],
                note: 'Oxygen and vacuum outlets at each treatment bay, in a raceway that also carries power and nurse call.',
              },
            ],
          },
        ],
      },
      {
        id: 460,
        name: 'Floors, doors & millwork',
        children: [
          {
            id: 461, name: 'Safety vinyl flooring & cove base', duration: 5, budget: 54_000, assign: [CARPENTERS],
            note: 'Moisture readings on the floor topping first, then a leveling compound. Welded seams and cove base so the floors can be cleaned to infection-control standards.',
          },
          {
            id: 462, name: 'Doors, frames & hardware', duration: 4, budget: 76_000, assign: [CARPENTERS],
            note: 'Fire doors with intumescent seals and closers throughout.',
          },
          {
            id: 463, name: 'Reception desk & clinical millwork', duration: 4, budget: 62_000, assign: [CARPENTERS],
            note: "Reception desk, nurse stations and casework made in Oakmere's shop and installed on site.",
          },
          {
            id: 464, name: 'Wall protection, handrails & signage', duration: 3, budget: 22_000, assign: [SITE_CREW],
            note: "Corner guards and handrails along the corridors, lined up with the hung doors; signs to the clinic's own wayfinding design.",
          },
        ],
      },
    ],
  },
  {
    id: 500,
    name: 'Medical equipment & IT',
    code: 'MED',
    children: [
      {
        id: 510,
        name: 'IT & communications',
        children: [
          {
            id: 511, name: 'Telecom room: racks, patch panels & UPS', duration: 2, budget: 38_000, assign: [IT_ENGINEERS],
            note: 'Goes in once the telecom room door locks. The battery backup keeps the network and patient records running for 30 minutes in a power outage.',
          },
          { id: 512, name: 'Wi-Fi access points & network switches', duration: 2, budget: 29_000, assign: [IT_ENGINEERS] },
          {
            id: 513, name: 'Nurse call & patient paging system', duration: 2, budget: 24_000, assign: [ELECTRICIANS],
            note: "The paging server sits in the new telecom rack. Every call point tested with the clinic's lead nurse.",
          },
        ],
      },
      {
        id: 520,
        name: 'Medical equipment',
        children: [
          {
            id: 521, name: 'Sterilizers & vaccine refrigerators', duration: 2, budget: 44_000, assign: [MEDICAL_ENGINEERS],
            note: 'Vaccine refrigerators need their own dedicated circuit, with a temperature alarm that reports over the new network.',
          },
          {
            id: 522, name: 'Exam lights & ceiling booms', duration: 3, budget: 58_000, assign: [MEDICAL_ENGINEERS],
            note: 'The ceiling supports went in before the ceilings closed. Each pendant carries gas, power and data outlets, so the commissioning tests wait for them.',
          },
          {
            id: 523, name: 'Exam tables & clinical furniture', duration: 2, budget: 72_000, assign: [MEDICAL_ENGINEERS],
            note: 'Ten-week lead time; delivered once the floors are down and the rooms lock.',
          },
        ],
      },
    ],
  },
  {
    id: 600,
    name: 'Testing, commissioning & handover',
    code: 'COM',
    children: [
      {
        id: 610,
        name: 'Systems commissioning',
        children: [
          {
            id: 611, name: 'Electrical testing & certification', duration: 3, budget: 9_000, assign: [ELECTRICIANS],
            note: "Full electrical test once every fixed appliance and pendant is connected; the test report is needed before the building inspector's final visit.",
          },
          {
            id: 612, name: 'Medical gas testing & certification', duration: 2, budget: 11_000, assign: [COMMISSIONING, PLUMBERS],
            note: 'Purity and identity tests on every outlet, pendants included, by an independent medical gas verifier. No patient use until certified.',
          },
          {
            id: 613, name: 'Network & clinical systems testing', duration: 3, budget: 8_500, assign: [IT_ENGINEERS],
            note: "Patient records, appointment scheduling and the refrigerator alarms connected and tested with the clinic's IT provider.",
          },
          {
            id: 614, name: 'Water disinfection: flush, chlorinate & sample', duration: 2, budget: 4_800, assign: [PLUMBERS],
            note: 'Lab results take five working days and must be clear before handover.',
          },
          {
            id: 615, name: 'Medical equipment acceptance testing', duration: 2, budget: 6_000, assign: [MEDICAL_ENGINEERS, COMMISSIONING],
            note: 'Every item tested and logged. The medical physicist surveys the X-ray room before its first use.',
          },
          {
            id: 616, name: 'Air balancing & air-change tests', duration: 3, budget: 11_000, assign: [VENTILATION],
            note: "Air flows set room by room with the doors hung, and the air changes measured against the clinic's design criteria.",
          },
          {
            id: 617, name: 'Fire alarm & emergency lighting tests', duration: 2, budget: 6_500, assign: [COMMISSIONING],
            note: 'Witnessed by the fire marshal, including a 90-minute emergency lighting test.',
          },
        ],
      },
      {
        id: 620,
        name: 'Closeout & handover',
        children: [
          {
            id: 621, name: 'Punch list & touch-up', duration: 4, budget: 14_000, assign: [SITE_CREW, CARPENTERS],
            note: 'Joint walkthrough with the clinic manager; every item logged with a photo.',
          },
          { id: 622, name: "Final construction clean", duration: 2, budget: 8_000, assign: [SITE_CREW] },
          {
            id: 623, name: 'Staff training & O&M manuals', duration: 2, budget: 8_000, assign: [COMMISSIONING],
            note: 'Clinic staff trained on nurse call, the ventilation controls and the medical gas alarms; operation and maintenance manuals handed over.',
          },
          {
            id: 624, name: 'Final building inspection', duration: 1, budget: 1_200,
            note: 'The certificate of occupancy is needed before the clinic can open to patients.',
          },
          {
            id: HANDOVER_TASK, wbs: 625, name: 'Handover', duration: 0, budget: 0,
            note: 'Substantial completion: keys, certificates and manuals handed to the clinic.',
          },
        ],
      },
    ],
  },
];

/**
 * Finish-to-Start unless marked. Start-to-Start links (with a lag) let trades follow each other
 * through the building; the one Finish-to-Finish link has the priming finish two days after the last
 * piece is fabricated. The steel chain 231 -> 232 -> 233 -> 234 -> 15 drives the erection start the
 * crane booking misses, and the erection drives everything after it down to the Handover.
 */
const dependencySpecs: DependencySpec[] = [
  // Site setup & demolition
  { from: 113, to: 114 }, { from: 113, to: 121 },
  { from: 111, to: 122 }, { from: 122, to: 123 },
  { from: 121, to: 124 }, { from: 112, to: 124 }, { from: 114, to: 124 },
  // Steel design & fabrication: the fabricator needs the dimensional survey
  { from: 122, to: 231 }, { from: 231, to: 232 },
  // Spread footings
  { from: 123, to: 211 }, { from: 211, to: 212 }, { from: 212, to: 213 }, { from: 213, to: 214 }, { from: 214, to: 215 },
  { from: 215, to: 216 },
  // Steel delivery & frame erection
  { from: 232, to: 233, kind: 'FF', lag: 2 },
  { from: 233, to: 234 },
  { from: 234, to: STEEL_ERECTION_TASK }, { from: 216, to: STEEL_ERECTION_TASK },
  { from: STEEL_ERECTION_TASK, to: 242 }, { from: 242, to: 243 },
  // Slab on grade
  { from: 243, to: 251 }, { from: 251, to: 252 },
  // Roof & exterior walls: the deck is fixed from the new slab
  { from: 252, to: 311 }, { from: 311, to: 312 }, { from: 311, to: 313 },
  { from: 313, to: 314, kind: 'SS', lag: 2 },
  { from: 312, to: 315 }, { from: 313, to: 315 }, { from: 314, to: 315 },
  // Fireproofing & floor topping
  { from: 315, to: 321 }, { from: 315, to: 322 }, { from: 124, to: 322 },
  // Above-ceiling MEP, then the partitions and the services in them, then the hold point
  { from: 321, to: 341, kind: 'SS', lag: 3 },
  { from: 341, to: 342, kind: 'SS', lag: 4 },
  { from: 342, to: 343, kind: 'SS', lag: 2 },
  { from: 342, to: 351, kind: 'SS', lag: 3 },
  { from: 343, to: 352 }, { from: 351, to: 352, kind: 'SS', lag: 3 },
  { from: 351, to: 353, kind: 'SS', lag: 4 },
  { from: 341, to: 354 }, { from: 351, to: 354, kind: 'SS', lag: 5 },
  { from: 352, to: 355 },
  { from: 321, to: 331 }, { from: 341, to: 331 }, { from: 342, to: 331 }, { from: 351, to: 331 },
  { from: 353, to: 331 }, { from: 354, to: 331 }, { from: 355, to: 331 },
  // Partitions & ceilings
  { from: 331, to: 411 },
  { from: 411, to: 412, kind: 'SS', lag: 2 },
  { from: 411, to: 413 },
  // Painting & wall tile
  { from: 411, to: 421 }, { from: 411, to: 422 },
  // MEP trim-out
  { from: 413, to: 441 }, { from: 413, to: 442 }, { from: 413, to: 451 }, { from: 422, to: 451 }, { from: 451, to: 452 },
  // Floors, doors & millwork
  { from: 421, to: 461 }, { from: 322, to: 461 }, { from: 441, to: 461 }, { from: 452, to: 461 },
  { from: 461, to: 462 }, { from: 462, to: 463 }, { from: 462, to: 464 }, { from: 421, to: 464 },
  // IT & communications: the racks go in once the comms room locks
  { from: 462, to: 511 }, { from: 353, to: 511 },
  { from: 511, to: 512 },
  { from: 511, to: 513 }, { from: 441, to: 513 },
  // Medical equipment
  { from: 512, to: 521 }, { from: 451, to: 521 },
  { from: 521, to: 522 }, { from: 452, to: 522 },
  { from: 522, to: 523 }, { from: 461, to: 523 }, { from: 463, to: 523 },
  // Systems commissioning: the pendants carry gas, power and data, so the tests start with them
  { from: 513, to: 611 }, { from: 522, to: 611 },
  { from: 522, to: 612 },
  { from: 512, to: 613 }, { from: 513, to: 613 }, { from: 521, to: 613 }, { from: 522, to: 613 },
  { from: 612, to: 614 },
  { from: 523, to: 615 }, { from: 412, to: 615 },
  { from: 611, to: 616 }, { from: 442, to: 616 }, { from: 462, to: 616 },
  { from: 611, to: 617 }, { from: 615, to: 617 },
  // Closeout & handover
  { from: 463, to: 621 }, { from: 464, to: 621 }, { from: 613, to: 621 }, { from: 614, to: 621 }, { from: 616, to: 621 },
  { from: 617, to: 621 },
  { from: 621, to: 622 }, { from: 621, to: 623 },
  { from: 622, to: 624 }, { from: 623, to: 624 },
  { from: 624, to: HANDOVER_TASK },
];

const built = buildSeed({ start: SEED_PROJECT_START, phases, dependencies: dependencySpecs, resources });

export const riversideClinicRecords: SeedRecords = built.records;

const erection = must(
  riversideClinicRecords.tasks.find((task) => task.id === STEEL_ERECTION_TASK),
  'steel erection task',
);

/**
 * The crane is on rent from Monday, December 7 for 11 days, $6,600 at $600 a day, but the steel lay-down
 * only finishes on Thursday, December 10, so erection starts on Friday, December 11: four idle days
 * (December 7-10), $2,400. Erection then works the crane's six Mon-Sat days to the end of the rental (Fri,
 * Dec 11, Sat, Dec 12, then Mon, Dec 14 to Thu, Dec 17), with Sunday, Dec 13 paid and off.
 */
const BOOKING_START: IsoDate = '2026-12-07';
const BOOKING_END: IsoDate = '2026-12-18';

const craneBooking: SeedEquipmentBooking = {
  task_id: STEEL_ERECTION_TASK,
  resource_id: CRANE,
  supplier_name: 'Northgate Equipment Rental',
  supplier_payout_email: 'sb-northgate@personal.example.com',
  rental_rate_minor: 60000,
  currency: 'USD',
  billable_start: BOOKING_START,
  billable_end: BOOKING_END,
  idle_days: idleRentalDays({ start: BOOKING_START, end: BOOKING_END }, { start: erection.startDate, end: erection.endDate }).before,
  evidence_path: 'evidence/northgate-quote.pdf',
};

export const riversideClinic: SeedProject & { booking: SeedEquipmentBooking } = {
  name: 'Riverside Clinic',
  currency: 'USD',
  handover_task_id: HANDOVER_TASK,
  members: SEED_MEMBERS,
  inlineData: withRentalDates(built.inlineData, [craneBooking]),
  unlisted: true,
  booking: craneBooking,
};

export {
  HARBOR_CONTRACT_DATE,
  HARBOR_COPIES,
  HARBOR_COPY_COUNT,
  HARBOR_FOOTINGS_PAID,
  HARBOR_HANDOVER_TASK,
  HARBOR_IDS,
  HARBOR_QUOTES,
  HARBOR_STEEL_TASK,
  harborCopyIds,
  harborOffices,
  harborOfficesRecords,
  type HarborIds,
} from './harbor.ts';
export { CEDAR_IDS, CEDAR_QUOTES, cedarParkClinic, cedarParkRecords } from './cedar.ts';

/**
 * Every project the seed writes. Only Harbor Street Offices is listed: Riverside Clinic is the automated tests'
 * fixture, Cedar Park Clinic opens by its link, and Harbor's copies (last, after Harbor) wait for the hosted
 * demo's visitors.
 */
export const SEED_PROJECTS: readonly { project: SeedProject; ids: { readonly project: string; readonly booking?: string } }[] = [
  { project: riversideClinic, ids: SEED_IDS },
  { project: harborOffices, ids: HARBOR_IDS },
  { project: cedarParkClinic, ids: CEDAR_IDS },
  ...HARBOR_COPIES.map(({ project, ids }) => ({ project, ids })),
];
