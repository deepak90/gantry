/**
 * place-snippet: where a library piece belongs in a group of the plan (a floor, a work package). The
 * browser sends the piece (its tasks and trades), the group's tasks in order, where the person let
 * go, and how the same piece was placed before (on another floor); Claude answers with the task it
 * goes after (and before), and why, in one sentence. The answer is checked against the group: a task
 * that is not in it is refused, never guessed. Without a model (no ANTHROPIC_API_KEY) the function
 * says so, and the browser places the piece by its own rules.
 */
import { asObject } from './json.ts';
import { corsHeaders } from './cors.ts';
import { internalError } from './failures.ts';
import { HttpError, bearerToken, errorResponse, json } from './http.ts';

export interface PlacementTask {
  id: string;
  name: string;
  trade: string | null;
  start: string | null;
  end: string | null;
  waits_for: string[];
}

export interface PlacementGroup {
  id: string;
  name: string;
  tasks: PlacementTask[];
}

export interface PlacementRequest {
  project_id: string;
  snippet: { name: string; summary: string; tasks: { name: string; trade: string | null; days: number }[] };
  group: PlacementGroup;
  /** The other groups for the same place, where the piece may belong instead. */
  other_groups: PlacementGroup[];
  /** The group task the person let go after, if any. */
  dropped_after: string | null;
  /** How the same piece was placed before, on another group. */
  precedent: { group: string; after: string; before: string | null } | null;
}

export interface PlacementAnswer {
  after_id: string;
  before_id: string | null;
  reason: string;
  /** False when the piece belongs in none of the groups offered; after_id is then where it was let go. */
  fits: boolean;
  source: 'model';
}

/** Asks the model; returns the text of its JSON answer. */
export type AskModel = (request: { system: string; user: string; schema: Record<string, unknown> }) => Promise<string>;

export interface PlacementDeps {
  env: { get(name: string): string | undefined };
  resolveUser(accessToken: string): Promise<string | null>;
  isMember(projectId: string, userId: string): Promise<boolean>;
  ask: AskModel | null;
  log(message: string, error?: unknown): void;
}

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const id = (value: unknown): string | null => (typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value, 64));

/** A group's tasks, checked and trimmed; those without an id or a name are left out. */
function readTasks(entries: unknown): PlacementTask[] {
  return (Array.isArray(entries) ? entries.slice(0, 80) : []).flatMap((entry) => {
    const task = asObject(entry);
    const taskId = id(task.id);
    const name = text(task.name, 160);
    if (!taskId || !name) return [];
    return [{
      id: taskId,
      name,
      trade: text(task.trade, 60),
      start: text(task.start, 10),
      end: text(task.end, 10),
      waits_for: Array.isArray(task.waits_for) ? task.waits_for.map(id).filter((value): value is string => value !== null).slice(0, 12) : [],
    }];
  });
}

