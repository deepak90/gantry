/**
 * The building in a plan (gantt/fx3d/building-plan.ts), read from the Harbor Street Offices seed: every row is a piece
 * of a layer, the pours are concrete steps on the right thing, the stories have their groups, a weekend builds nothing,
 * and the crane is idle on rent before and after its work but not over a weekend inside it. The clinics are not
 * buildings of several stories, so they keep the site board.
 */
import { cedarParkRecords, harborOffices, harborOfficesRecords, HARBOR_STEEL_TASK, riversideClinicRecords, type SeedRecords } from '@collab/shared/seed';
import { describe, expect, it } from 'vitest';
import { builtBy, idleBy, kindOf, levelIn, machineOn, type PlanTask, readBuilding } from '../../src/gantt/fx3d/building-plan';

const DAY = 86_400_000;
const midnight = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year!, month! - 1, day!).getTime();
};
function weekdays(start: number, end: number): number[] {
  const days: number[] = [];
  for (let at = start; at < end; at = new Date(new Date(at).getFullYear(), new Date(at).getMonth(), new Date(at).getDate() + 1).getTime()) {
    const weekday = new Date(at).getDay();
    if (weekday !== 0 && weekday !== 6) days.push(at);
  }
  return days;
}

/** The seed's rows as the view hands them over. */
function planOf(records: SeedRecords, rentals: readonly { task_id: number; billable_start: string; billable_end: string; rental_rate_minor: number }[] = []): PlanTask[] {
  const byId = new Map(records.tasks.map((task) => [task.id, task]));
  return records.tasks
    .filter((task) => !records.tasks.some((other) => other.parentId === task.id))
    .map((task) => {
      const path: string[] = [];
      const pathIds: number[] = [];
      for (let parent = task.parentId; parent !== null; parent = byId.get(parent)?.parentId ?? null) {
        path.unshift(byId.get(parent)!.name);
        pathIds.unshift(parent);
      }
      const start = midnight(task.startDate);
      const end = midnight(task.endDate);
      const rental = rentals.find((entry) => entry.task_id === task.id);
      return {
        id: task.id,
        name: task.name,
        path,
        pathIds,
        wbs: '',
        start,
        end,
        workDays: weekdays(start, end),
        color: '#888888',
        crews: [],
        machine: rental ? { kind: task.id === HARBOR_STEEL_TASK ? 'crane' : 'lift', name: task.id === HARBOR_STEEL_TASK ? 'Tower crane' : 'Scissor lift', booked: [midnight(rental.billable_start), midnight(rental.billable_end)] as const, rateMinor: rental.rental_rate_minor } : null,
        percent: 0,
        milestone: start === end,
      };
    });
}

const harbor = planOf(harborOfficesRecords, [harborOffices.booking!, ...(harborOffices.moreBookings ?? [])]);
const building = readBuilding(harbor)!;
const part = (name: string) => building.parts.find((entry) => entry.task.name === name)!;

