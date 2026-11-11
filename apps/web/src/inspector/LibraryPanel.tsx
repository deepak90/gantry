/**
 * The library tab: the team's pieces of plan (nested tasks with their links, crews and time ranges),
 * filed in folders and numbered like an outline, to drag into the live plan. The main way in is
 * saving work from the plan: select tasks, right-click, "Save to library…", and a short form here
 * names and files them. Each card can be tweaked before the drop (name, how many, how long), opened
 * in the builder, copied, renamed, moved or deleted; folders nest.
 *
 * Dropping a card on a row (or "Add after" the selected task) opens a card at that spot asking how
 * to tie the work in, with what each way would do worked out on a copy of the plan (what moves, the
 * handover date), and who does it when the library names a trade several firms cover. A drop is one
 * change for everyone (one revision): the new rows slide in, moved bars leave a "was here" outline for
 * a few seconds, the panel says what moved and offers Undo, and the assistant is told where the
 * piece landed so it can offer it in similar places. A dropped piece is a copy: changing the library
 * later never changes the plan.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Gantt, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import {
  LINK_TYPE_WORDS,
  MAX_REPEATS,
  SCALE_CHOICES,
  checkSnippet,
  crewNamesOf,
  defaultTweaks,
  leavesOf,
  outlineNumbers,
  planSnippet,
  scheduleSnippet,
  type LibraryOrigin,
  type SnippetDraft,
  type SnippetPlan,
  type SnippetTask,
  type SnippetTweaks,
  type PlacementPrecedent,
  type PlacementSuggestion,
} from '@collab/shared';
import { crewColor } from '../gantt/look';
import { describeEffect, describePlace, formatDay } from '../library/describe';
import { attachSnippetDrag, flashRows, markRows, type DropPoint } from '../library/drag';
import { snippetFromTasks } from '../library/from-plan';
import {
  DROP_MODES,
  crewMatcher,
  crewQuestions,
  dropSnippet,
  placementFor,
  previewDrop,
  undoDrop,
  type CrewChoices,
  type DropMode,
  type DropPreview,
  type InsertResult,
  type Placement, lastFinishing } from '../library/insert';
import { emptyDraft } from '../library/outline';
import { groupOfPlacement, groupTasks, isPlacedIn, placeInGroup, precedentFor, rememberPlacement, type AskPlacement } from '../library/placement';
import { movedSince, showWasHere, spansOf } from '../library/was-here';
import { SnippetBuilder, builderCrews, folderOptions, type BuilderCrew } from '../library/SnippetBuilder';
import { SnippetMiniTimeline } from '../library/SnippetTimeline';
import { folderPath, libraryTree, matchesLibrarySearch, type LibraryEntry, type LibraryFolderNode, type LibraryStore } from '../library/store';
import { whenSaved } from '../scenario/publish';
import { useLibrarySnapshot } from '../library/useLibrary';
import { useProjectDataVersion } from '../gantt/useProjectDataVersion';
import { InspectorHeader } from './Inspector';
import { RemyMark } from '../assistant/RemyMark';
import '../styles/library.css';
import { ASSISTANT_NAME } from '../assistant/identity';

/**
 * What Remy's cursor reaches in the library panel while it is open (assistant/remy-ui.ts): the same steps a person
 * takes. A card opened shows what is in the piece; a piece let go over a row opens the card that asks how to tie it in,
 * exactly as after a person's drag, and the person picks and applies. Nothing here adds anything to the plan.
 */
export interface LibraryHands {
  /** Opens a piece's card (its folders opened, brought into view); null when the library has no such piece. */
  openCard(snippetId: string): HTMLElement | null;
  /** The card's handle, where a drag starts. */
  grabOf(snippetId: string): HTMLElement | null;
  /** The name of the piece whose card is open. */
  openName(): string | null;
  /** Lets go of a piece over a task's row: the card that asks how to tie it in opens at `at`. False when it can't. */
  dropOn(snippetId: string, taskId: number, zone: 'after' | 'inside', at: { x: number; y: number }): boolean;
  /** The piece the drop card is asking about, when it is open. */
  dropCard(): string | null;
  closeDropCard(): boolean;
  /** Closes the open card. */
  closeCard(): boolean;
}

/** The library panel's hands while it is open (null otherwise). */
export const libraryHands: { current: LibraryHands | null } = { current: null };

/** Where a piece landed, for the assistant (sent once the server has given the new tasks their ids). */
export interface LibraryDropDetail {
  snippet_id: string;
  name: string;
  top_ids: number[];
  anchor_id: number | null;
  parent_id: number | null;
  mode: DropMode;
}

export interface LibraryPanelProps {
  project: ProjectModel;
  /** The live Gantt (cards are dropped onto it); undefined until it is drawn. */
  gantt(): Gantt | undefined;
  /** The task selected in the plan: "Add after it" is the keyboard way to drop. */
  selectedTaskId?: number | null;
  /** Every task selected in the plan: they can be saved to the library together. */
  selectedTaskIds?: readonly number[];
  library: LibraryStore | null;
  /** "Save to library…" from the plan's task menu: opens the save form on those tasks (`nonce` changes per request). */
  saveRequest?: { taskIds: readonly number[]; nonce: number } | null;
  /** Asks the assistant (and shows its tab). Without it, the assistant buttons are hidden. */
  onAsk?(text: string): void;
  /** A piece landed in the plan. */
  onDropped?(detail: LibraryDropDetail): void;
  /** Asks the assistant where a dropped piece belongs in its group (place-snippet); without it, the rules decide. */
  askPlacement?: AskPlacement | null;
}

interface DropNote {
  title: string;
  where: string;
  mode: DropMode;
  unknownCrews: string[];
  /** Work already in the plan that moved (or, once undone, moved back). */
  moved: { id: number; name: string; days: number }[];
  plan: SnippetPlan;
  result: InsertResult;
  undone?: boolean;
  /** Placed where the assistant (or its rules) said: why it went there. */
  placed?: { reason: string; source: PlacementSuggestion['source']; auto: boolean };
}

/** Where the assistant thinks the piece fits in the group it was dropped into. */
type SuggestionState = { status: 'asking' } | { status: 'ready'; group: TaskModel; value: PlacementSuggestion } | { status: 'none' };

/** The card that asks how to tie a dropped piece in. */
interface DropChoiceState {
  placement: Placement;
  plan: SnippetPlan;
  x: number;
  y: number;
  release(): void;
  /** What "push", "fit" and the assistant's place would do, as each is worked out. */
  previews: Partial<Record<DropMode | 'suggested', DropPreview>>;
  token: number;
  suggestion: SuggestionState;
  /** The piece went into another group before: it is placed the same way here, without asking. */
  auto: PlacementPrecedent | null;
}

/** The short form for saving work picked in the plan. */
interface SaveFormState {
  draft: SnippetDraft;
  folderId: string | null;
  picked: number;
}

interface BuilderState {
  draft: SnippetDraft;
  title: string;
  folderId: string | null;
  id?: string;
  origin: LibraryOrigin;
}

