/**
 * The crowd page (crowd.html), opened by `pnpm crowd` in a headless browser: signs the simulated
 * people in, runs them, and shows a small status board (who is connected, what they are doing, their
 * last change, the governor's drift ledger). The launcher hands over the project and the people's
 * credentials through page functions, and answers suggestion requests with its language model; this
 * page never holds an API key.
 */
import { readSupabaseConfig } from '../supabase/client';
import { listProjects, opensAsDemo } from '../supabase/project';
import { bookedTasks, bootPerson, type BootedPerson, type Credentials } from './boot';
import type { SuggestionRequest } from './content';
import { Crowd, type CrowdStatus } from './crowd';
import type { CrewValue, DriftEntry, DriftValue, StartValue } from './governor';
import { personaFor } from './personas';
import { viewerColumns } from './screen';

interface CrowdPageConfig {
  /** null: the first project the first person can see. */
  projectId: string | null;
  people: Credentials[];
  /** Whether the launcher can write suggestions with a language model. */
  llm: boolean;
  /** How often fresh suggestions are asked for. */
  llmEveryMs?: number;
  seed?: number;
  /** What the crowd had out of place when this page last ran (the launcher keeps it). */
  ledger?: DriftEntry[];
  /** They only look: nobody changes anything, nothing is brought back (`--look-only`). */
  lookOnly?: boolean;
  /** One part of the plan per person, in order (`--areas`): a summary task's name or WBS code. */
  branches?: string[];
  /** Time between one person's changes (`--every`). */
  cadenceMs?: { min: number; max: number };
}

/** The grid columns a viewer opening the project has (listed projects hide some), for the people's screens. */
async function columnsFor(person: BootedPerson, projectId: string): Promise<string[]> {
  const listed = await listProjects(person.client).then(
    (list) => list.some((entry) => entry.id === projectId && opensAsDemo(entry)),
    () => false,
  );
  const root = person.ready.project.taskStore.rootNode as unknown as { children?: unknown };
  const tops = Array.isArray(root.children) ? (root.children as { name?: unknown }[]) : [];
  return viewerColumns(listed, tops.map((task) => String(task.name ?? '')));
}

interface CrowdControl {
  status(): CrowdStatus | null;
  summary(): string;
  windDown(timeoutMs?: number): Promise<string[]>;
}

declare global {
  interface Window {
    crowdConfig?: () => Promise<CrowdPageConfig>;
    crowdSuggest?: (request: SuggestionRequest) => Promise<unknown>;
    crowdLog?: (line: string) => Promise<void>;
    /** Asks the launcher to create the people and their membership again (the database was reset). */
    crowdEnsure?: () => Promise<void>;
    /** Hands the drift ledger to the launcher after every change. */
    crowdLedger?: (entries: DriftEntry[]) => Promise<void>;
    crowd?: CrowdControl;
  }
}

const root = document.getElementById('crowd')!;
const booted = new Map<string, BootedPerson>();
const failures = new Map<string, string>();
let crowd: Crowd | null = null;
let note = 'Starting…';

const escape = (text: unknown) => String(text ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
const ago = (at: number | null) => (at === null ? '' : `${Math.max(0, Math.round((Date.now() - at) / 1000))} s ago`);
const day = (ms: number | null) => (ms === null ? '—' : new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));

function valueText(field: DriftEntry['field'], value: DriftValue): string {
  if (value === null || value === undefined) return '—';
  if (field === 'start') return day((value as StartValue).start);
  if (field === 'crew') return (value as CrewValue).resourceName;
  if (field === 'progress') return `${Math.round(Number(value))}%`;
  if (field === 'duration') return `${String(value)} d`;
  const text = String(value);
  return text ? (text.length > 48 ? `${text.slice(0, 47)}…` : text) : '(empty)';
}

function line(text: string): void {
  console.log(text);
  void window.crowdLog?.(text);
}

