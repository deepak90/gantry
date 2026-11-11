import type { ProjectModel } from '@bryntum/gantt';
import type { ProjectInlineData } from '@collab/shared';
import { riversideClinic } from '@collab/shared/seed';
import { createProjectModel, toInlineDataPackage } from '../../src/gantt/project';

/** A real seed project as test data (the crowd itself knows no project's ids). */
export const SEED = riversideClinic;

export function seedSnapshot(): ProjectInlineData {
  return JSON.parse(JSON.stringify(SEED.inlineData)) as ProjectInlineData;
}

/** The production model loaded with the seed, recording revisions like a client does. */
export async function seededProject(): Promise<ProjectModel> {
  const project = createProjectModel();
  const stm = project.stm as unknown as { disable(): void; enable(): void };
  stm.disable();
  await project.loadInlineData(toInlineDataPackage(seedSnapshot()) as object);
  stm.enable();
  project.initRevisions('crowd-test', '0');
  await project.commitAsync();
  return project;
}

/** Lets promise chains run (the fake clock fires timers synchronously). */
export async function flush(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round++) await Promise.resolve();
}