/** The request body, checked and trimmed; anything malformed is a 400. */
export function readPlacementRequest(body: unknown): PlacementRequest {
  const raw = asObject(body);
  const bad = (message: string) => new HttpError(400, 'INVALID_REQUEST', message);
  const projectId = text(raw.project_id, 64);
  if (!projectId) throw bad('project_id is required.');
  const snippet = asObject(raw.snippet);
  const group = asObject(raw.group);
  const snippetTasks = Array.isArray(snippet.tasks) ? snippet.tasks.slice(0, 40) : [];
  const groupTasks = Array.isArray(group.tasks) ? group.tasks : [];
  const groupId = id(group.id);
  const snippetName = text(snippet.name, 120);
  if (!snippetName || snippetTasks.length === 0) throw bad('snippet needs a name and its tasks.');
  if (!groupId || groupTasks.length === 0) throw bad('group needs an id and its tasks.');
  const tasks = readTasks(groupTasks);
  if (tasks.length === 0) throw bad('group tasks need ids and names.');
  // Other groups for the same place: a few, each with tasks; one that is malformed is left out, not refused.
  const others = (Array.isArray(raw.other_groups) ? raw.other_groups.slice(0, 3) : []).flatMap((entry) => {
    const other = asObject(entry);
    const otherId = id(other.id);
    const otherTasks = readTasks(other.tasks);
    return otherId && otherId !== groupId && otherTasks.length > 0 ? [{ id: otherId, name: text(other.name, 160) ?? 'another group', tasks: otherTasks }] : [];
  });
  const precedent = raw.precedent && typeof raw.precedent === 'object' ? asObject(raw.precedent) : null;
  const after = precedent ? text(precedent.after, 160) : null;
  return {
    project_id: projectId,
    snippet: {
      name: snippetName,
      summary: text(snippet.summary, 400) ?? '',
      tasks: snippetTasks.flatMap((entry) => {
        const task = asObject(entry);
        const name = text(task.name, 160);
        return name ? [{ name, trade: text(task.trade, 60), days: typeof task.days === 'number' ? Math.max(0, Math.round(task.days)) : 0 }] : [];
      }),
    },
    group: { id: groupId, name: text(group.name, 160) ?? 'the group', tasks },
    other_groups: others,
    dropped_after: id(raw.dropped_after),
    precedent: precedent && after ? { group: text(precedent.group, 160) ?? 'another group', after, before: text(precedent.before, 160) } : null,
  };
}

export const PLACEMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    after_id: { type: 'string', description: 'Id of the task the piece goes after, in the group its work belongs in' },
    before_id: { type: ['string', 'null'], description: 'Id of the task in that same group that should wait for the piece, or null' },
    fits: { type: 'boolean', description: 'False only when the piece belongs in none of the groups offered; after_id is then the task it was let go after' },
    reason: {
      type: 'string',
      description: 'One plain sentence, at most 30 words: why it goes there (trade order, what it needs, what it would block), or, when it does not fit, why not and where such work belongs. Name tasks and groups by their names, never by id.',
    },
  },
  required: ['after_id', 'before_id', 'fits', 'reason'],
  additionalProperties: false,
};

export const PLACEMENT_SYSTEM = [
  'You are the project assistant on a construction site plan. Someone is dropping a reusable piece of work (a library snippet) into one group of the plan, such as a floor.',
  'First decide which group the work belongs in. Work goes where its trade does: a group is for its kind of work (a concrete deck is forms, rebar, the pour and the cure; a build-out is partitions, rough-in, ceilings, fixtures and finishes). If the piece was let go in a group that is not for its kind of work and one of the other groups for the same place is, it goes in that one: say so plainly, naming both. Never put work in a group for another trade, and never make up a reason why it could go there (light fixtures do not go after a concrete cure).',
  'Then decide where it belongs in that group: the task it should follow and the task that should wait for it. Think like a superintendent about trade order: what the work physically needs to be in place first, and what it must happen before (for example, light fixtures hang from the ceiling grid on the rough-in cabling, so they go after the grid and before the ceiling tiles close the ceiling).',
  'If it belongs in none of the groups offered, set fits to false, give the task it was let go after (else the group’s last task) as after_id and null as before_id, and say in the reason what kind of group it belongs in instead.',
  'If the piece was placed before on another group, place it the same way here unless this group differs; say so in the reason.',
  'Only use task ids from the groups given in after_id and before_id, both from the same group; in the reason, name tasks and groups by their names (never ids), in plain US English. Answer with JSON only.',
].join('\n');

/** A group and its tasks, in plan order, as the model reads them. */
function groupLines(group: PlacementGroup): string[] {
  return group.tasks.map(
    (task) =>
      `- id ${task.id}: ${task.name}${task.trade ? ` [${task.trade}]` : ''}${task.start ? `, ${task.start} to ${task.end ?? '?'}` : ''}${task.waits_for.length ? `, waits for ${task.waits_for.join(', ')}` : ''}`,
  );
}