function render(): void {
  const status = crowd?.status() ?? null;
  const people = status?.people ?? [];
  const rows = people
    .map(
      (person) => `<tr>
        <td><span class="dot" style="background:${escape(person.color)}"></span>${escape(person.name)}</td>
        <td>${escape(person.state)}<br><small>${escape(person.connection)} · ${escape(person.sync)}${person.followers ? ` · ${person.followers} following` : ''}</small></td>
        <td>${escape(person.intent ?? '')}${person.intentSource ? ` <small>(${person.intentSource})</small>` : ''}<br><small>${person.area} tasks</small></td>
        <td>${escape(person.last ?? '')}<br><small>${ago(person.lastAt)}</small></td>
        <td class="num">${person.changes} / ${person.restores} / ${person.vetoes}</td>
        <td class="num">${person.pointerUpdates}</td>
        <td>${person.errors ? `${person.errors}: ${escape(person.lastError)}` : ''}</td>
      </tr>`,
    )
    .join('');
  const failed = [...failures].map(([id, message]) => `<tr><td colspan="7" class="err">${escape(personaFor(id)?.person.name ?? id)}: ${escape(message)}</td></tr>`).join('');
  const ledger = (status?.ledger ?? [])
    .map(
      (entry) => `<tr>
        <td>${escape(entry.taskName)}</td><td>${escape(entry.field)}</td>
        <td>${escape(valueText(entry.field, entry.seed))} → ${escape(valueText(entry.field, entry.current))}</td>
        <td>${escape(entry.byName)}</td>
        <td class="num">${entry.dueIn > 0 ? `in ${Math.round(entry.dueIn / 1000)} s` : `due ${Math.round(-entry.dueIn / 1000)} s`}</td>
      </tr>`,
    )
    .join('');
  const log = (status?.log ?? [])
    .slice(0, 30)
    .map((entry) => `<li><span class="dot" style="background:${escape(entry.color)}"></span><small>${new Date(entry.at).toLocaleTimeString('en-US')}</small> ${escape(entry.who)}: ${escape(entry.text)}</li>`)
    .join('');
  const governor = status?.governor;
  const handover = status?.handover;
  root.innerHTML = `
    <h1>Crowd <small>${escape(note)}</small></h1>
    <table data-testid="crowd-people">
      <thead><tr><th>Person</th><th>State</th><th>Doing</th><th>Last change</th><th class="num">Made / back / refused</th><th class="num">Pointer</th><th>Errors</th></tr></thead>
      <tbody>${rows}${failed}</tbody>
    </table>
    <h2>Governor ${governor ? `<small>${governor.applied} changes, ${governor.restored} brought back, ${governor.vetoed} refused · handover ${day(handover?.baseline ?? null)} → ${day(handover?.now ?? null)}</small>` : ''}</h2>
    <table data-testid="crowd-ledger">
      <thead><tr><th>Out of place</th><th>Field</th><th>Seed → now</th><th>By</th><th class="num">Back</th></tr></thead>
      <tbody>${ledger || '<tr><td colspan="5"><small>Nothing out of place.</small></td></tr>'}</tbody>
    </table>
    <h2>Log</h2><ul class="log">${log}</ul>`;
}

const startedAt = Date.now();

function summary(): string {
  const status = crowd?.status();
  if (!status) return note;
  const pointer = status.people.reduce((sum, person) => sum + person.pointerUpdates, 0) / Math.max(1, (Date.now() - startedAt) / 1000);
  const people = status.people.map((person) => `${person.name.split(' ')[0]} ${person.changes}/${person.restores}/${person.vetoes} ${person.state}${person.errors ? ` (${person.errors} errors)` : ''}`).join(', ');
  return `${note} · ${people} · ledger ${status.ledger.length} · governor ${status.governor.applied} made, ${status.governor.restored} back, ${status.governor.vetoed} refused · pointers ${pointer.toFixed(1)}/s`;
}

