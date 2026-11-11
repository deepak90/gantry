/**
 * A counter that moves whenever the scheduling engine has written new results into the project's
 * records: local edits, applied revisions and loads alike. Views derived from the live schedule
 * (header figures, bar decorations, filter counts) recompute on it, without waiting for the
 * server to confirm a revision. A machine's dates on a task schedule nothing, so the engine may stay
 * silent about them: they move it too.
 */
import type { ProjectModel } from '@bryntum/gantt';
import { useEffect, useState } from 'react';

export function useProjectDataVersion(project: ProjectModel): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((current) => current + 1);
    const detachers = [project.on('dataReady', bump), project.assignmentStore.on('update', bump)] as unknown as ((() => void) | undefined)[];
    return () => detachers.forEach((detach) => detach?.());
  }, [project]);
  return version;
}
