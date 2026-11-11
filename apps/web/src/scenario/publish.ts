/**
 * Changing the live project in code: one short STM transaction inside the project queue (the pattern
 * of the Bryntum guide "Revisions / Project Queue"), which Bryntum turns into one local revision for
 * RevisionSync to submit, and every client, this one included, receives through the revision stream.
 */
import type { ProjectModel } from '@bryntum/gantt';

interface TransactionalStm {
  isRecording: boolean;
  startTransaction(title?: string): void;
  stopTransaction(title?: string): void;
  rejectTransaction(): void;
}

/**
 * Runs `change` as its own STM transaction, never merged with an auto-recorded user edit. Several
 * steps are made one after another, each scheduled before the next (still one revision).
 */
/**
 * Resolves once the server has accepted this browser's changes (or after `timeoutMs`), so whoever is
 * told about a change next reads the plan with it in.
 */
export async function whenSaved(project: ProjectModel, timeoutMs = 8_000): Promise<void> {
  // A project already let go of (its page closed, or a hosted copy started over) has nothing left to save.
  const stm = project.stm as unknown as { localRevisions?: unknown[] } | undefined;
  const deadline = Date.now() + timeoutMs;
  // The revision of a finished transaction is recorded just after it.
  await new Promise((resolve) => setTimeout(resolve, 150));
  while ((stm?.localRevisions?.length ?? 0) > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export function runProjectTransaction(project: ProjectModel, title: string, change: (() => unknown) | readonly (() => unknown)[]): Promise<void> {
  const queued = project as unknown as { queue(step: () => unknown): Promise<unknown> };
  const stm = project.stm as unknown as TransactionalStm;
  const steps = typeof change === 'function' ? [change] : change;
  return queued
    .queue(async () => {
      if (stm.isRecording) {
        stm.stopTransaction();
      }
      stm.startTransaction(title);
      try {
        for (const step of steps) {
          // Some engine edits (a task's parts, say) run in stages of their own: the commit has to come after them.
          const pending = step();
          if (pending instanceof Promise) await pending;
          const commit = (await project.commitAsync()) as { rejectedWith?: unknown } | undefined;
          // A scheduling conflict nobody resolved: the engine has rolled the whole transaction back.
          if (commit?.rejectedWith) return;
        }
        stm.stopTransaction(title);
      } catch (error) {
        if (stm.isRecording) {
          stm.rejectTransaction();
        }
        throw error;
      }
    })
    .then(() => undefined);
}
