/**
 * The assistant's text with its links. The model may write a task it names as
 * `[Crane erection](task:3104)`; besides those, the plan's own names found in the words are linked
 * too: a task whose name is unique in the plan, and a crew or piece of equipment. A task link selects
 * the task in the plan and brings it into view; a crew link shows the crew's work. A link to a task
 * that is not in the plan (any more) is shown as plain words, so a made-up or stale id never becomes a
 * button. An amount the assistant left out (someone reading may not see costs) shows as a small lock.
 */
import type { ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { Fragment, type ReactNode } from 'react';
import { liveTask } from './live-plan';
import { walkPlan } from '../gantt/walk';

export type TextPiece = string | { label: string; taskId: number } | { label: string; crew: string } | { withheld: true };

const TASK_LINK = /\[([^\]\n]{1,160})\]\(task:(\d{1,12})\)/g;
/** What the assistant writes for an amount it leaves out (apps/agent/src/agent/audience.ts). */
const WITHHELD = '[amount withheld]';

/** The plan's names that become links in plain text: unique task names and crew names. */
export interface PlanEntities {
  pattern: RegExp | null;
  byName: ReadonlyMap<string, { taskId: number } | { crew: string }>;
}

const NO_ENTITIES: PlanEntities = { pattern: null, byName: new Map() };
const key = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The names to look for: tasks with a name of 6 characters or more that no other task shares (a
 * repeated name would be ambiguous), and every crew with a name of 4 or more. Longest first, so
 * "Pour spread footings" wins over "Pour".
 */
export function planEntities(project: ProjectModel | null): PlanEntities {
  if (!project) return NO_ENTITIES;
  const counts = new Map<string, number>();
  const tasks: { name: string; id: number }[] = [];
  walkPlan(project, (record) => {
    const task = record as TaskModel;
    if (task.isRoot || typeof task.id !== 'number') return;
    const name = (task.name ?? '').trim();
    if (name.length < 6) return;
    counts.set(key(name), (counts.get(key(name)) ?? 0) + 1);
    tasks.push({ name, id: task.id });
  });
  const byName = new Map<string, { taskId: number } | { crew: string }>();
  for (const task of tasks) if (counts.get(key(task.name)) === 1) byName.set(key(task.name), { taskId: task.id });
  for (const resource of project.resourceStore.allRecords as ResourceModel[]) {
    const name = (resource.name ?? '').trim();
    if (name.length >= 4 && !byName.has(key(name))) byName.set(key(name), { crew: name });
  }
  if (byName.size === 0) return NO_ENTITIES;
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map((name) => escape(name).replace(/ /g, '\\s+'));
  return { pattern: new RegExp(`(?<![\\w&])(${names.join('|')})(?![\\w&])`, 'gi'), byName };
}

/** Splits plain words into runs, the plan's names and left-out amounts. */
function namePieces(text: string, entities: PlanEntities): TextPiece[] {
  const pieces: TextPiece[] = [];
  const runs = text.split(WITHHELD);
  runs.forEach((run, index) => {
    if (index > 0) pieces.push({ withheld: true });
    if (!entities.pattern) {
      if (run) pieces.push(run);
      return;
    }
    let last = 0;
    for (const match of run.matchAll(entities.pattern)) {
      const at = match.index ?? 0;
      const found = entities.byName.get(key(match[0]));
      if (!found) continue;
      if (at > last) pieces.push(run.slice(last, at));
      pieces.push('taskId' in found ? { label: match[0], taskId: found.taskId } : { label: match[0], crew: found.crew });
      last = at + match[0].length;
    }
    if (last < run.length) pieces.push(run.slice(last));
  });
  return pieces;
}

/** Splits text into plain runs, task links (written or found), crew links and left-out amounts. */
export function taskPieces(text: string, entities: PlanEntities = NO_ENTITIES): TextPiece[] {
  const pieces: TextPiece[] = [];
  let last = 0;
  for (const match of text.matchAll(TASK_LINK)) {
    const at = match.index ?? 0;
    if (at > last) pieces.push(...namePieces(text.slice(last, at), entities));
    pieces.push({ label: match[1]!, taskId: Number(match[2]) });
    last = at + match[0].length;
  }
  if (last < text.length) pieces.push(...namePieces(text.slice(last), entities));
  return pieces;
}

export interface RichTextEnv {
  project: ProjectModel | null;
  showTasks(ids: readonly number[]): void;
  /** The plan's names linked in plain text (planEntities); none when absent. */
  entities?: PlanEntities;
  /** Shows a crew's work in the plan. */
  showCrew?(name: string): void;
}

/** A left-out amount, as a small lock. */
function Withheld() {
  return (
    <span className="pill is-sm assistant-withheld" title="Left out: someone reading this thread may not see costs">
      <i className="fa fa-lock" aria-hidden="true" /> hidden
    </span>
  );
}

/** Plain text (a card's words) with any left-out amount drawn as a small lock. */
export function withheldText(text: string): ReactNode {
  if (!text.includes(WITHHELD)) return text;
  return text.split(WITHHELD).flatMap((run, index) => (index === 0 ? [run] : [<Withheld key={index} />, run]));
}

function TaskLink({ label, taskId, env }: { label: string; taskId: number; env: RichTextEnv }) {
  const task = env.project ? liveTask(env.project, taskId) : null;
  if (!task) return <>{label}</>;
  return (
    <button type="button" className="assistant-task-link" onClick={() => env.showTasks([taskId])} title={`${[...task.path, task.name].join(' › ')}: show in the plan`} data-testid="assistant-task-link">
      {task.critical && <i className="fa fa-bolt" aria-label="Sets the handover date" />}
      {label}
    </button>
  );
}

function CrewLink({ label, crew, env }: { label: string; crew: string; env: RichTextEnv }) {
  if (!env.showCrew) return <>{label}</>;
  return (
    <button type="button" className="assistant-task-link is-crew" onClick={() => env.showCrew?.(crew)} title={`${crew}: show their work in the plan`} data-testid="assistant-crew-link">
      <i className="fa fa-helmet-safety" aria-hidden="true" />
      {label}
    </button>
  );
}

export function RichParagraphs({ text, env }: { text: string; env: RichTextEnv }) {
  return (
    <>
      {text
        .split(/\n{2,}/)
        .filter((paragraph) => paragraph.trim())
        .map((paragraph, index) => (
          <p key={index}>
            {taskPieces(paragraph.trim(), env.entities).map((piece, at) =>
              typeof piece === 'string' ? (
                <Fragment key={at}>{piece}</Fragment>
              ) : 'withheld' in piece ? (
                <Withheld key={at} />
              ) : 'crew' in piece ? (
                <CrewLink key={at} label={piece.label} crew={piece.crew} env={env} />
              ) : (
                <TaskLink key={at} label={piece.label} taskId={piece.taskId} env={env} />
              ),
            )}
          </p>
        ))}
    </>
  );
}