/** The question for the model: the piece, the group in order, the other groups for the place, where it was let go, and any precedent. */
export function placementPrompt(request: PlacementRequest): string {
  const lines = [
    `The piece: "${request.snippet.name}"${request.snippet.summary ? ` (${request.snippet.summary})` : ''}.`,
    'Its tasks, in order:',
    ...request.snippet.tasks.map((task) => `- ${task.name}${task.trade ? ` [${task.trade}]` : ''}, ${task.days} working day${task.days === 1 ? '' : 's'}`),
    '',
    `It was let go in the group "${request.group.name}". Its tasks, in plan order:`,
    ...groupLines(request.group),
  ];
  for (const other of request.other_groups) {
    lines.push('', `Another group for the same place: "${other.name}". Its tasks, in plan order:`, ...groupLines(other));
  }
  lines.push('', request.dropped_after ? `The person let go just after task ${request.dropped_after}; that is only where the pointer was.` : 'The person let go somewhere in the group.');
  if (request.precedent) {
    lines.push(`On "${request.precedent.group}" the same piece went after "${request.precedent.after}"${request.precedent.before ? ` and before "${request.precedent.before}"` : ''}.`);
  }
  return lines.join('\n');
}

/** The model's answer, checked against the groups: ids must be theirs, and what waits must be in the same group. */
export function readAnswer(textAnswer: string, request: PlacementRequest): PlacementAnswer {
  let raw: Record<string, unknown>;
  try {
    raw = asObject(JSON.parse(textAnswer));
  } catch {
    throw new Error('The model did not answer with JSON.');
  }
  const groupOf = new Map<string, string>();
  for (const group of [request.group, ...request.other_groups]) for (const task of group.tasks) groupOf.set(task.id, group.id);
  const after = id(raw.after_id);
  const before = raw.before_id === null || raw.before_id === undefined ? null : id(raw.before_id);
  const reason = text(raw.reason, 280);
  if (!after || !groupOf.has(after)) throw new Error(`The model chose a task that is not in the group (${String(raw.after_id)}).`);
  if (before !== null && (!groupOf.has(before) || before === after || groupOf.get(before) !== groupOf.get(after))) {
    throw new Error(`The model chose a task to wait that is not in the group (${String(raw.before_id)}).`);
  }
  if (!reason) throw new Error('The model gave no reason.');
  return { after_id: after, before_id: before, reason, fits: raw.fits !== false, source: 'model' };
}

export function createPlacementHandler(deps: PlacementDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const cors = corsHeaders(request, deps.env);
    if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
    try {
      if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
      const token = bearerToken(request);
      const userId = token ? await deps.resolveUser(token) : null;
      if (!userId) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');
      let body: unknown;
      try {
        body = JSON.parse(await request.text()) as unknown;
      } catch {
        throw new HttpError(400, 'INVALID_REQUEST', 'The body must be JSON.');
      }
      const placement = readPlacementRequest(body);
      if (!(await deps.isMember(placement.project_id, userId))) throw new HttpError(403, 'FORBIDDEN', 'You are not a member of this project.');
      if (!deps.ask) throw new HttpError(503, 'MODEL_NOT_CONFIGURED', 'No model is configured (ANTHROPIC_API_KEY); place it by the rules.');
      let answer: PlacementAnswer;
      try {
        answer = readAnswer(await deps.ask({ system: PLACEMENT_SYSTEM, user: placementPrompt(placement), schema: PLACEMENT_SCHEMA }), placement);
      } catch (error) {
        deps.log('placement failed', error);
        throw new HttpError(502, 'MODEL_UNAVAILABLE', error instanceof Error ? error.message : 'The model did not answer.');
      }
      return json(200, answer, cors);
    } catch (error) {
      return errorResponse(error instanceof HttpError ? error : internalError(error, deps.log), cors);
    }
  };
}
