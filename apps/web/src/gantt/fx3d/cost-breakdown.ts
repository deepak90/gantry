/**
 * What a piece of work costs, line by line: each crew, each machine while it works, and each machine while it has no work.
 * The plan gives one forecast for a job and a daily rate for its rented machine, so the machine comes out of the
 * forecast at its rate, and the crews share what is left by how many people each has on the job.
 */
import type { DayTile } from './day-track';

export type CostKind = 'crew' | 'machine' | 'idle';

export interface CostLine {
  /** Who it goes to: the same across jobs, so they can be added up by firm. */
  who: string;
  kind: CostKind;
  color: string;
  minor: number;
}

export interface CostInput {
  forecastMinor: number;
  crews: readonly { name: string; color: string; people: number }[];
  machine: { name: string; color: string; rateMinor: number } | null;
  days: readonly DayTile[];
  idleColor: string;
  /** What the money goes to when no crew is on the job yet. */
  unassigned: string;
  unassignedColor: string;
}

export function costLines(input: CostInput): CostLine[] {
  const count = (kinds: readonly string[]): number => input.days.filter((day) => kinds.includes(day.kind)).length;
  const rate = input.machine?.rateMinor ?? 0;
  const working = rate * count(['work', 'paid', 'cover']);
  const idle = rate * count(['idle']);
  const left = Math.max(0, input.forecastMinor - working - idle);
  const lines: CostLine[] = [];
  const everyone = input.crews.reduce((sum, crew) => sum + Math.max(1, crew.people), 0);
  if (input.crews.length === 0) {
    if (left > 0) lines.push({ who: input.unassigned, kind: 'crew', color: input.unassignedColor, minor: left });
  } else {
    for (const crew of input.crews) {
      const minor = (left * Math.max(1, crew.people)) / everyone;
      if (minor > 0) lines.push({ who: crew.name, kind: 'crew', color: crew.color, minor });
    }
  }
  if (input.machine && working > 0) lines.push({ who: input.machine.name, kind: 'machine', color: input.machine.color, minor: working });
  if (input.machine && idle > 0) lines.push({ who: input.machine.name, kind: 'idle', color: input.idleColor, minor: idle });
  return lines;
}

export interface MoneySegment {
  key: unknown;
  /** Named in full where the reader points at it. */
  title: string;
  minor: number;
  /** How much of it has gone out by the date, from 0 to 1. */
  share: number;
  color: string;
}

export interface MoneyRow {
  label: string;
  segments: MoneySegment[];
}

export const rowTotal = (row: MoneyRow): number => row.segments.reduce((sum, segment) => sum + segment.minor, 0);
export const rowSoFar = (row: MoneyRow): number => row.segments.reduce((sum, segment) => sum + segment.minor * segment.share, 0);

/** A firm's money, whatever jobs it is on: rows from the most to the least, each job its own segment. */
export function rowsByFirm<W>(works: readonly { work: W; title: string; lines: readonly CostLine[]; share: (line: CostLine) => number }[]): MoneyRow[] {
  const rows = new Map<string, MoneyRow>();
  for (const { work, title, lines, share } of works) {
    for (const line of lines) {
      const row = rows.get(line.who) ?? { label: line.who, segments: [] };
      row.segments.push({ key: work, title: `${title}${line.kind === 'idle' ? ', standing idle' : ''}`, minor: line.minor, share: share(line), color: line.color });
      rows.set(line.who, row);
    }
  }
  return [...rows.values()].sort((a, b) => rowTotal(b) - rowTotal(a));
}
