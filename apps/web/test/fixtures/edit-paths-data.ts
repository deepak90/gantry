/**
 * Fixture for the edit-path suite: four levels of nesting, a split task, finish-to-start and
 * start-to-start dependencies, crews from different companies, cost fields and notes. Ids 15
 * (crane erection, the booked activity) and 42 (handover milestone) match the shared seed; nothing
 * else depends on the seed's contents.
 */
import type { ProjectInlineData } from '@collab/shared';

export const EDIT_IDS = {
  enabling: 1,
  siteSetup: 11,
  stripOut: 12,
  structure: 2,
  frame: 21,
  columns: 211,
  columnBases: 2111,
  columnErection: 2112,
  beams: 212,
  crane: 15,
  roofDeck: 22,
  completion: 3,
  commissioning: 31,
  handover: 42,
  siteCrew: 1,
  riggers: 2,
  steelErectors: 3,
  mobileCrane: 4,
} as const;

const costs = (code: string, budget: number, incurred = 0, paid = 0) => ({
  costCode: code,
  budgetMinor: budget,
  forecastMinor: budget,
  incurredMinor: incurred,
  paidMinor: paid,
});

export function editPathsData(): ProjectInlineData {
  return {
    project: { calendar: 'standard', startDate: '2026-11-02' },
    calendarsData: [
      {
        id: 'standard',
        name: 'Standard (Mon-Fri)',
        intervals: [{ recurrentStartDate: 'on Sat at 00:00', recurrentEndDate: 'on Mon at 00:00', isWorking: false }],
      },
    ],
    tasksData: [
      {
        id: 1,
        name: 'Site preparation',
        expanded: true,
        children: [
          { id: 11, name: 'Site setup', startDate: '2026-11-02', duration: 2, percentDone: 100, ...costs('EW-01', 800_000, 800_000, 800_000) },
          { id: 12, name: 'Demolition', duration: 3, percentDone: 40, note: 'Asbestos survey cleared', ...costs('EW-02', 1_200_000, 400_000) },
        ],
      },
      {
        id: 2,
        name: 'Structure',
        expanded: true,
        children: [
          {
            id: 21,
            name: 'Frame',
            expanded: true,
            children: [
              {
                id: 211,
                name: 'Columns',
                expanded: true,
                children: [
                  { id: 2111, name: 'Column bases', duration: 2, ...costs('ST-11', 900_000) },
                  { id: 2112, name: 'Column erection', duration: 3, ...costs('ST-12', 1_500_000) },
                ],
              },
              { id: 212, name: 'Beams', duration: 2, ...costs('ST-13', 1_100_000) },
            ],
          },
          { id: 15, name: 'Crane erection', duration: 2, ...costs('ST-02', 600_000) },
          {
            id: 22,
            name: 'Roof deck',
            // A segmented task needs its own start (snapshots always carry one); the engine keeps it on the SS lag.
            startDate: '2026-11-17',
            duration: 4,
            segments: [
              { startDate: '2026-11-17', duration: 2 },
              { startDate: '2026-11-20', duration: 2 },
            ],
            ...costs('ST-03', 2_000_000),
          },
        ],
      },
      {
        id: 3,
        name: 'Completion',
        expanded: true,
        children: [
          { id: 31, name: 'Commissioning', duration: 2, ...costs('CP-01', 500_000) },
          { id: 42, name: 'Handover', duration: 0 },
        ],
      },
    ],
    dependenciesData: [
      { id: 1, fromEvent: 11, toEvent: 12 },
      { id: 2, fromEvent: 12, toEvent: 15 },
      { id: 3, fromEvent: 12, toEvent: 2111 },
      { id: 4, fromEvent: 2111, toEvent: 2112 },
      { id: 5, fromEvent: 15, toEvent: 2112 },
      { id: 6, fromEvent: 2112, toEvent: 212 },
      // Start-to-start with a one-day lag: decking follows the beams.
      { id: 7, fromEvent: 212, toEvent: 22, type: 0, lag: 1 },
      { id: 8, fromEvent: 22, toEvent: 31 },
      { id: 9, fromEvent: 31, toEvent: 42 },
    ],
    resourcesData: [
      { id: 1, name: 'Site crew', kind: 'labor', company: 'Riverside Build', eventColor: 'blue' },
      { id: 2, name: 'Riggers', kind: 'labor', company: 'Northgate Equipment Rental', eventColor: 'teal' },
      { id: 3, name: 'Steel erectors', kind: 'labor', company: 'Apex Steel', eventColor: 'indigo' },
      { id: 4, name: 'Mobile crane', kind: 'equipment', company: 'Northgate Equipment Rental', eventColor: 'orange' },
    ],
    assignmentsData: [
      { id: 1, event: 11, resource: 1, units: 100 },
      { id: 2, event: 12, resource: 1, units: 100 },
      { id: 3, event: 15, resource: 4, units: 100 },
      { id: 4, event: 15, resource: 2, units: 100 },
      { id: 5, event: 2111, resource: 3, units: 100 },
      { id: 6, event: 2112, resource: 3, units: 100 },
      { id: 7, event: 2112, resource: 4, units: 50 },
      { id: 8, event: 212, resource: 3, units: 100 },
      { id: 9, event: 22, resource: 1, units: 50 },
    ],
  };
}
