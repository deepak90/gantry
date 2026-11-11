/**
 * What simulated people say: their current intent ("chasing the riser inspections"), the notes they
 * write and the small wording tweaks they make to task names. A language model may write them (the
 * launcher asks Claude, grounded in the project's real task names, and hands the result to the page);
 * every suggestion is validated here and checked by the governor before it is used, and the canned
 * templates of each persona fill any gap. The page never holds an API key.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { z } from 'zod';
import { matchScore, taskWords } from './areas';
import type { Governor } from './governor';
import { ACTION_KINDS, type ActionKind, type Persona } from './personas';
import type { Random } from './random';

const intentSchema = z.object({
  text: z.string().min(4).max(120),
  taskIds: z.array(z.number().int()).max(10).default([]),
  kinds: z.array(z.enum(ACTION_KINDS)).max(6).default([]),
});

const personSuggestionsSchema = z.object({
  intents: z.array(intentSchema).max(10).default([]),
  notes: z.array(z.object({ taskId: z.number().int(), text: z.string().max(400) })).max(30).default([]),
  renames: z.array(z.object({ taskId: z.number().int(), name: z.string().max(200) })).max(20).default([]),
});

/** What the launcher returns: suggestions per crowd person id. */
export const suggestionsSchema = z.object({ people: z.record(z.string(), personSuggestionsSchema) });
export type Suggestions = z.infer<typeof suggestionsSchema>;

/** What the page sends the launcher to ground the suggestions. */
export interface SuggestionRequest {
  project: string;
  people: {
    id: string;
    name: string;
    title: string;
    cares: string;
    tasks: { id: number; name: string; phase: string; crew: string; progress: number }[];
  }[];
}

export interface Intent {
  /** Present tense, without the name: "chasing the riser inspections". */
  text: string;
  kinds: readonly ActionKind[];
  /** The tasks it is about. */
  focus: readonly number[];
  /** When the person moves on to something else. */
  until: number;
  source: 'llm' | 'canned';
}

interface PersonBook {
  intents: z.infer<typeof intentSchema>[];
  notes: Map<number, string[]>;
  renames: Map<number, string[]>;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

/** The crews on a task, by name. */
export function crewNames(task: TaskModel): string[] {
  const assignments = ((task as unknown as { assignments?: { resource?: { name?: string } | null }[] }).assignments ?? []) as { resource?: { name?: string } | null }[];
  return assignments.map((assignment) => assignment.resource?.name).filter((name): name is string => typeof name === 'string' && name.length > 0);
}

export function phaseName(task: TaskModel): string {
  return taskWords(task).parents.split(' / ')[0] ?? '';
}

export class ContentBook {
  private readonly books = new Map<string, PersonBook>();
  /** Notes already written on each task, so nobody writes the same one twice. */
  private readonly written = new Map<number, Set<string>>();
  readonly counts = { llmNotes: 0, llmRenames: 0, llmIntents: 0, cannedNotes: 0, cannedRenames: 0, cannedIntents: 0, rejected: 0 };

  constructor(
    private readonly governor: Governor,
    private readonly random: Random,
  ) {}

  /** Takes the launcher's suggestions; anything malformed, outside the person's tasks or failing the governor is dropped. */
  accept(raw: unknown, areas: ReadonlyMap<string, readonly number[]>, project: ProjectModel): { accepted: number; rejected: number } {
    const parsed = suggestionsSchema.safeParse(raw);
    if (!parsed.success) {
      this.counts.rejected++;
      return { accepted: 0, rejected: 1 };
    }
    let accepted = 0;
    let rejected = 0;
    for (const [personId, suggestions] of Object.entries(parsed.data.people)) {
      const area = new Set(areas.get(personId) ?? []);
      if (area.size === 0) continue;
      const book = this.book(personId);
      for (const intent of suggestions.intents) {
        const ids = intent.taskIds.filter((id) => area.has(id));
        if (/[<>{}]|https?:/.test(intent.text)) {
          rejected++;
          continue;
        }
        book.intents.push({ text: intent.text.replace(/\.$/, '').trim(), taskIds: ids, kinds: intent.kinds });
        accepted++;
      }
      for (const note of suggestions.notes) {
        const task = project.taskStore.getById(note.taskId) as TaskModel | undefined;
        if (!area.has(note.taskId) || !task || this.governor.vetNote(note.text)) {
          rejected++;
          continue;
        }
        book.notes.set(note.taskId, [...(book.notes.get(note.taskId) ?? []), note.text.trim()]);
        accepted++;
      }
      for (const rename of suggestions.renames) {
        const task = project.taskStore.getById(rename.taskId) as TaskModel | undefined;
        if (!area.has(rename.taskId) || !task || this.governor.vetRename(String(task.name ?? ''), rename.name)) {
          rejected++;
          continue;
        }
        book.renames.set(rename.taskId, [...(book.renames.get(rename.taskId) ?? []), rename.name.trim()]);
        accepted++;
      }
    }
    this.counts.rejected += rejected;
    return { accepted, rejected };
  }

