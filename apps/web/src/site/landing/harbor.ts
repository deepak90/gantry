/**
 * Harbor Street Offices, the demo project, as the landing page's model reads it: the rows of its seed plan as the
 * scheduling engine dates them (media/harbor-plan.json, written by scripts/harbor-plan.test.ts). The file keeps its
 * dates as calendar days, so the building goes up on the same days in every time zone; here they become the local
 * midnights a PlanTask holds, as the app's own rows are.
 */
import type { PlanMachine, PlanTask } from '../../gantt/fx3d/building-plan';

/** A PlanTask with its dates as calendar days ('YYYY-MM-DD'). */
export interface HarborPlanRow extends Omit<PlanTask, 'start' | 'end' | 'workDays' | 'machine'> {
  start: string;
  /** Exclusive. */
  end: string;
  workDays: string[];
  machine: (Omit<PlanMachine, 'booked'> & { booked: [string, string] }) | null;
}

/** Local midnight of a calendar day. */
export function midnightOf(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1).getTime();
}

export function planTasks(rows: readonly HarborPlanRow[]): PlanTask[] {
  return rows.map((row) => ({
    ...row,
    start: midnightOf(row.start),
    end: midnightOf(row.end),
    workDays: row.workDays.map(midnightOf),
    machine: row.machine ? { ...row.machine, booked: [midnightOf(row.machine.booked[0]), midnightOf(row.machine.booked[1])] as const } : null,
  }));
}
