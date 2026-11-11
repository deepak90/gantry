/**
 * A snippet laid out in working days (scheduleSnippet), drawn as a tiny Gantt for library cards and
 * the save form: one bar a few pixels high per task in its crew's color (the tasks that set the
 * length solid, the rest lighter), milestones as ticks, time ranges as faint bands. No text.
 */
import { useMemo } from 'react';
import { isGroupTask, scheduleSnippet, type SnippetBody, type SnippetRangeTone, type SnippetTask } from '@collab/shared';

/** A band's tone as a color (the same muted categories the live plan's bands use; amber is caution). */
export const TONE_COLORS: Readonly<Record<SnippetRangeTone, string>> = {
  amber: 'var(--warning-fill)',
  sky: 'var(--cat-1)',
  rose: 'var(--cat-3)',
  violet: 'var(--cat-5)',
  green: 'var(--cat-2)',
  slate: 'var(--cat-4)',
};

interface TimelineProps {
  body: Pick<SnippetBody, 'children' | 'links' | 'timeRanges'>;
  /** Color of a crew by name; undefined when the project has no such crew. */
  crewColor(name: string): string | undefined;
  scale?: number;
}

const flat = (tasks: readonly SnippetTask[]): SnippetTask[] => tasks.flatMap((task) => [task, ...flat(task.children ?? [])]);

export function SnippetMiniTimeline({ body, crewColor, scale = 1 }: TimelineProps) {
  const schedule = useMemo(() => scheduleSnippet(body, scale), [body, scale]);
  const leaves = flat(body.children).filter((task) => !isGroupTask(task));
  const shown = leaves.slice(0, 14);
  const span = Math.max(1, schedule.span);
  const rowHeight = 5;
  const height = Math.max(14, shown.length * rowHeight + 2);
  return (
    <svg className="snippet-mini" viewBox={`0 0 ${span} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${leaves.length} tasks over ${span} working days`}>
      {(body.timeRanges ?? []).map((range) => {
        const from = schedule.tasks.get(range.from.task);
        const to = schedule.tasks.get(range.to.task);
        if (!from || !to) return null;
        const x1 = range.from.edge === 'start' ? from.start : from.finish;
        const x2 = range.to.edge === 'start' ? to.start : to.finish;
        return <rect key={range.key} x={Math.min(x1, x2)} y={0} width={Math.max(0.3, Math.abs(x2 - x1))} height={height} style={{ fill: TONE_COLORS[range.tone ?? 'amber'] }} opacity={0.14} />;
      })}
      {shown.map((task, index) => {
        const at = schedule.tasks.get(task.key);
        if (!at) return null;
        const y = 1 + index * rowHeight;
        const color = crewColor(task.crews?.[0]?.name ?? '') ?? 'var(--cat-none)';
        if (at.finish === at.start) {
          return <rect key={task.key} x={at.start - 0.25} y={y} width={0.5} height={rowHeight - 1} style={{ fill: 'var(--ink)' }} />;
        }
        return <rect key={task.key} x={at.start} y={y} width={at.finish - at.start} height={rowHeight - 1.2} rx={0.4} style={{ fill: color }} opacity={at.critical ? 1 : 0.7} />;
      })}
    </svg>
  );
}