  /** Something to do for the next few minutes, about tasks of their area. */
  intent(persona: Persona, area: readonly TaskModel[], now: number): Intent {
    const book = this.book(persona.person.id);
    const until = now + this.random.range(90_000, 210_000);
    const llm = book.intents.length > 0 && this.random.chance(0.7) ? this.random.pick(book.intents) : undefined;
    if (llm) {
      const focus = llm.taskIds.length ? llm.taskIds : this.focusFor(area, []);
      this.counts.llmIntents++;
      return { text: llm.text, kinds: llm.kinds.length ? llm.kinds : ['note', 'progress'], focus, until, source: 'llm' };
    }
    // Intents whose words match something in the area first.
    const fitting = persona.intents.filter((intent) => intent.keywords.length === 0 || area.some((task) => matchScore(task, intent.keywords) > 0));
    const canned = this.random.pick(fitting.length ? fitting : persona.intents)!;
    this.counts.cannedIntents++;
    return { text: canned.text, kinds: canned.kinds, focus: this.focusFor(area, canned.keywords), until, source: 'canned' };
  }

  private focusFor(area: readonly TaskModel[], keywords: readonly string[]): number[] {
    const matching = keywords.length ? area.filter((task) => matchScore(task, keywords) > 0) : [];
    const pool = matching.length ? matching : this.random.shuffle(area).slice(0, 6);
    return pool.map((task) => task.id).filter((id): id is number => typeof id === 'number');
  }

  /** A note this person would write on `task` (different from the one there). */
  note(persona: Persona, task: TaskModel): string | null {
    const id = task.id as number;
    const current = String((task as unknown as { note?: string }).note ?? '').trim();
    const written = this.written.get(id) ?? new Set<string>();
    const fresh = (text: string) => text !== current && !written.has(text);
    const remember = (text: string) => {
      this.written.set(id, written.add(text));
      return text;
    };
    const suggested = (this.book(persona.person.id).notes.get(id) ?? []).filter(fresh);
    if (suggested.length && this.random.chance(0.85)) {
      this.counts.llmNotes++;
      return remember(this.random.pick(suggested)!);
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      const text = this.fill(this.random.pick(persona.notes) ?? '', task);
      if (text && fresh(text) && !this.governor.vetNote(text)) {
        this.counts.cannedNotes++;
        return remember(text);
      }
    }
    return null;
  }

  /** A small wording tweak of `task`'s name that keeps its meaning, or null. */
  rename(persona: Persona, task: TaskModel): string | null {
    const name = String(task.name ?? '');
    const suggested = (this.book(persona.person.id).renames.get(task.id as number) ?? []).filter((text) => text !== name && !this.governor.vetRename(name, text));
    if (suggested.length && this.random.chance(0.85)) {
      this.counts.llmRenames++;
      return this.random.pick(suggested)!;
    }
    const candidates: string[] = [];
    if (name.includes(' & ')) candidates.push(name.replace(' & ', ' and '));
    else if (/ and /.test(name)) candidates.push(name.replace(' and ', ' & '));
    const lower = name.toLowerCase();
    if (!/[(–]/.test(name)) {
      for (const [qualifier, words] of persona.qualifiers) if (words.length === 0 || words.some((word) => lower.includes(word))) candidates.push(`${name} ${qualifier}`);
    }
    const fine = candidates.filter((text) => !this.governor.vetRename(name, text));
    const chosen = this.random.pick(fine);
    if (chosen) this.counts.cannedRenames++;
    return chosen ?? null;
  }

  private fill(template: string, task: TaskModel): string {
    const crews = crewNames(task);
    const first = this.random.int(0, WEEKDAYS.length - 2);
    return template
      .replaceAll('{task}', String(task.name ?? 'this task'))
      .replaceAll('{crew}', crews[0] ?? 'the crew')
      .replaceAll('{day}', WEEKDAYS[first]!)
      .replaceAll('{day2}', WEEKDAYS[this.random.int(first + 1, WEEKDAYS.length - 1)]!);
  }

  private book(personId: string): PersonBook {
    let book = this.books.get(personId);
    if (!book) {
      book = { intents: [], notes: new Map(), renames: new Map() };
      this.books.set(personId, book);
    }
    return book;
  }
}

/** The request the launcher turns into a prompt: who works here and on which tasks. */
export function suggestionRequest(projectName: string, people: readonly { persona: Persona; tasks: readonly TaskModel[] }[]): SuggestionRequest {
  return {
    project: projectName,
    people: people.map(({ persona, tasks }) => ({
      id: persona.person.id,
      name: persona.person.name,
      title: persona.person.title,
      cares: persona.cares,
      tasks: tasks.slice(0, 40).map((task) => ({
        id: task.id as number,
        name: String(task.name ?? ''),
        phase: phaseName(task),
        crew: crewNames(task).join(', '),
        progress: Math.round(Number(task.percentDone) || 0),
      })),
    })),
  };
}