type Menu = { kind: 'snippet' | 'folder'; id: string; confirmDelete?: boolean; moving?: boolean } | { kind: 'new' } | null;

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Resolves once the server has given every task its real (numeric) id, or after ten seconds. */
async function whenNumbered(tasks: readonly TaskModel[]): Promise<void> {
  for (let attempt = 0; attempt < 40 && tasks.some((task) => typeof task.id !== 'number'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The name of the group a drop goes into (a floor, a work package), or null at the top of the plan. */
function placementGroupName(placement: Placement): string | null {
  const parent = placement.kind === 'after' ? ((placement.anchor as unknown as { parent?: TaskModel & { isRoot?: boolean } }).parent ?? null) : placement.parent;
  return parent && !(parent as { isRoot?: boolean }).isRoot && groupTasks(parent).length > 0 ? (parent.name ?? null) : null;
}

/** How many copies a drop makes (a plain run of tasks is one piece, however many rows it has). */
const copyCount = (plan: SnippetPlan) => (plan.flat ? 1 : plan.copies.length);

const COLLAPSED_KEY = (projectId: string) => `library-collapsed:${projectId}`;

function readCollapsed(projectId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY(projectId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(projectId: string, collapsed: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY(projectId), JSON.stringify([...collapsed]));
  } catch {
    // A private window or blocked storage: folders simply open expanded next time.
  }
}

export function LibraryPanel({ project, gantt, selectedTaskId = null, selectedTaskIds = [], library, saveRequest = null, onAsk, onDropped, askPlacement = null }: LibraryPanelProps) {
  const snapshot = useLibrarySnapshot(library);
  const [tweaks, setTweaks] = useState<Record<string, SnippetTweaks>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<DropNote | null>(null);
  const [choice, setChoice] = useState<DropChoiceState | null>(null);
  const [saveForm, setSaveForm] = useState<SaveFormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<Menu>(null);
  const [renaming, setRenaming] = useState<{ kind: 'snippet' | 'folder'; id: string } | null>(null);
  const [builder, setBuilder] = useState<BuilderState | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => (library ? readCollapsed(library.projectId) : new Set()));
  const containerRef = useRef<HTMLDivElement>(null);
  // The parent passes a new getter on every render; the drag source is attached once.
  const ganttRef = useRef(gantt);
  ganttRef.current = gantt;
  const choiceRef = useRef(choice);
  choiceRef.current = choice;
  const choiceToken = useRef(0);

  const entries = snapshot.entries;
  const tweaksOf = (entry: LibraryEntry) => tweaks[entry.id] ?? defaultTweaks(entry.snippet);
  const plans = useMemo(() => new Map(entries.map((entry) => [entry.id, planSnippet(entry.snippet, tweaks[entry.id] ?? defaultTweaks(entry.snippet))])), [entries, tweaks]);
  const matchCrew = crewMatcher(project);
  const colorOfCrew = (name: string) => {
    const crew = matchCrew(name);
    return crew ? crewColor(crew) : undefined;
  };
  const projectCrews: BuilderCrew[] = builderCrews(project);

  // Drag callbacks read the latest choices through this ref (the DragHelper is created once).
  const latest = useRef({ plans, busy, onDropped, library, askPlacement });
  latest.current = { plans, busy, onDropped, library, askPlacement };

  /** Resolves once the last drop has been saved (see `drop`), which takes the server a moment. */
  const whenIdle = async () => {
    while (latest.current.busy) await new Promise((resolve) => setTimeout(resolve, 100));
  };

  /** Asks how to tie the piece in, at the spot it was let go, and works out what each way would move. */
  const openChoice = (dropped: Placement, plan: SnippetPlan, at: DropPoint) => {
    choiceRef.current?.release();
    // A plain run of tasks let go on a group's row belongs inside that group.
    const placement: Placement = plan.flat && dropped.kind === 'after' && !dropped.anchor.isLeaf ? { kind: 'inside', parent: dropped.anchor, anchor: lastFinishing(dropped.anchor) } : dropped;
    const token = ++choiceToken.current;
    setError(null);
    const show = () => {
      const projectId = latest.current.library?.projectId ?? null;
      const remembered = projectId ? precedentFor(projectId, plan.snippet.id) : null;
      // It only sets the example while it is still there: after an Undo or a reset the person is asked again.
      const precedent = remembered && isPlacedIn(project, plan.snippet.id, remembered.group) ? remembered : null;
      const into = placementGroupName(placement);
      // Placed before on another group (the next floor): it goes the same way, and the person is not asked.
      const auto = precedent && into && precedent.group !== into ? precedent : null;
      const previewInto = (key: DropMode | 'suggested', preview: DropPreview) => setChoice((current) => (current && current.token === token ? { ...current, previews: { ...current.previews, [key]: preview } } : current));
      setChoice({ placement, plan, x: at.x, y: at.y, release: at.release, previews: {}, token, suggestion: { status: 'asking' }, auto });
      void (async () => {
        const found = projectId ? await placeInGroup(latest.current.askPlacement, projectId, plan, placement, precedent) : null;
        if (choiceToken.current !== token) return;
        const suggestion: SuggestionState = found ? { status: 'ready', group: found.group, value: found.suggestion } : { status: 'none' };
        setChoice((current) => (current && current.token === token ? { ...current, suggestion } : current));
        // The state above lands on the next render: hand the answer over directly. Not when the assistant
        // says it fits nowhere here: the person sees why and decides.
        if (auto && found && found.suggestion.fits !== false) {
          chooseSuggestedRef.current(new Map(), { status: 'ready', group: found.group, value: found.suggestion });
          return;
        }
        const anchor = found ? (project.taskStore.getById(found.suggestion.afterId) as TaskModel | undefined) : undefined;
        if (!anchor || !found) return;
        const preview = await previewDrop(project, placementFor(anchor, 'after'), plan, found.suggestion.mode ?? 'push');
        if (choiceToken.current === token) previewInto('suggested', preview);
      })();
      void (async () => {
        for (const mode of ['push', 'fit'] as const) {
          const preview = await previewDrop(project, placement, plan, mode);
          if (choiceToken.current !== token) return;
          previewInto(mode, preview);
        }
      })();
    };
    if (!latest.current.busy) {
      show();
      return;
    }
    // The last drop is still being saved (see `drop`): the card opens as soon as it is. The row keeps its mark.
    setChoice(null);
    void whenIdle().then(() => {
      if (choiceToken.current === token) show();
      else at.release();
    });
  };
  const openChoiceRef = useRef(openChoice);
  openChoiceRef.current = openChoice;

  const closeChoice = () => {
    choiceRef.current?.release();
    choiceToken.current++;
    setChoice(null);
  };

  const choose = (mode: DropMode, crews: CrewChoices) => {
    const current = choiceRef.current;
    if (!current) return;
    closeChoice();
    void drop(current.placement, current.plan, mode, crews, current.previews[mode]);
  };

  /** Puts the piece where the assistant said (pushing what waited there, or alongside), and remembers it for the next group. */
  const chooseSuggested = (crews: CrewChoices, ready?: Extract<SuggestionState, { status: 'ready' }>) => {
    const current = choiceRef.current;
    const suggestion = ready ?? current?.suggestion;
    if (!current || !suggestion || suggestion.status !== 'ready') return;
    const { group, value } = suggestion;
    const anchor = project.taskStore.getById(value.afterId) as TaskModel | undefined;
    if (!anchor) {
      closeChoice();
      setError(`Not added: someone has just removed the task ${ASSISTANT_NAME} picked. Drop it again to find a new place.`);
      return;
    }
    const before = value.beforeId === null ? null : (project.taskStore.getById(value.beforeId) as TaskModel | undefined);
    const projectId = latest.current.library?.projectId;
    if (projectId) rememberPlacement(projectId, current.plan.snippet.id, { group: group.name ?? '', after: anchor.name ?? '', before: before?.name ?? null, ...(value.mode ? { mode: value.mode } : {}) });
    closeChoice();
    void drop(placementFor(anchor, 'after'), current.plan, value.mode ?? 'push', crews, current.previews.suggested, { reason: value.reason, source: value.source, auto: Boolean(current.auto) });
  };
  const chooseSuggestedRef = useRef(chooseSuggested);
  chooseSuggestedRef.current = chooseSuggested;

  const drop = async (placement: Placement, plan: SnippetPlan, mode: DropMode, crews?: CrewChoices, preview?: DropPreview, placed?: DropNote['placed']) => {
    await whenIdle();
    setBusy(true);
    setError(null);
    try {
      const before = spansOf(project);
      const where = describePlace(placement);
      const anchor = placement.kind === 'first' ? null : placement.anchor;
      const parent = placement.kind === 'after' ? (placement.anchor.parent as TaskModel | null) : placement.parent;
      // The outlines go up before the drop, so the moved bars are drawn sliding away from them.
      const instance = ganttRef.current();
      const expected = (preview?.moved ?? []).flatMap((task) => {
        const was = before.get(task.id);
        return was ? [{ id: task.id, was }] : [];
      });
      if (instance && expected.length > 0) showWasHere(instance, expected, 6000, false);
      const result = await dropSnippet(project, placement, plan, mode, crews);
      const moved = movedSince(project, before);
      if (instance && moved.map((task) => task.id).join() !== expected.map((task) => task.id).join()) showWasHere(instance, moved);
      const count = copyCount(plan);
      setNote({
        title: count > 1 ? `${plan.tweaks.name} × ${count} ${plan.snippet.unit.many}` : plan.tweaks.name,
        where,
        mode,
        unknownCrews: result.unknownCrews,
        moved: moved.map(({ was: _was, ...task }) => task),
        plan,
        result,
        ...(placed ? { placed } : {}),
      });
      void showRows(result.tops, result.created);
      // The next drop waits until the server has numbered these tasks: two unconfirmed inserts into one
      // group can come back in a different order on another client.
      await whenNumbered(result.tops);
      // The panel is free again now; the assistant hears once the plan it will read has this in it.
      void whenSaved(project).then(() => tellAssistant(plan, result.tops, anchor, parent, mode));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  /** Takes the last drop back out (one change for everyone, like the drop). */
  const undo = async (current: DropNote) => {
    if (latest.current.busy) return;
    setBusy(true);
    setError(null);
    try {
      const before = spansOf(project);
      await undoDrop(project, current.plan, current.result);
      const moved = movedSince(project, before);
      const instance = ganttRef.current();
      if (instance && moved.length > 0) showWasHere(instance, moved);
      setNote({ ...current, undone: true, moved: moved.map(({ was: _was, ...task }) => task) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  /** Tells the assistant where the piece landed (once the server has numbered the new tasks). */
  const tellAssistant = async (plan: SnippetPlan, tops: readonly TaskModel[], anchor: TaskModel | null, parent: TaskModel | null, mode: DropMode) => {
    const notify = latest.current.onDropped;
    if (!notify) return;
    const ids = tops.map((top) => top.id).filter((id): id is number => typeof id === 'number');
    if (ids.length === 0) return;
    const numeric = (task: TaskModel | null) => (task && typeof task.id === 'number' && !(task as TaskModel & { isRoot?: boolean }).isRoot ? task.id : null);
    notify({ snippet_id: plan.snippet.id, name: plan.tweaks.name, top_ids: ids, anchor_id: numeric(anchor), parent_id: numeric(parent), mode });
  };

  const showRows = async (tops: readonly TaskModel[], created: readonly TaskModel[]) => {
    const instance = ganttRef.current();
    const first = tops[0];
    if (!instance || instance.isDestroyed || !first) return;
    // The row the plan shows: a copy while grouped, and none while a search or a filter hides it.
    const store = instance.store as unknown as { getById(id: unknown): TaskModel | undefined; indexOf(record: unknown): number };
    const shown = store.getById(first.id);
    if (!shown) return;
    try {
      // A closed group hides the row as well, and that one can be opened.
      await instance.expandTo(shown as never, false);
      if (store.indexOf(shown) < 0) return;
      await instance.scrollTaskIntoView(shown, { block: 'center', highlight: true, animate: true } as never);
      flashRows(instance, created);
    } catch (reason) {
      console.error('Could not show the new rows', reason);
    }
  };

  // Attach the drag source once the Gantt exists (it is drawn before or soon after this panel).
  useEffect(() => {
    let detach: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attach = (attempt: number) => {
      const instance = ganttRef.current();
      const container = containerRef.current;
      if (!instance || !container) {
        if (attempt < 40) timer = setTimeout(() => attach(attempt + 1), 250);
        return;
      }
      detach = attachSnippetDrag({
        gantt: instance,
        container,
        cardFor: (id) => {
          const plan = latest.current.plans.get(id);
          if (!plan) return null;
          return {
            name: copyCount(plan) > 1 ? `${plan.tweaks.name} × ${copyCount(plan)}` : plan.tweaks.name,
            icon: plan.snippet.icon,
            detail: `${plural(leavesOf(plan.snippet.children).length * copyCount(plan), 'task')} · ${plural(plan.span, 'working day')}`,
          };
        },
        onDrop: (placement, id, at) => {
          const plan = latest.current.plans.get(id);
          if (plan) openChoiceRef.current(placement, plan, at);
          else at.release();
        },
        onFile: (id, folderId) => {
          void latest.current.library?.moveSnippet(id, folderId).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
        },
      });
    };
    attach(0);
    return () => {
      if (timer) clearTimeout(timer);
      detach?.();
      choiceRef.current?.release();
    };
  }, []);

  // Remy's hands in the library: the same steps a person takes (see LibraryHands), with what is here now.
  useEffect(() => {
    const hands: LibraryHands = {
      openCard(snippetId) {
        const entry = entries.find((candidate) => candidate.id === snippetId);
        if (!entry) return null;
        revealSaved(entry.id, entry.folderId);
        return containerRef.current?.querySelector<HTMLElement>(`[data-snippet-id="${CSS.escape(snippetId)}"]`) ?? null;
      },
      grabOf: (snippetId) => containerRef.current?.querySelector<HTMLElement>(`[data-snippet-id="${CSS.escape(snippetId)}"] .library-grab`) ?? null,
      openName: () => (openId ? (entries.find((entry) => entry.id === openId)?.snippet.name ?? null) : null),
      dropOn(snippetId, taskId, zone, at) {
        const plan = latest.current.plans.get(snippetId);
        const task = project.taskStore.getById(taskId) as TaskModel | undefined;
        const instance = ganttRef.current();
        if (!plan || !task || !instance) return false;
        const release = markRows(instance, [task], zone === 'inside' ? 'library-drop-inside' : 'library-drop-after');
        openChoiceRef.current(placementFor(task, zone), plan, { x: at.x, y: at.y, release });
        return true;
      },
      dropCard: () => choiceRef.current?.plan.tweaks.name ?? null,
      closeDropCard() {
        if (!choiceRef.current) return false;
        closeChoice();
        return true;
      },
      closeCard() {
        if (!openId) return false;
        setOpenId(null);
        return true;
      },
    };
    libraryHands.current = hands;
    return () => {
      if (libraryHands.current === hands) libraryHands.current = null;
    };
  });

  // "Save to library…" from the plan opens the save form on those tasks.
  const lastRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!saveRequest || saveRequest.nonce === lastRequest.current) return;
    lastRequest.current = saveRequest.nonce;
    saveFromPlan(saveRequest.taskIds);
  });

  // A snippet just saved: open its folders and bring its card into view once the library lists it.
  useEffect(() => {
    if (!revealId) return;
    const card = containerRef.current?.querySelector<HTMLElement>(`[data-snippet-id="${CSS.escape(revealId)}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setRevealId(null);
  });

  // Close menus on a click elsewhere.
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.library-menu-anchor')) setMenu(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const selected = selectedTaskId == null ? null : ((project.taskStore.getById(selectedTaskId) as TaskModel | undefined) ?? null);
  const picked = (selectedTaskIds.length > 0 ? selectedTaskIds : selectedTaskId == null ? [] : [selectedTaskId]).filter((id) => project.taskStore.getById(id));

  const pickedLabel = picked.length === 1 ? `“${(project.taskStore.getById(picked[0]!) as TaskModel).name}”` : `the ${picked.length} selected tasks`;

  const run = (work: () => Promise<unknown>) => {
    setError(null);
    void work().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const saveFromPlan = (taskIds: readonly number[], folderId: string | null = null) => {
    const tasks = taskIds.map((id) => project.taskStore.getById(id) as TaskModel | undefined).filter((task): task is TaskModel => Boolean(task));
    if (tasks.length === 0) return;
    try {
      setSaveForm({ draft: snippetFromTasks(project, tasks), folderId, picked: tasks.length });
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const revealSaved = (id: string, folderId: string | null) => {
    setOpenId(id);
    setRevealId(id);
    if (folderId) {
      setCollapsed((current) => {
        const next = new Set(current);
        for (const folder of folderPath(snapshot.folders, folderId)) next.delete(folder.id);
        return next;
      });
    }
  };

  const update = (entry: LibraryEntry, change: Partial<SnippetTweaks>) =>
    setTweaks((current) => ({ ...current, [entry.id]: { ...(current[entry.id] ?? defaultTweaks(entry.snippet)), ...change } }));

  const toggleFolder = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (library) writeCollapsed(library.projectId, next);
      return next;
    });
  };

  const tree = useMemo(() => libraryTree(snapshot.folders, entries), [snapshot.folders, entries]);
  const searching = query.trim().length > 0;
  const visible = (entry: LibraryEntry) => !searching || matchesLibrarySearch(entry.snippet, query);
  const folderHasMatch = (node: LibraryFolderNode): boolean => node.entries.some(({ entry }) => visible(entry)) || node.folders.some(folderHasMatch);
  const matchCount = entries.filter(visible).length;

  const renderEntry = (entry: LibraryEntry, number: string, depth: number) => {
    const plan = plans.get(entry.id);
    if (!plan) return null;
    return (
      <SnippetCard
        key={entry.id}
        entry={entry}
        number={number}
        depth={depth}
        plan={plan}
        tweak={tweaksOf(entry)}
        open={openId === entry.id}
        busy={busy}
        selected={selected}
        renaming={renaming?.kind === 'snippet' && renaming.id === entry.id}
        menu={menu?.kind === 'snippet' && menu.id === entry.id ? menu : null}
        folders={snapshot.folders}
        matchCrew={matchCrew}
        colorOfCrew={colorOfCrew}
        onToggle={() => setOpenId(openId === entry.id ? null : entry.id)}
        onTweak={(change) => update(entry, change)}
        onResetTweaks={() => setTweaks(({ [entry.id]: _dropped, ...rest }) => rest)}
        onAdd={(button) => {
          if (!selected) return;
          const instance = ganttRef.current();
          const box = button.getBoundingClientRect();
          openChoice(placementFor(selected, 'after'), plan, { x: box.left, y: box.bottom, release: instance ? markRows(instance, [selected], 'library-drop-after') : () => undefined });
        }}
        onMenu={(next) => setMenu(next)}
        onRename={(name) => {
          setRenaming(null);
          if (name && name !== entry.snippet.name) run(() => library!.renameSnippet(entry.id, name));
        }}
        onStartRename={() => {
          setMenu(null);
          setRenaming({ kind: 'snippet', id: entry.id });
        }}
        onEdit={() => {
          setMenu(null);
          const { id: _id, ...draft } = entry.snippet;
          setBuilder({ draft, title: `Edit “${entry.snippet.name}”`, folderId: entry.folderId, id: entry.id, origin: entry.origin });
        }}
        onDuplicate={() => {
          setMenu(null);
          run(() => library!.duplicateSnippet(entry.id));
        }}
        onMove={(folderId) => {
          setMenu(null);
          run(() => library!.moveSnippet(entry.id, folderId));
        }}
        onDelete={() => {
          setMenu(null);
          run(() => library!.deleteSnippet(entry.id));
        }}
      />
    );
  };

  const renderFolder = (node: LibraryFolderNode, depth: number): ReactNode => {
    if (searching && !folderHasMatch(node)) return null;
    const isOpen = searching || !collapsed.has(node.folder.id);
    const isMenu = menu?.kind === 'folder' && menu.id === node.folder.id ? menu : null;
    return (
      <li key={node.folder.id} className="library-folder" data-testid="library-folder">
        <div className="library-folder-row" style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }} data-folder-drop={node.folder.id} data-folder-name={node.folder.name}>
          <button type="button" className="button is-quiet is-icon is-sm library-folder-toggle" aria-expanded={isOpen} aria-label={`${isOpen ? 'Close' : 'Open'} ${node.folder.name}`} onClick={() => toggleFolder(node.folder.id)}>
            <i className={`fa fa-chevron-${isOpen ? 'down' : 'right'}`} aria-hidden="true" />
          </button>
          <i className={`fa fa-folder${isOpen ? '-open' : ''} library-folder-icon`} aria-hidden="true" />
          <span className="library-number">{node.number}</span>
          {renaming?.kind === 'folder' && renaming.id === node.folder.id ? (
            <RenameInput
              value={node.folder.name}
              onDone={(name) => {
                setRenaming(null);
                if (name && name !== node.folder.name) run(() => library!.renameFolder(node.folder.id, name));
              }}
            />
          ) : (
            <button type="button" className="library-folder-name" onClick={() => toggleFolder(node.folder.id)} onDoubleClick={() => setRenaming({ kind: 'folder', id: node.folder.id })}>
              {node.folder.name}
            </button>
          )}
          <span className="pill">{node.count}</span>
          <span className="library-menu-anchor">
            <button type="button" className="button is-quiet is-icon is-sm" aria-label={`More for ${node.folder.name}`} aria-expanded={Boolean(isMenu)} onClick={() => setMenu(isMenu ? null : { kind: 'folder', id: node.folder.id })}>
              <i className="fa fa-ellipsis" aria-hidden="true" />
            </button>
            {isMenu && (
              <div className="popover library-menu" role="menu">
                {isMenu.confirmDelete ? (
                  <ConfirmDelete
                    text={node.count > 0 ? `Delete “${node.folder.name}”? Its ${plural(node.count, 'snippet')} move up a level.` : `Delete “${node.folder.name}”?`}
                    onYes={() => {
                      setMenu(null);
                      run(() => library!.deleteFolder(node.folder.id));
                    }}
                    onNo={() => setMenu(null)}
                  />
                ) : (
                  <>
                    <MenuItem icon="file-circle-plus" label="New snippet here" onClick={() => {
                      setMenu(null);
                      setBuilder({ draft: emptyDraft(), title: 'New piece of work', folderId: node.folder.id, origin: 'person' });
                    }} />
                    <MenuItem icon="folder-plus" label="New folder inside" onClick={() => {
                      setMenu(null);
                      run(async () => {
                        const id = await library!.createFolder('New folder', node.folder.id);
                        setRenaming({ kind: 'folder', id });
                      });
                    }} />
                    {picked.length > 0 && <MenuItem icon="cubes" label={`Save ${pickedLabel} here`} onClick={() => {
                      setMenu(null);
                      saveFromPlan(picked, node.folder.id);
                    }} />}
                    <MenuItem icon="pen" label="Rename" onClick={() => {
                      setMenu(null);
                      setRenaming({ kind: 'folder', id: node.folder.id });
                    }} />
                    <MenuItem icon="trash-can" label="Delete folder…" danger onClick={() => setMenu({ kind: 'folder', id: node.folder.id, confirmDelete: true })} />
                  </>
                )}
              </div>
            )}
          </span>
        </div>
        {isOpen && (
          <ul className="library-folder-body">
            {node.folders.map((child) => renderFolder(child, depth + 1))}
            {node.entries.filter(({ entry }) => visible(entry)).map(({ entry, number }) => renderEntry(entry, number, depth + 1))}
            {node.folders.length === 0 && node.entries.length === 0 && (
              <li className="library-folder-empty" style={{ paddingLeft: `${2.4 + depth * 0.9}rem` }}>
                Empty: drag a card here, or save work from the plan.
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="inspector-body library" data-testid="library-panel" ref={containerRef}>
      <InspectorHeader
        icon="cubes"
        title="Task library"
        subtitle="Pieces of plan to drag in. Save work from the plan, or build your own."
        actions={
          <span className="library-menu-anchor">
            <button type="button" className="button is-sm" aria-expanded={menu?.kind === 'new'} onClick={() => setMenu(menu?.kind === 'new' ? null : { kind: 'new' })} data-testid="library-new">
              <i className="fa fa-plus" aria-hidden="true" /> New
            </button>
            {menu?.kind === 'new' && (
              <div className="popover library-menu library-menu-right" role="menu">
                <MenuItem icon="file-circle-plus" label="Build a new snippet…" onClick={() => {
                  setMenu(null);
                  setBuilder({ draft: emptyDraft(), title: 'New piece of work', folderId: null, origin: 'person' });
                }} testId="library-new-snippet" />
                <MenuItem icon="folder-plus" label="New folder" onClick={() => {
                  setMenu(null);
                  run(async () => {
                    const id = await library!.createFolder('New folder', null);
                    setRenaming({ kind: 'folder', id });
                  });
                }} />
                <MenuItem
                  icon="cubes"
                  label={picked.length > 0 ? `Save ${pickedLabel} from the plan…` : 'Save work from the plan (select it first)'}
                  disabled={picked.length === 0}
                  onClick={() => {
                    setMenu(null);
                    saveFromPlan(picked);
                  }}
                />
              </div>
            )}
          </span>
        }
      />

      <div className="library-tools">
        <label className="input library-search">
          <i className="fa fa-magnifying-glass" aria-hidden="true" />
          <input type="search" value={query} placeholder="Find by name, task or crew" onChange={(event) => setQuery(event.target.value)} aria-label="Search the library" />
        </label>
        {onAsk && (
          <button
            type="button"
            className="button"
            title={`${ASSISTANT_NAME} looks through the plan for repeating work worth keeping`}
            onClick={() => onAsk('Look through the plan for repeating or reusable work I could save to the library.')}
            data-testid="library-find-repeats"
          >
            <RemyMark motion="still" className="remy-inline" /> Find reusable work
          </button>
        )}
      </div>

      {saveForm && library ? (
        <SaveForm
          form={saveForm}
          folders={snapshot.folders}
          knownCrews={projectCrews.map((crew) => crew.name)}
          colorOfCrew={colorOfCrew}
          onChange={setSaveForm}
          onCancel={() => setSaveForm(null)}
          onEdit={() => {
            setBuilder({ draft: saveForm.draft, title: 'Save to the library', folderId: saveForm.folderId, origin: 'plan' });
            setSaveForm(null);
          }}
          onSave={async () => {
            const id = await library.saveSnippet(saveForm.draft, { folderId: saveForm.folderId, origin: 'plan' });
            setSaveForm(null);
            revealSaved(id, saveForm.folderId);
          }}
        />
      ) : picked.length > 0 ? (
        <button type="button" className="button is-block library-save-picked" onClick={() => saveFromPlan(picked)} data-testid="library-save-picked">
          <i className="fa fa-cubes" aria-hidden="true" /> Save {pickedLabel} to the library
        </button>
      ) : (
        <p className="library-how">
          <i className="fa fa-hand-pointer" aria-hidden="true" /> Select work in the plan to save it here. Drag a card onto a row of the plan to add it.
        </p>
      )}

      {error && (
        <p className="note is-danger library-error" role="alert">
          <i className="fa fa-circle-exclamation" aria-hidden="true" /> {error}
          <button type="button" className="button is-link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}
      {note && (
        <DropNoteView
          note={note}
          project={project}
          busy={busy}
          onShow={() => void showRows(note.undone ? [] : note.result.tops, note.result.created)}
          onUndo={() => void undo(note)}
          onClose={() => setNote(null)}
        />
      )}

      {snapshot.status === 'loading' && <p className="library-status">Loading the library…</p>}
      {snapshot.status === 'error' && (
        <p className="note is-danger library-error">
          <i className="fa fa-circle-exclamation" aria-hidden="true" /> The library could not be read: {snapshot.error}
        </p>
      )}
      {snapshot.status === 'ready' && entries.length === 0 && snapshot.folders.length === 0 && (
        <div className="empty-state library-empty">
          <p>The library is empty. Select work in the plan and save it here, or build a piece from scratch.</p>
        </div>
      )}
      {searching && <p className="library-status">{matchCount === 0 ? 'Nothing matches.' : `${plural(matchCount, 'snippet')} match.`}</p>}

      <ul className="library-tree-root" data-folder-drop="" data-folder-name="the top of the library">
        {tree.folders.map((node) => renderFolder(node, 0))}
        {tree.entries.filter(({ entry }) => visible(entry)).map(({ entry, number }) => renderEntry(entry, number, 0))}
      </ul>

      {builder && library && (
        <SnippetBuilder
          initial={builder.draft}
          title={builder.title}
          folders={snapshot.folders}
          folderId={builder.folderId}
          crews={projectCrews}
          existingId={builder.id}
          onClose={() => setBuilder(null)}
          onSave={async (draft, folderId, asCopy) => {
            const id = await library.saveSnippet(draft, { id: asCopy ? undefined : builder.id, folderId, origin: asCopy ? 'person' : builder.origin });
            setBuilder(null);
            revealSaved(id, folderId);
          }}
        />
      )}
      {choice && (
        <DropChoice
          key={choice.token}
          choice={choice}
          project={project}
          gantt={gantt}
          onChoose={choose}
          onChooseSuggested={chooseSuggested}
          onCancel={closeChoice}
        />
      )}
    </div>
  );
}

interface SnippetCardProps {
  entry: LibraryEntry;
  number: string;
  depth: number;
  plan: SnippetPlan;
  tweak: SnippetTweaks;
  open: boolean;
  busy: boolean;
  selected: TaskModel | null;
  renaming: boolean;
  menu: { kind: 'snippet' | 'folder'; id: string; confirmDelete?: boolean; moving?: boolean } | null;
  folders: LibraryPanelFolders;
  matchCrew(name: string): ResourceModel | undefined;
  colorOfCrew(name: string): string | undefined;
  onToggle(): void;
  onTweak(change: Partial<SnippetTweaks>): void;
  onResetTweaks(): void;
  /** Asks how to add it after the selected task (the choice card opens by `button`). */
  onAdd(button: HTMLElement): void;
  onMenu(menu: Menu): void;
  onStartRename(): void;
  onRename(name: string): void;
  onEdit(): void;
  onDuplicate(): void;
  onMove(folderId: string | null): void;
  onDelete(): void;
}

type LibraryPanelFolders = Parameters<typeof folderOptions>[0];

const ORIGIN_WORDS: Partial<Record<LibraryOrigin, { icon: ReactNode; label: string }>> = {
  assistant: { icon: <RemyMark motion="still" className="remy-inline" />, label: `Drafted by ${ASSISTANT_NAME}` },
  plan: { icon: <i className="fa fa-diagram-project" aria-hidden="true" />, label: 'Saved from the plan' },
};

function SnippetCard(props: SnippetCardProps) {
  const { entry, number, depth, plan, tweak, open, busy, selected, renaming, menu, folders, matchCrew, colorOfCrew } = props;
  const { snippet } = entry;
  const copies = copyCount(plan);
  const origin = ORIGIN_WORDS[entry.origin];
  const linkTypes = new Set(snippet.links.map((link) => link.type ?? 'FS'));
  const leads = snippet.links.filter((link) => (link.lag ?? 0) < 0).length;
  return (
    <li className={`card is-interactive library-card${open ? ' is-selected' : ''}`} data-snippet-id={entry.id} data-testid="library-card" style={{ marginLeft: `${0.5 + depth * 0.9}rem` }}>
      <div className="library-grab" title="Drag onto the plan">
        <span className="library-grip" aria-hidden="true">
          <i className="fa fa-grip-vertical" />
        </span>
        <span className="library-icon" aria-hidden="true">
          <i className={`fa fa-${snippet.icon}`} />
        </span>
        <span className="library-card-text">
          {renaming ? (
            <RenameInput value={snippet.name} onDone={props.onRename} />
          ) : (
            <strong title={snippet.name}>
              <span className="library-number">{number}</span> {copies > 1 ? `${plan.tweaks.name} × ${copies}` : plan.tweaks.name}
            </strong>
          )}
          <span className="library-card-meta">
            <CrewDots names={plan.crews} matchCrew={matchCrew} />
            {plural(leavesOf(snippet.children).length * copies, 'task')} · {plural(plan.span, 'day')}
            {(snippet.timeRanges?.length ?? 0) > 0 && (
              <span className="library-meta-tag" title="Brings time ranges onto the timeline">
                <i className="fa fa-swatchbook" aria-hidden="true" /> {snippet.timeRanges!.length}
              </span>
            )}
            {origin && (
              <span className="library-meta-tag" title={origin.label}>
                {origin.icon}
              </span>
            )}
          </span>
        </span>
        <span className="library-menu-anchor">
          <button type="button" className="button is-quiet is-icon is-sm" aria-label={`More for ${snippet.name}`} aria-expanded={Boolean(menu)} onClick={() => props.onMenu(menu ? null : { kind: 'snippet', id: entry.id })}>
            <i className="fa fa-ellipsis-vertical" aria-hidden="true" />
          </button>
          {menu && (
            <div className="popover library-menu library-menu-right" role="menu">
              {menu.confirmDelete ? (
                <ConfirmDelete text={`Delete “${snippet.name}” from the library? Work already in the plan stays.`} onYes={props.onDelete} onNo={() => props.onMenu(null)} />
              ) : menu.moving ? (
                <>
                  <p className="section-label library-menu-title">Move to</p>
                  <MenuItem icon="layer-group" label="Library (top level)" disabled={entry.folderId === null} onClick={() => props.onMove(null)} />
                  {folderOptions(folders).map(({ folder, depth: level }) => (
                    <MenuItem key={folder.id} icon="folder" label={folder.name} indent={level} disabled={folder.id === entry.folderId} onClick={() => props.onMove(folder.id)} />
                  ))}
                </>
              ) : (
                <>
                  <MenuItem icon="pen-ruler" label="Open in the builder" onClick={props.onEdit} testId="library-edit" />
                  <MenuItem icon="copy" label="Duplicate" onClick={props.onDuplicate} />
                  <MenuItem icon="pen" label="Rename" onClick={props.onStartRename} />
                  <MenuItem icon="folder-tree" label="Move to…" onClick={() => props.onMenu({ kind: 'snippet', id: entry.id, moving: true })} />
                  <MenuItem icon="trash-can" label="Delete…" danger onClick={() => props.onMenu({ kind: 'snippet', id: entry.id, confirmDelete: true })} />
                </>
              )}
            </div>
          )}
        </span>
        <button type="button" className="button is-quiet is-icon is-sm library-toggle" aria-expanded={open} aria-label={open ? `Hide ${snippet.name}` : `Show and change ${snippet.name}`} onClick={props.onToggle}>
          <i className={`fa fa-chevron-${open ? 'up' : 'down'}`} aria-hidden="true" />
        </button>
      </div>
      <div className="library-mini" aria-hidden="true">
        <SnippetMiniTimeline body={snippet} crewColor={colorOfCrew} scale={tweak.scale} />
      </div>
      {open && (
        <div className="library-detail">
          {snippet.summary && <p className="library-summary">{snippet.summary}</p>}
          <div className="library-facts">
            {[...linkTypes].map((type) => (
              <span key={type} className="pill" title={LINK_TYPE_WORDS[type].sentence}>
                {type} · {LINK_TYPE_WORDS[type].label.toLowerCase()}
              </span>
            ))}
            {leads > 0 && <span className="pill is-warning">{plural(leads, 'lead')}</span>}
          </div>
          <div className="library-tweaks">
            <label className="field library-field-wide">
              <span className="field-label">Name</span>
              <input className="input" value={tweak.name} onChange={(event) => props.onTweak({ name: event.target.value })} aria-label="Name of the new work" />
            </label>
            <div className="field">
              <span className="field-label">How many</span>
              <div className="library-stepper">
                <button type="button" aria-label="One fewer" disabled={copies <= 1} onClick={() => props.onTweak({ repeats: copies - 1 })}>
                  <i className="fa fa-minus" aria-hidden="true" />
                </button>
                <output aria-live="polite">
                  {copies} {copies === 1 ? snippet.unit.one : snippet.unit.many}
                </output>
                <button type="button" aria-label="One more" disabled={copies >= MAX_REPEATS} onClick={() => props.onTweak({ repeats: copies + 1 })}>
                  <i className="fa fa-plus" aria-hidden="true" />
                </button>
              </div>
            </div>
            <label className="field">
              <span className="field-label">How long</span>
              <select className="input" value={tweak.scale} onChange={(event) => props.onTweak({ scale: Number(event.target.value) })}>
                {SCALE_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {copies > 1 && (
            <p className="library-repeat-note">
              {copies} numbered copies, one after another: “{plan.copies[0]!.name}” to “{plan.copies.at(-1)!.name}”.
            </p>
          )}
          <SnippetTree tasks={snippet.children} snippet={snippet} matchCrew={matchCrew} />
          {(snippet.timeRanges?.length ?? 0) > 0 && (
            <ul className="library-ranges" aria-label="Time ranges">
              {snippet.timeRanges!.map((range) => (
                <li key={range.key}>
                  <span className={`library-range-swatch library-band-${range.tone ?? 'amber'}`} />
                  {range.name}
                </li>
              ))}
            </ul>
          )}
          <div className="library-actions">
            <button
              type="button"
              className="button is-primary library-add"
              disabled={!selected || busy}
              title={selected ? 'Choose how it ties in next' : 'Select a task in the plan first'}
              onClick={(event) => props.onAdd(event.currentTarget)}
              data-testid="library-add-after"
            >
              <i className="fa fa-plus" aria-hidden="true" />
              {selected ? ` Add after “${selected.name}”…` : ' Add after the selected task'}
            </button>
            <button type="button" className="button is-link" onClick={props.onEdit}>
              <i className="fa fa-pen-ruler" aria-hidden="true" /> Open in the builder
            </button>
            {(tweak.name !== snippet.name || tweak.scale !== 1 || tweak.repeats !== 1) && (
              <button type="button" className="button is-link" onClick={props.onResetTweaks}>
                Undo my changes
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function MenuItem({ icon, label, onClick, disabled, danger, indent = 0, testId }: { icon: string; label: string; onClick(): void; disabled?: boolean; danger?: boolean; indent?: number; testId?: string }) {
  return (
    <button type="button" role="menuitem" className={`menu-item${danger ? ' is-danger' : ''}`} disabled={disabled} onClick={onClick} style={indent ? { paddingLeft: `${0.5 + indent * 0.8}rem` } : undefined} data-testid={testId}>
      <i className={`fa fa-${icon}`} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function ConfirmDelete({ text, onYes, onNo }: { text: string; onYes(): void; onNo(): void }) {
  return (
    <div className="library-confirm">
      <p>{text}</p>
      <div>
        <button type="button" className="button is-sm" onClick={onNo}>
          Keep it
        </button>
        <button type="button" className="button is-danger is-primary is-sm" onClick={onYes}>
          Delete
        </button>
      </div>
    </div>
  );
}

function RenameInput({ value, onDone }: { value: string; onDone(name: string | null): void }) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className="input library-rename"
      value={text}
      autoFocus
      maxLength={120}
      aria-label="New name"
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => finish(text.trim() || null)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(text.trim() || null);
        if (event.key === 'Escape') finish(null);
        event.stopPropagation();
      }}
    />
  );
}

const shortDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
/** A task's last working moment as a day (Bryntum's end date is the moment after the last day). */
const lastDay = (end: Date) => new Date(end.getTime() - 1);

/** "Pour slab, Strip forms and 4 more moved later (up to 14 days)." */
function movedWords(moved: DropNote['moved'], verb: string): string {
  const names = moved.slice(0, 2).map((task) => `“${task.name}”`);
  const rest = moved.length - names.length;
  const who = rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(' and ');
  const furthest = Math.max(...moved.map((task) => Math.abs(task.days)));
  return `${who} ${verb}${furthest > 0 ? ` (up to ${plural(furthest, 'day')})` : ''}.`;
}

function DropNoteView({ note, project, busy, onShow, onUndo, onClose }: { note: DropNote; project: ProjectModel; busy: boolean; onShow(): void; onUndo(): void; onClose(): void }) {
  // The card used may be far down the panel: bring the note (and its Undo) into view.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [note]);
  // The toolbar's undo and redo can take the piece out or put it back: the note no longer holds then.
  // Not read at once: applying this browser's own revision takes its tasks out and back for a moment.
  const version = useProjectDataVersion(project);
  useEffect(() => {
    const timer = setTimeout(() => {
      const inPlan = note.result.tops.some((top) => project.taskStore.getById(top.id) === top);
      if (inPlan === Boolean(note.undone)) onClose();
    }, 1_500);
    return () => clearTimeout(timer);
  }, [version, note]);
  const still: Record<DropMode, string> = {
    push: 'Nothing in the plan was waiting there.',
    fit: 'Nothing already in the plan moved.',
    alongside: 'It runs alongside; nothing else moved.',
    unlinked: 'It is pinned there with no links.',
  };
  return (
    <div ref={ref} className={`note ${note.undone ? '' : 'is-success '}library-note`} role="status" data-testid="library-note">
      <i className={`fa fa-${note.undone ? 'rotate-left' : 'circle-check'}`} aria-hidden="true" />
      <div className="library-note-text">
        {note.undone ? (
          <>
            <strong>Took out {note.title}</strong>
            <span>
              {note.moved.length > 0 ? movedWords(note.moved, 'went back') : 'Nothing else had moved.'}
            </span>
          </>
        ) : (
          <>
            <strong>Added {note.title}</strong>
            <span>{note.where}.</span>
            {note.placed && (
              <span className="library-note-placed" data-testid="library-note-placed">
                <RemyMark motion="still" className="remy-inline" /> {note.placed.auto ? 'Placed for you: ' : ''}
                {note.placed.reason}
              </span>
            )}
            <span>
              {note.moved.length > 0 ? movedWords(note.moved, 'moved later') : still[note.mode]}
            </span>
            {note.unknownCrews.length > 0 && (
              <span className="library-note-warn">
                No crew yet for {note.unknownCrews.join(', ')}: {note.unknownCrews.length === 1 ? 'it is' : 'they are'} not on this project.
              </span>
            )}
            <span className="library-note-actions">
              <button type="button" className="button is-link" onClick={onShow}>
                <i className="fa fa-eye" aria-hidden="true" /> Show in the plan
              </button>
              <button type="button" className="button is-link" onClick={onUndo} disabled={busy} data-testid="library-undo">
                <i className="fa fa-rotate-left" aria-hidden="true" /> Undo
              </button>
            </span>
          </>
        )}
      </div>
      <button type="button" className="button is-quiet is-icon is-sm library-note-close" aria-label="Dismiss" onClick={onClose}>
        <i className="fa fa-xmark" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The card at the drop spot: how to tie the piece in. "Push later work back" and "Fit in" come with
 * what they would do (worked out on a copy of the plan); two more ways are a click away. When the
 * library names a trade several firms cover (or a crew the project lacks), it asks who does it.
 */
function DropChoice({
  choice,
  project,
  gantt,
  onChoose,
  onChooseSuggested,
  onCancel,
}: {
  choice: DropChoiceState;
  project: ProjectModel;
  gantt(): Gantt | undefined;
  onChoose(mode: DropMode, crews: CrewChoices): void;
  onChooseSuggested(crews: CrewChoices): void;
  onCancel(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const questions = useMemo(() => crewQuestions(project, choice.plan.crews), [project, choice.plan]);
  const [crews, setCrews] = useState<Map<string, ResourceModel | null>>(() => new Map());
  const [position, setPosition] = useState({ left: choice.x + 16, top: choice.y - 16 });
  const unmark = useRef<(() => void) | null>(null);
  const { plan } = choice;
  const name = copyCount(plan) > 1 ? `${plan.tweaks.name} × ${copyCount(plan)}` : plan.tweaks.name;

  // Beside the spot it was let go (right of it when there is room), inside the window.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const gap = 12;
    let left = choice.x + 16;
    if (left + box.width > window.innerWidth - gap) left = Math.max(gap, choice.x - box.width - 16);
    const top = Math.max(gap, Math.min(choice.y - 16, window.innerHeight - box.height - gap));
    setPosition((current) => (current.left === left && current.top === top ? current : { left, top }));
  });

  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  // The assistant's answer comes in: its place is brought into view and marked, ready for Enter.
  useEffect(() => {
    if (choice.suggestion.status !== 'ready') return;
    const after = project.taskStore.getById(choice.suggestion.value.afterId) as TaskModel | undefined;
    const instance = gantt();
    void (async () => {
      if (instance && after) await (instance.scrollRowIntoView(after as never, { block: 'nearest' } as never) as Promise<unknown>).catch(() => undefined);
      if (!ref.current) return;
      ref.current.querySelector<HTMLButtonElement>('[data-testid=library-choose-suggested]')?.focus();
      markSuggested(true);
    })();
  }, [choice.suggestion.status]);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('.library-choice-option')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      cancelRef.current();
    };
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) cancelRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
      unmark.current?.();
      unmark.current = null;
    };
  }, []);

  /** Marks the rows a way would move, while it is pointed at. */
  const mark = (mode: DropMode | null) => {
    unmark.current?.();
    unmark.current = null;
    const instance = gantt();
    const moved = mode ? (choice.previews[mode]?.moved ?? []) : [];
    if (!instance || moved.length === 0) return;
    const tasks = moved.map((task) => project.taskStore.getById(task.id) as TaskModel | undefined).filter((task): task is TaskModel => Boolean(task));
    unmark.current = markRows(instance, tasks, 'library-will-move');
  };

  const effect = (mode: DropMode): ReactNode => (mode === 'alongside' || mode === 'unlinked' ? <span>{describeEffect(choice.placement, mode)}.</span> : numbers(choice.previews[mode]));

  /** When it would run and what it would move; or why it cannot be done. */
  const numbers = (preview: DropPreview | undefined): ReactNode => {
    if (!preview) {
      return (
        <span className="library-choice-wait">
          <i className="fa fa-spinner fa-spin" aria-hidden="true" /> Working out what moves…
        </span>
      );
    }
    if (preview.error) return <span>{preview.error}</span>;
    const later = preview.moved.filter((task) => task.days > 0);
    const furthest = Math.max(0, ...later.map((task) => task.days));
    return (
      <>
        {preview.start && preview.end && (
          <span>
            Runs {shortDay.format(preview.start)} – {shortDay.format(lastDay(preview.end))}
          </span>
        )}
        <span>{later.length > 0 ? `${later.length === 1 ? '1 task moves' : `${later.length} tasks move`} later, up to ${plural(furthest, 'day')}` : 'Nothing already in the plan moves'}</span>
      </>
    );
  };

  const option = (mode: DropMode) => {
    const info = DROP_MODES.find((candidate) => candidate.mode === mode)!;
    return (
      <button
        key={mode}
        type="button"
        className="library-choice-option"
        data-mode={mode}
        disabled={Boolean(choice.previews[mode]?.error)}
        onClick={() => onChoose(mode, crews)}
        onMouseEnter={() => mark(mode)}
        onMouseLeave={() => mark(null)}
        onFocus={() => mark(mode)}
        onBlur={() => mark(null)}
        data-testid={`library-choose-${mode}`}
      >
        <i className={`fa fa-${info.icon}`} aria-hidden="true" />
        <span className="library-choice-text">
          <strong>{info.label}</strong>
          {effect(mode)}
        </span>
      </button>
    );
  };

  const valueOf = (question: (typeof questions)[number]) => {
    const picked = crews.has(question.name) ? crews.get(question.name) : question.matched;
    return picked ? String(picked.id) : '';
  };

  const suggestion = choice.suggestion;
  /** Marks the task the assistant would follow and the one that would wait, while its option is pointed at. */
  const markSuggested = (on: boolean) => {
    unmark.current?.();
    unmark.current = null;
    const instance = gantt();
    if (!on || !instance || suggestion.status !== 'ready') return;
    const after = project.taskStore.getById(suggestion.value.afterId) as TaskModel | undefined;
    if (after) unmark.current = markRows(instance, [after], 'library-suggested');
  };
  const suggestedOption = () => {
    if (suggestion.status === 'none') return null;
    if (suggestion.status === 'asking') {
      return (
        <div className="library-choice-suggest is-asking" data-testid="library-suggest-asking">
          <span className="assistant-orb is-busy" aria-hidden="true">
            <RemyMark motion="work" />
          </span>
          <span className="library-choice-text">
            <strong>{choice.auto ? `Placing it like ${choice.auto.group}…` : 'Finding where it fits…'}</strong>
            <span className="library-choice-shimmer" aria-hidden="true" />
          </span>
        </div>
      );
    }
    const after = project.taskStore.getById(suggestion.value.afterId) as TaskModel | undefined;
    const before = suggestion.value.beforeId === null ? null : (project.taskStore.getById(suggestion.value.beforeId) as TaskModel | undefined);
    // Its work belongs in another group for the same place (the floor's build-out, not its concrete deck).
    const elsewhere = suggestion.group !== groupOfPlacement(choice.placement) ? suggestion.group.name : null;
    const fits = suggestion.value.fits !== false;
    return (
      <button
        type="button"
        className={`library-choice-option library-choice-suggest is-ready${fits ? '' : ' is-misfit'}`}
        disabled={Boolean(choice.previews.suggested?.error)}
        onClick={() => onChooseSuggested(crews)}
        onMouseEnter={() => markSuggested(true)}
        onMouseLeave={() => markSuggested(false)}
        onFocus={() => markSuggested(true)}
        onBlur={() => markSuggested(false)}
        data-testid="library-choose-suggested"
        data-fits={fits ? 'true' : 'false'}
        data-group={suggestion.group.name ?? ''}
      >
        <span className="assistant-orb" aria-hidden="true">
          <RemyMark motion="still" />
        </span>
        <span className="library-choice-text">
          {!fits && <span className="library-choice-misfit">Doesn’t belong here</span>}
          {elsewhere && <span className="library-choice-elsewhere">In {elsewhere}</span>}
          <strong>
            {after ? `${suggestion.value.mode === 'alongside' ? 'With' : 'After'} ${after.name}` : 'That task has just been removed'}
            {after && before && suggestion.value.mode !== 'alongside' ? <span className="library-choice-before"> · before {before.name}</span> : null}
          </strong>
          <span>{suggestion.value.reason}</span>
          {numbers(choice.previews.suggested)}
          <span className="library-choice-source">{suggestion.value.source === 'model' ? `Suggested by ${ASSISTANT_NAME}` : 'By the usual trade order'}</span>
        </span>
      </button>
    );
  };

  return createPortal(
    <div ref={ref} className={`popover library-choice${choice.auto ? ' is-auto' : ''}`} role="dialog" aria-label={`How to add ${name}`} style={{ left: position.left, top: position.top }} data-testid="library-choice">
      <header className="library-choice-head">
        <span className="library-choice-icon" aria-hidden="true">
          <i className={`fa fa-${plan.snippet.icon}`} />
        </span>
        <span className="library-choice-title">
          <strong>{name}</strong>
          <span>{describePlace(choice.placement)}</span>
        </span>
        <button type="button" className="button is-quiet is-icon is-sm" aria-label="Cancel" onClick={onCancel}>
          <i className="fa fa-xmark" aria-hidden="true" />
        </button>
      </header>
      {suggestedOption()}
      {!choice.auto && (
        <>
          {suggestion.status !== 'none' && <p className="section-label library-choice-where">Or where you let go</p>}
          <div className="library-choice-options">
            {option('push')}
            {option('fit')}
            {more && option('alongside')}
            {more && option('unlinked')}
          </div>
        </>
      )}
      {questions.length > 0 && !choice.auto && (
        <div className="library-choice-crews">
          <p className="section-label">Who does it</p>
          {questions.map((question) => (
            <label key={question.name} className="library-choice-crew">
              <span>{question.name}</span>
              <select
                className="input is-sm"
                value={valueOf(question)}
                onChange={(event) => {
                  const resource = (project.resourceStore.getById(event.target.value) as ResourceModel | undefined) ?? (project.resourceStore.getById(Number(event.target.value)) as ResourceModel | undefined) ?? null;
                  setCrews((current) => new Map(current).set(question.name, resource));
                }}
                aria-label={`Who does the ${question.name} work`}
              >
                {question.options.map((resource) => {
                  const trade = (resource as ResourceModel & { trade?: string }).trade;
                  return (
                    <option key={String(resource.id)} value={String(resource.id)}>
                      {resource.name}
                      {trade ? ` · ${trade}` : ''}
                    </option>
                  );
                })}
                <option value="">Nobody yet</option>
              </select>
            </label>
          ))}
        </div>
      )}
      <footer className="library-choice-foot">
        {!choice.auto && (
          <button type="button" className="button is-link is-sm" aria-expanded={more} onClick={() => setMore(!more)}>
            {more ? 'Fewer ways' : 'More ways to tie it in'}
          </button>
        )}
        <span className="library-choice-hint">
          <span className="kbd">Esc</span> cancels
        </span>
      </footer>
    </div>,
    document.body,
  );
}

/** The short form for saving work picked in the plan: a name, a folder, and what it holds. */
function SaveForm({
  form,
  folders,
  knownCrews,
  colorOfCrew,
  onChange,
  onCancel,
  onEdit,
  onSave,
}: {
  form: SaveFormState;
  folders: LibraryPanelFolders;
  knownCrews: readonly string[];
  colorOfCrew(name: string): string | undefined;
  onChange(form: SaveFormState): void;
  onCancel(): void;
  onEdit(): void;
  onSave(): Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { draft } = form;
  const leaves = leavesOf(draft.children).length;
  const span = useMemo(() => scheduleSnippet(draft).span, [draft]);
  const crewCount = crewNamesOf(draft.children).length;
  const errors = useMemo(() => checkSnippet(draft, knownCrews).filter((problem) => problem.level === 'error'), [draft, knownCrews]);
  const save = async () => {
    if (errors.length > 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
    }
  };
  return (
    <form
      className="card library-save"
      aria-label="Save to the library"
      data-testid="library-save-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <header className="library-save-head">
        <strong>
          <i className="fa fa-cubes" aria-hidden="true" /> Save to the library
        </strong>
        <button type="button" className="button is-quiet is-icon is-sm" aria-label="Cancel" onClick={onCancel}>
          <i className="fa fa-xmark" aria-hidden="true" />
        </button>
      </header>
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="input"
          value={draft.name}
          maxLength={120}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => onChange({ ...form, draft: { ...draft, name: event.target.value } })}
          data-testid="library-save-name"
        />
      </label>
      <div className="library-save-what">
        <span>
          {plural(leaves, 'task')} · {plural(span, 'working day')}
          {crewCount > 0 ? ` · ${plural(crewCount, 'crew')}` : ''}
        </span>
        <div className="library-mini" aria-hidden="true">
          <SnippetMiniTimeline body={draft} crewColor={colorOfCrew} />
        </div>
      </div>
      <label className="field">
        <span className="field-label">Filed in</span>
        <select className="input" value={form.folderId ?? ''} onChange={(event) => onChange({ ...form, folderId: event.target.value || null })}>
          <option value="">Library (top level)</option>
          {folderOptions(folders).map(({ folder, depth }) => (
            <option key={folder.id} value={folder.id}>
              {`${'\u00a0\u00a0'.repeat(depth)}${folder.name}`}
            </option>
          ))}
        </select>
      </label>
      {errors.length > 0 && <p className="note is-warning is-sm">{errors[0]!.message} Open it in the builder to fix it.</p>}
      {error && (
        <p className="note is-danger is-sm" role="alert">
          {error}
        </p>
      )}
      <div className="library-save-actions">
        <button type="submit" className="button is-primary" disabled={errors.length > 0 || saving || !draft.name.trim()} data-testid="library-save-submit">
          <i className={`fa fa-${saving ? 'spinner fa-spin' : 'check'}`} aria-hidden="true" /> Save
        </button>
        <button type="button" className="button is-link" onClick={onEdit}>
          <i className="fa fa-pen-ruler" aria-hidden="true" /> Edit in the builder first
        </button>
      </div>
    </form>
  );
}

function CrewDots({ names, matchCrew }: { names: readonly string[]; matchCrew(name: string): ResourceModel | undefined }) {
  return (
    <span className="library-crews" aria-label={`Crews: ${names.join(', ')}`}>
      {names.slice(0, 5).map((name) => {
        const crew = matchCrew(name);
        return (
          <span
            key={name}
            className={`library-crew-dot${crew ? '' : ' is-unknown'}`}
            style={crew ? { background: crewColor(crew) } : undefined}
            title={crew ? name : `${name}: not on this project, left without a crew`}
          />
        );
      })}
      {names.length > 5 && <span className="library-crew-more">+{names.length - 5}</span>}
    </span>
  );
}

function SnippetTree({ tasks, snippet, matchCrew }: { tasks: readonly SnippetTask[]; snippet: { children: readonly SnippetTask[]; links: SnippetDraft['links'] }; matchCrew(name: string): ResourceModel | undefined }) {
  const numbers = useMemo(() => outlineNumbers(snippet.children), [snippet.children]);
  return (
    <ul className="library-tree" aria-label="What it contains">
      {tasks.map((task) =>
        task.children?.length ? (
          <li key={task.key} className="library-tree-group">
            <span className="library-tree-name">
              <span className="library-number">{numbers.get(task.key)}</span>
              <i className="fa fa-folder-tree" aria-hidden="true" /> {task.name}
            </span>
            <SnippetTree tasks={task.children} snippet={snippet} matchCrew={matchCrew} />
          </li>
        ) : (
          <li key={task.key} className="library-tree-task">
            <span className="library-tree-name" title={task.note}>
              <span className="library-number">{numbers.get(task.key)}</span>
              {task.duration === 0 ? <i className="fa fa-diamond library-milestone" aria-label="Milestone" /> : null}
              {task.name}
              {task.note && <i className="fa fa-note-sticky library-has-note" aria-label={`Note: ${task.note}`} />}
              {snippet.links
                .filter((link) => link.to === task.key && ((link.type ?? 'FS') !== 'FS' || (link.lag ?? 0) !== 0))
                .map((link, index) => (
                  <span key={index} className={`pill library-link-tag${(link.lag ?? 0) < 0 ? ' is-warning' : ''}`} title={`${LINK_TYPE_WORDS[link.type ?? 'FS'].sentence} ${numbers.get(link.from) ?? ''}`}>
                    {link.type ?? 'FS'}
                    {(link.lag ?? 0) > 0 ? `+${link.lag}` : (link.lag ?? 0) < 0 ? `−${-(link.lag ?? 0)}` : ''} {numbers.get(link.from)}
                  </span>
                ))}
            </span>
            <span className="library-tree-days">{task.duration === 0 ? 'milestone' : `${task.duration}d`}</span>
            <span className="library-tree-crews">
              {(task.crews ?? []).map((crew) => {
                const resource = matchCrew(crew.name);
                return (
                  <span key={crew.name} className={`pill is-label${resource ? '' : ' is-unknown'}`} title={resource ? undefined : 'Not on this project: left without a crew'}>
                    <span className="pill-dot" style={resource ? ({ '--pill-dot': crewColor(resource) } as CSSProperties) : undefined} />
                    {crew.name}
                    {crew.units && crew.units !== 100 ? ` ${crew.units}%` : ''}
                  </span>
                );
              })}
            </span>
          </li>
        ),
      )}
    </ul>
  );
}