describe('reading a building out of a plan', () => {
  it('reads Harbor as foundations, four stories and a roof', () => {
    expect(building).not.toBeNull();
    expect(building.stories).toBe(4);
    expect(building.layers.map((layer) => layer.name)).toEqual(['Foundations', 'Ground floor', 'Level 1', 'Level 2', 'Level 3', 'Roof']);
    expect(building.layers.map((layer) => layer.short)).toEqual(['F', 'G', 'L1', 'L2', 'L3', 'R']);
  });

  it('puts every pour step on what it pours, in its layer', () => {
    expect(part('Form footings')).toMatchObject({ kind: 'forms', target: 'footings', layer: 0 });
    expect(part('Pour footings')).toMatchObject({ kind: 'pour', target: 'footings', layer: 0 });
    expect(part('Strip forms and backfill')).toMatchObject({ kind: 'strip', layer: 0 });
    expect(part('Gravel base and vapor barrier')).toMatchObject({ kind: 'base', target: 'slab', layer: 1 });
    expect(part('Pour slab on grade')).toMatchObject({ kind: 'pour', target: 'slab', layer: 1 });
    expect(part('Edge forms and shoring, level 2')).toMatchObject({ kind: 'forms', target: 'deck', layer: 3 });
    expect(part('Pour deck, level 2')).toMatchObject({ kind: 'pour', target: 'deck', layer: 3 });
    expect(part('Cure deck, level 3')).toMatchObject({ kind: 'cure', target: 'deck', layer: 4 });
  });

  it('spreads the steel and the glass over the whole building, and puts the rest where it is built', () => {
    expect(part('Erect steel and metal deck')).toMatchObject({ kind: 'steel', layer: -1 });
    expect(part('Curtain wall')).toMatchObject({ kind: 'curtainwall', layer: -1 });
    expect(part('Roofing')).toMatchObject({ kind: 'roofing', layer: 5 });
    expect(part('Mobilize site')).toMatchObject({ kind: 'mobilize', layer: 0 });
    expect(part('Lobby finishes, ground floor')).toMatchObject({ kind: 'lobby', layer: 1 });
    expect(part('Storefront and entrance, ground floor')).toMatchObject({ kind: 'storefront', layer: 1 });
    expect(part('Ceiling grid, level 1')).toMatchObject({ kind: 'grid', layer: 2 });
    expect(part('Floor finishes, level 3')).toMatchObject({ kind: 'flooring', layer: 4 });
    expect(part('Handover to tenant')).toMatchObject({ kind: 'handover', layer: -1 });
  });

  it('gives each office story the group that builds it out, so choosing the group takes out the story', () => {
    expect(building.layers[2]!.groupId).toBe(100);
    expect(building.layers[3]!.groupId).toBe(200);
    expect(building.layers[4]!.groupId).toBe(300);
    // The ground floor's build-out, not the slab: an inspection among a pour's rows doesn't make the pour a story's group.
    expect(building.layers[1]!.groupId).toBe(90);
  });

  it('knows a light-fixture package by its rows, wherever the library put it', () => {
    expect(kindOf('Order light fixtures, levels 1 to 3')).toBe('order');
    expect(kindOf('Deliver light fixtures')).toBe('delivery');
    expect(kindOf('Run wiring and mounting hardware')).toBe('wiring');
    expect(kindOf('Install light fixtures')).toBe('lights');
    expect(kindOf('Test and aim lighting')).toBe('test');
    expect(levelIn('Level 2 build-out')).toBe(2);
    expect(levelIn('Lobby finishes, ground floor')).toBe(0);
    expect(levelIn('Install light fixtures')).toBeNull();
  });

  it('leaves the clinics to the site board: neither is a building of several stories', () => {
    expect(readBuilding(planOf(cedarParkRecords))).toBeNull();
    expect(readBuilding(planOf(riversideClinicRecords))).toBeNull();
  });
});

describe('a row on a date', () => {
  const steel = part('Erect steel and metal deck').task;

  it('builds on working days only, part of a day as it goes', () => {
    expect(builtBy(steel, steel.start - DAY)).toBe(0);
    // Half of the first of eleven working days.
    expect(builtBy(steel, steel.start + DAY / 2)).toBeCloseTo(0.5 / 11);
    // The steel starts on a Wednesday, so the first Friday is its third working day. Saturday and Sunday build nothing:
    // Friday's end is where Monday starts.
    const friday = steel.workDays[2]!;
    expect(new Date(friday).getDay()).toBe(5);
    expect(builtBy(steel, friday + DAY + DAY / 2)).toBeCloseTo(3 / 11);
    expect(builtBy(steel, friday + 2 * DAY + DAY / 2)).toBeCloseTo(3 / 11);
    expect(builtBy(steel, steel.end)).toBe(1);
  });

  it('has the crane idle on rent before and after the steel, but not over the weekend inside it', () => {
    const crane = building.bookings.find((booking) => booking.machine.kind === 'crane')!;
    // On rent from the day before Thanksgiving to Wed, Dec 23; the steel runs Wed, Dec 2 to Wed, Dec 16: seven days
    // idle before it and seven after.
    expect(machineOn(crane, midnight('2026-11-26') + DAY / 2)).toEqual({ booked: true, working: false, idle: true });
    expect(machineOn(crane, midnight('2026-12-03') + DAY / 2)).toEqual({ booked: true, working: true, idle: false });
    // A Saturday inside the steel is paid for but not idle; a Sunday after it is idle.
    expect(machineOn(crane, midnight('2026-12-05') + DAY / 2)).toEqual({ booked: true, working: false, idle: false });
    expect(machineOn(crane, midnight('2026-12-20') + DAY / 2)).toEqual({ booked: true, working: false, idle: true });
    expect(machineOn(crane, midnight('2026-12-24') + DAY / 2).booked).toBe(false);
    expect(idleBy(crane, Number.MAX_SAFE_INTEGER)).toEqual({ days: 14, costMinor: 840_000 });
    expect(idleBy(crane, midnight('2026-11-27') + DAY / 2)).toEqual({ days: 3, costMinor: 180_000 });
  });

  it('runs from the first day of work or rent to a day past the handover', () => {
    expect(building.span[0]).toBe(midnight('2026-10-19'));
    expect(building.span[1]).toBe(midnight('2027-05-27') + DAY);
  });
});
