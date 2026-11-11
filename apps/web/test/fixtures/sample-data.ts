/**
 * A small "Riverside Clinic build-out" fixture dataset for the model tests. Same shape and
 * conventions as the shared seed: plain `YYYY-MM-DD` dates (no timezone), integer minor-unit
 * costs, `kind` on resources, baselines on every leaf, a 5-day standard calendar plus a 6-day
 * site calendar for the crane work.
 */
import type { ProjectInlineData } from '@collab/shared';

const WORKING_DAY_CALENDARS = [
  {
    id: 'standard',
    name: 'Standard (Mon-Fri)',
    intervals: [
      { recurrentStartDate: 'on Sat at 00:00', recurrentEndDate: 'on Mon at 00:00', isWorking: false },
    ],
  },
  {
    id: 'site',
    name: 'Site (Mon-Sat)',
    intervals: [
      { recurrentStartDate: 'on Sun at 00:00', recurrentEndDate: 'on Mon at 00:00', isWorking: false },
    ],
  },
];

export const SAMPLE_INLINE_DATA: ProjectInlineData = {
  project: { calendar: 'standard', startDate: '2026-11-02' },
  calendarsData: WORKING_DAY_CALENDARS,
  tasksData: [
    {
      id: 1,
      name: 'Site preparation',
      expanded: true,
      children: [
        {
          id: 11,
          name: 'Site mobilization',
          startDate: '2026-11-02',
          duration: 3,
          percentDone: 100,
          costCode: 'EW-01',
          budgetMinor: 1_800_000,
          forecastMinor: 1_800_000,
          incurredMinor: 1_800_000,
          paidMinor: 1_800_000,
          baselines: [{ startDate: '2026-11-02', endDate: '2026-11-05' }],
        },
        {
          id: 12,
          name: 'Demolition',
          duration: 5,
          percentDone: 60,
          costCode: 'EW-02',
          budgetMinor: 2_400_000,
          forecastMinor: 2_500_000,
          incurredMinor: 1_500_000,
          paidMinor: 1_200_000,
          baselines: [{ startDate: '2026-11-05', endDate: '2026-11-12' }],
        },
      ],
    },
    {
      id: 2,
      name: 'Structure',
      expanded: true,
      children: [
        {
          id: 21,
          name: 'Steel delivery',
          duration: 2,
          costCode: 'ST-01',
          budgetMinor: 4_200_000,
          forecastMinor: 4_200_000,
          incurredMinor: 0,
          paidMinor: 0,
          baselines: [{ startDate: '2026-11-10', endDate: '2026-11-12' }],
        },
        {
          id: 22,
          name: 'Crane erection',
          duration: 6,
          calendar: 'site',
          costCode: 'ST-02',
          budgetMinor: 600_000,
          forecastMinor: 600_000,
          incurredMinor: 0,
          paidMinor: 0,
          baselines: [{ startDate: '2026-11-12', endDate: '2026-11-19' }],
        },
        {
          id: 23,
          name: 'Roof deck',
          duration: 4,
          costCode: 'ST-03',
          budgetMinor: 3_100_000,
          forecastMinor: 3_100_000,
          incurredMinor: 0,
          paidMinor: 0,
          baselines: [{ startDate: '2026-11-16', endDate: '2026-11-20' }],
        },
      ],
    },
    {
      id: 3,
      name: 'Services',
      expanded: true,
      children: [
        {
          id: 31,
          name: 'Electrical rough-in',
          duration: 6,
          costCode: 'SV-01',
          budgetMinor: 5_500_000,
          forecastMinor: 5_700_000,
          incurredMinor: 0,
          paidMinor: 0,
          baselines: [{ startDate: '2026-11-20', endDate: '2026-11-30' }],
        },
        {
          id: 32,
          name: 'Mechanical rough-in',
          duration: 5,
          costCode: 'SV-02',
          budgetMinor: 4_800_000,
          forecastMinor: 4_800_000,
          incurredMinor: 0,
          paidMinor: 0,
          baselines: [{ startDate: '2026-11-20', endDate: '2026-11-27' }],
        },
      ],
    },
    {
      id: 4,
      name: 'Build-out',
      expanded: true,
      children: [
        {
          id: 41,
          name: 'Partitions',
          duration: 5,
          costCode: 'FO-01',
          budgetMinor: 3_900_000,
          forecastMinor: 3_900_000,
          incurredMinor: 0,
          paidMinor: 0,
          baselines: [{ startDate: '2026-11-30', endDate: '2026-12-07' }],
        },
        {
          id: 42,
          name: 'Finishes',
          duration: 4,
          costCode: 'FO-02',
          budgetMinor: 2_700_000,
          forecastMinor: 2_700_000,
          incurredMinor: 0,
          paidMinor: 0,
          baselines: [{ startDate: '2026-12-07', endDate: '2026-12-11' }],
        },
      ],
    },
    {
      id: 5,
      name: 'Completion',
      expanded: true,
      children: [
        {
          id: 51,
          name: 'Commissioning',
          duration: 3,
          costCode: 'CP-01',
          budgetMinor: 900_000,
          forecastMinor: 900_000,
          incurredMinor: 0,
          paidMinor: 0,
          baselines: [{ startDate: '2026-12-11', endDate: '2026-12-16' }],
        },
        {
          id: 52,
          name: 'Handover',
          duration: 0,
          costCode: 'CP-02',
          baselines: [{ startDate: '2026-12-16', endDate: '2026-12-16' }],
        },
      ],
    },
  ],
  dependenciesData: [
    { id: 1, fromEvent: 11, toEvent: 12 },
    { id: 2, fromEvent: 12, toEvent: 21 },
    { id: 3, fromEvent: 21, toEvent: 22 },
    // Start-to-start with a two-day lag: decking follows the crane around the roof.
    { id: 4, fromEvent: 22, toEvent: 23, type: 0, lag: 2 },
    { id: 5, fromEvent: 23, toEvent: 31 },
    { id: 6, fromEvent: 23, toEvent: 32 },
    { id: 7, fromEvent: 31, toEvent: 41 },
    { id: 8, fromEvent: 32, toEvent: 41 },
    { id: 9, fromEvent: 41, toEvent: 42 },
    { id: 10, fromEvent: 42, toEvent: 51 },
    { id: 11, fromEvent: 51, toEvent: 52 },
  ],
  resourcesData: [
    { id: 1, name: 'Site crew', kind: 'labor' },
    { id: 2, name: 'Electricians', kind: 'labor' },
    { id: 3, name: 'Pipefitters', kind: 'labor' },
    { id: 4, name: 'Mobile crane (Northgate Equipment Rental)', kind: 'equipment' },
  ],
  assignmentsData: [
    { id: 1, event: 11, resource: 1, units: 100 },
    { id: 2, event: 12, resource: 1, units: 100 },
    { id: 3, event: 21, resource: 1, units: 50 },
    { id: 4, event: 22, resource: 1, units: 100 },
    { id: 5, event: 22, resource: 4, units: 100 },
    { id: 6, event: 23, resource: 1, units: 100 },
    { id: 7, event: 31, resource: 2, units: 100 },
    { id: 8, event: 32, resource: 3, units: 100 },
    { id: 9, event: 41, resource: 1, units: 100 },
    { id: 10, event: 42, resource: 1, units: 100 },
    { id: 11, event: 51, resource: 2, units: 100 },
  ],
};

/** Ids the tests rely on. */
export const SAMPLE_IDS = {
  firstPhase: 1,
  siteEstablishment: 11,
  stripOut: 12,
  steelDelivery: 21,
  craneErection: 22,
  handover: 52,
  crane: 4,
} as const;