async function main(): Promise<void> {
  window.crowd = {
    status: () => crowd?.status() ?? null,
    summary,
    async windDown(timeoutMs = 30_000) {
      note = 'Winding down: bringing everything back…';
      const left = crowd ? await crowd.windDown(timeoutMs) : [];
      for (const person of booted.values()) person.dispose();
      booted.clear();
      note = 'Stopped.';
      render();
      return left.map((entry) => `${entry.taskName} (${entry.field}): ${valueText(entry.field, entry.seed)} → ${valueText(entry.field, entry.current)}`);
    },
  };
  setInterval(render, 1_000);
  if (!window.crowdConfig) {
    note = 'Start the crowd with `pnpm crowd`: it opens this page with the project and the people.';
    render();
    return;
  }
  const config = await window.crowdConfig();
  const supabase = readSupabaseConfig();
  let projectId = config.projectId;
  note = `Signing in ${config.people.length} people…`;
  render();
  for (const credentials of config.people) {
    const persona = personaFor(credentials.id);
    if (!persona) continue;
    try {
      const person = await bootPerson(supabase, projectId, credentials, persona);
      projectId ??= person.ready.projectId;
      booted.set(credentials.id, person);
      line(`[crowd] ${persona.firstName} signed in (${person.parts.displayName})`);
    } catch (error) {
      failures.set(credentials.id, error instanceof Error ? error.message : String(error));
      line(`[crowd] ${persona.firstName} could not start: ${failures.get(credentials.id)}`);
    }
  }
  const first = booted.values().next().value as BootedPerson | undefined;
  if (!first || !projectId) {
    note = 'Nobody could start.';
    render();
    return;
  }
  const project = projectId;
  let offLimits = await bookedTasks(first.client, project).catch(() => new Set<number>());
  setInterval(() => {
    void bookedTasks(first.client, project)
      .then((ids) => {
        offLimits = ids;
      })
      .catch(() => undefined);
  }, 60_000);
  const load = first.ready.load;
  const lookOnly = config.lookOnly === true;
  // Look-only (the film): their screens have the columns a viewer has, so a pointer never lands in one the
  // viewer does not show (it would be drawn at the edge of their grid).
  const screenColumns = lookOnly ? await columnsFor(first, project) : undefined;
  crowd = new Crowd({
    projectName: load.project.name,
    // bigint ids travel as strings.
    handoverTaskId: load.project.handover_task_id === null ? null : Number(load.project.handover_task_id),
    offLimits: () => offLimits,
    seed: config.seed,
    suggest: !lookOnly && config.llm && window.crowdSuggest ? (request) => window.crowdSuggest!(request) : undefined,
    suggestEveryMs: config.llmEveryMs,
    // Look-only: an earlier run's ledger is neither acted on nor handed back (the launcher keeps its copy).
    ledgerEntries: lookOnly ? [] : (config.ledger ?? []),
    ledger: lookOnly ? undefined : { onChange: (entries) => void window.crowdLedger?.(entries) },
    lookOnly,
    screenColumns,
    branches: config.branches,
    cadenceMs: config.cadenceMs,
    onLog: line,
  });
  for (const person of booted.values()) crowd.add(person.parts);
  crowd.start();
  note = lookOnly ? `${booted.size} people looking around ${load.project.name} (look-only: no changes; columns ${screenColumns!.join(', ')})` : `${booted.size} people at work in ${load.project.name}`;
  line(`[crowd] ${note}`);

  // A refused submission is retried a few times; a person whose copy is out of sync for good (or who
  // keeps failing, e.g. after a database reset) signs in again on a fresh session.
  const strikes = new Map<string, number>();
  const rebuilding = new Set<string>();
  setInterval(() => {
    for (const person of crowd?.people ?? []) {
      if (rebuilding.has(person.id)) continue;
      const entry = booted.get(person.id);
      const sync = entry?.parts.sync.state;
      if (entry && sync?.status !== 'error') {
        strikes.delete(person.id);
        continue;
      }
      const count = (strikes.get(person.id) ?? 0) + 1;
      strikes.set(person.id, count);
      if (entry && sync?.recovery === 'retry' && count < 3) {
        entry.parts.sync.retry();
        continue;
      }
      const credentials = config.people.find((candidate) => candidate.id === person.id)!;
      rebuilding.add(person.id);
      booted.delete(person.id);
      person.stop();
      entry?.dispose();
      line(`[crowd] ${person.persona.firstName} lost the project (${sync?.error ?? 'session gone'}); signing in again`);
      void (async () => {
        try {
          const fresh = await bootPerson(supabase, project, credentials, person.persona).catch(async () => {
            await window.crowdEnsure?.();
            return bootPerson(supabase, project, credentials, person.persona);
          });
          booted.set(person.id, fresh);
          strikes.delete(person.id);
          failures.delete(person.id);
          crowd?.replace(person.id, fresh.parts);
        } catch (error) {
          failures.set(person.id, error instanceof Error ? error.message : String(error));
        } finally {
          rebuilding.delete(person.id);
        }
      })();
    }
  }, 15_000);
}

void main().catch((error: unknown) => {
  note = `Failed: ${error instanceof Error ? error.message : String(error)}`;
  line(`[crowd] ${note}`);
  render();
});
