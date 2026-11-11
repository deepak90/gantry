import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CROWD_PEOPLE, isCurrencyCode, isFlatSnippet, type CurrencyCode, type MemberRole, type SelectedTask, type WatchAlert } from '@collab/shared';
import { AlertsPanel, AlertToasts } from '../alerts/AlertsPanel';
import type { PanelTab } from '../gantt/fx3d/side-panel';
import { useWatchList } from '../alerts/useWatchList';
import { AssistantPanel, useAssistantDecisions } from '../assistant/AssistantPanel';
import { useAssistant } from '../assistant/useAssistant';
import { RemyCursor } from '../assistant/remy-cursor';
import { createRemyUi, remyUiExecutor, type RemyScreen } from '../assistant/remy-ui';
import { readScreen } from '../assistant/screen-context';
import { lendPointer } from '../assistant/attention';
import { closeInvoiceReview, openInvoiceReview } from '../assistant/change-invoice-card';
import { closePayWindow, openPayWindow } from '../payments/PayModal';
import { commandExecutor } from '../odds/odds-command';
import { ChangelogPanel } from '../changelog/ChangelogPanel';
import type { TeamHandle } from '../crowd/in-page-team';
import { deleteDocument, documentUrl, uploadDocument, type DocumentsClient } from '../documents/api';
import { RentalsPanel } from '../editor/RentalsPanel';
import { GanttWorkspace, type GanttWorkspaceApi, type RentalEditing } from '../gantt/GanttWorkspace';
import { CrewsPanel } from '../inspector/CrewsPanel';
import { DocumentsPanel } from '../inspector/DocumentsPanel';
import type { FileKind } from '../inspector/DocumentList';
import { Inspector, type InspectorTab, type InspectorTabId } from '../inspector/Inspector';
import { LibraryPanel, type LibraryDropDetail } from '../inspector/LibraryPanel';
import { useLibrarySnapshot, useLibraryStore } from '../library/useLibrary';
import { StoryCoach } from '../onboarding/StoryCoach';
import { StoryRail } from '../onboarding/StoryRail';
import { currentStep, floorsOf, offerOf, storyFor, type NextStep, type Story, type StoryStep } from '../onboarding/story';
import { RailBar } from '../rails/RailBar';
import { RailCall } from '../rails/RailCall';
import { liveCall } from '../call/live';
import { loadRailScript } from '../rails/scripts';
import type { RailApp, RailScript } from '../rails/types';
import { useRail } from '../rails/useRail';

/**
 * A real call with Remy and the others in the project, each in their own tab (LiveKit, with Remy's call
 * worker): on the dev server with `?call` in the address, and on the hosted site while calls are switched on
 * (app_flags.live_calls). A local production build leaves all of it out: the test is written out here (not HOSTED)
 * so the bundler drops the import itself, not only the code around it.
 */
const CallLayer = import.meta.env.DEV || import.meta.env.VITE_GANTRY_HOSTED === '1' ? lazy(() => import('../call/CallLayer')) : null;
const callAsked = (search: string): boolean => new URLSearchParams(search).has('call');
import { TaskInspector } from '../inspector/TaskInspector';
import { useProjectDataVersion } from '../gantt/useProjectDataVersion';
import { resumeGatePayments } from '../gantt/pay-gate-payment';
import { ApprovalRequests } from '../payments/ApprovalRequests';
import { PayWindowHost } from '../payments/PayModal';
import { PayApprovalsProvider, type PayApprovalsValue } from '../payments/pay-approvals-context';
import { fallbackColor, initialsOf, readableInkOn } from '../presence/peers';
import { PresenceBar } from '../presence/PresenceBar';
import { PresenceLayer } from '../presence/PresenceLayer';
import type { PresenceSession } from '../presence/session';
import { usePresenceSnapshot } from '../presence/usePresence';
import { signOut } from '../supabase/auth';
import { buildDecorations } from '../workflow/decorations';
import { rentalEditFor, rentalLockOf } from '../workflow/rental';
import type { WorkflowClient } from '../workflow/api';
import { useWorkflow } from '../workflow/useWorkflow';
import { BOOT_PHASE_LABELS, type ReadyProjectSession } from './project-session';
import { PlanDate } from './PlanDate';
import { ProjectSummary } from './ProjectSummary';
import { StatusScreen } from './StatusScreen';
import { SyncBadge } from './SyncBadge';
import { useDismiss } from './useDismiss';
import { useProjectSession } from './useProjectSession';
import type { AskPlacement, PlacementAnswer } from '../library/placement';
import { runProjectTransaction } from '../scenario/publish';
import { listProjects, opensAsDemo, type ProjectListEntry } from '../supabase/project';
import { ASSISTANT_NAME } from '../assistant/identity';
import { RemyMark } from '../assistant/RemyMark';
import { GantryMark } from './GantryMark';
import { FLAGS_OFF, type AppFlags, type Copy } from '../copy/rpc';
import { InviteButton } from '../copy/InviteButton';
import type { LeaseClock } from '../copy/lease';
import { SessionEnds } from '../copy/SessionEnds';
import { reportError } from '../copy/report';
import { useActionReports } from '../copy/useActionReports';
import { fx3dEnabled } from '../gantt/fx3d';
import { UI_PANELS, type AgentCommandType, type UiPanel } from '@collab/shared';
import { StartHere, useStartHere } from '../onboarding/StartHere';
import { holdToPay, triedBy, TRY_GOAL, TRY_PITCH, type TryKey } from '../onboarding/try-these';
import { useTryThese, type TryItemView } from '../onboarding/useTryThese';
import { StartOverItem } from './StartOver';

/** One role: whatever a membership's role, people read as members of the project. */
export const ROLE_LABELS: Readonly<Record<MemberRole, string>> = {
  pm: 'Member',
  cm: 'Member',
};

/** The visitor's session (a copy) on the hosted site (copy/CopyGate.tsx): only it is shown, and it is kept while open. */
export interface HostedWorkspace {
  copy: Copy;
  /** What is switched on on the site: Remy, calls, payments. */
  flags: AppFlags;
  /** When the session ends, as last known: the header says so in its last 10 minutes. */
  lease?: LeaseClock;
  /** The signed-in person's access token, for the call's routes. */
  accessToken(): Promise<string | null>;
  /** Resets the session for everyone in it and opens a fresh one (the session's holder). */
  startOver(): void;
  /** A new session of your own, when this one won't open. */
  newCopy(): void;
}

export interface WorkspaceProps {
  client: SupabaseClient;
  session: Session;
  /** On the hosted site: the visitor's copy. */
  hosted?: HostedWorkspace;
}

/** `?project=<uuid>` opens that project; without it, the first one this person is a member of. */
const LAST_PROJECT_KEY = 'collab.last-project';

/** `?project=<uuid>`, else the project opened last in this browser; else the first one (resolved at boot). */
const projectParam = () => {
  const linked = new URLSearchParams(window.location.search).get('project');
  if (linked) return linked;
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

/** Opens another project: a fresh page, so its plan, presence and assistant start clean. */
function openProject(projectId: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    // The link alone opens it.
  }
  const url = new URL(window.location.href);
  url.searchParams.set('project', projectId);
  window.location.assign(url.toString());
}

/** The signed-in shell: header (project, viewer, sync badge, sign-out) over the Gantt workspace. */
export function Workspace({ client, session, hosted }: WorkspaceProps) {
  // On the hosted site, the copy and nothing else; on this machine, the linked or last project.
  const [projectId] = useState(() => hosted?.copy.projectId ?? projectParam());
  const { state, retrySync, restart } = useProjectSession(client, session, projectId);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const handleSignOut = () => {
    setSignOutError(null);
    signOut(client).catch((error: unknown) => setSignOutError(error instanceof Error ? error.message : String(error)));
  };
  // The hosted site counts a copy that won't open.
  const bootError = state.phase === 'error' ? state.message : null;
  useEffect(() => {
    if (hosted && bootError) reportError('open', bootError);
  }, [hosted, bootError]);

  if (state.phase === 'error') {
    return (
      <StatusScreen
        tone="error"
        title={hosted ? 'Could not open your session' : 'Could not open the project'}
        message={state.message}
        actions={
          <>
            <button type="button" className="button is-primary" onClick={restart}>
              Try again
            </button>
            {hosted ? (
              <button type="button" className="button is-quiet" onClick={hosted.newCopy}>
                Start a new session
              </button>
            ) : (
              <button type="button" className="button is-quiet" onClick={handleSignOut}>
                Sign out
              </button>
            )}
          </>
        }
      />
    );
  }
  if (state.phase !== 'ready') {
    return <StatusScreen title={BOOT_PHASE_LABELS[state.phase]} />;
  }

  return (
    <ReadyWorkspace
      client={client}
      session={session}
      ready={state}
      hosted={hosted}
      onRetrySync={retrySync}
      onRestart={restart}
      onSignOut={handleSignOut}
      signOutError={signOutError}
    />
  );
}

interface ReadyWorkspaceProps {
  client: SupabaseClient;
  session: Session;
  ready: ReadyProjectSession;
  hosted?: HostedWorkspace | undefined;
  onRetrySync(): void;
  onRestart(): void;
  onSignOut(): void;
  signOutError: string | null;
}

/** Who handles money: the cost manager with a payment approval limit. */
function isPowerUser(role: MemberRole, canViewCosts: boolean, approvalLimitMinor: number): boolean {
  return role === 'cm' && canViewCosts && approvalLimitMinor > 0;
}

/** The booted project: header, the Gantt workspace and the side panel beside it. */
function ReadyWorkspace({ client, session, ready, hosted, onRetrySync, onRestart, onSignOut, signOutError }: ReadyWorkspaceProps) {
  const { load, project, profile, sync, presence } = ready;
  const { membership } = load;
  const currency: CurrencyCode | null = isCurrencyCode(load.project.currency) ? load.project.currency : null;
  // Costs render through the shared Money formatter, so an unsupported currency hides them rather than mislabeling amounts.
  const canViewCosts = membership.can_view_costs && currency !== null;
  const powerUser = isPowerUser(membership.role, canViewCosts, membership.approval_limit_minor);
  const workflow = useWorkflow(client, ready);
  // The projects this person is in, for the switcher in the project menu; this one is remembered.
  const [projects, setProjects] = useState<readonly ProjectListEntry[]>([]);
  // A listed project opens on the plan alone, with the rail of tabs beside it: a panel takes a third of the screen,
  // so it comes up when someone asks for it. So does a demo the menu doesn't offer (Cedar Park by its link, a
  // visitor's copy of Harbor). Any other project only a link reaches opens on the selected task. A hosted copy is
  // shown as listed, alone (no switcher), with the things to try on the counter in the header.
  const [listed, setListed] = useState(Boolean(hosted));
  const [inspectorTab, setInspectorTab] = useState<InspectorTabId | null>(null);
  const inspectorTabRef = useRef(inspectorTab);
  inspectorTabRef.current = inspectorTab;
  useEffect(() => {
    if (hosted) return undefined;
    let alive = true;
    listProjects(client)
      .then((list) => {
        if (!alive) return;
        const offered = list.filter((entry) => entry.listed);
        setProjects(offered);
        const here = list.find((entry) => entry.id === load.project.id);
        const demo = here !== undefined && opensAsDemo(here);
        setListed(demo);
        if (!demo) setInspectorTab((current) => current ?? 'task');
      })
      .catch(() => setInspectorTab((current) => current ?? 'task'));
    try {
      window.localStorage.setItem(LAST_PROJECT_KEY, load.project.id);
    } catch {
      // Nothing to remember it in.
    }
    return () => {
      alive = false;
    };
  }, [client, load.project.id, hosted]);
  // "Try these" on the hosted site: what happens in this tab ticks its items off (set once the list is made, below).
  const tried = useRef<(key: TryKey) => void>(() => undefined);
  // The assistant's say on where a dropped library piece belongs (the place-snippet function).
  const askPlacement = useCallback<AskPlacement>(
    async (body) => {
      const { data, error } = await client.functions.invoke('place-snippet', { body });
      if (error) throw error instanceof Error ? error : new Error(String(error));
      return data as PlacementAnswer;
    },
    [client],
  );
  // What is selected in the plan goes along with each message to the assistant ("this task").
  const selectionForAssistant = useRef<readonly SelectedTask[]>([]);
  // Remy's cursor, and what she shows on this screen when the person here asks her (assistant/remy-ui.ts).
  const [remyCursor] = useState(() => new RemyCursor());
  useEffect(() => () => remyCursor.destroy(), [remyCursor]);
  // On a call over the 3D view her face goes where her cursor goes (gantt/fx3d/companion.ts).
  useEffect(() => lendPointer(() => remyCursor.pointer), [remyCursor]);
  const remyScreen = useRef<RemyScreen | null>(null);
  const [remy] = useState(() => {
    const ui = createRemyUi(() => remyScreen.current, remyCursor);
    return { ui, run: remyUiExecutor(ui) };
  });
  const assistant = useAssistant({
    client,
    projectId: ready.projectId,
    sessionId: ready.sessionId,
    userId: session.user.id,
    selection: () => selectionForAssistant.current,
    // What is on this tab's screen goes along too (assistant/screen-context.ts): on a call, the screen of whoever speaks.
    screen: () =>
      readScreen({
        chart: () => ganttApi.current?.screen() ?? null,
        panel: () => inspectorTabRef.current,
        call: () => {
          const call = liveCall.get()?.session;
          return call?.inCall ? (call.isHost ? 'host' : 'guest') : null;
        },
      }),
    // What Remy asks this browser to do: run the odds in the panel, the dots falling here (odds/odds-command.ts).
    // On a call they fall on the host's screen, the one everyone watches: other tabs on the call leave them to it.
    // On the hosted site, what she works out here ticks "Try these" off: paying on Friday, and the odds.
    executor: (type) => {
      // What Remy shows the person who asked happens on their own screen, on a call too.
      if (type === 'ui_action') return remy.run;
      const call = liveCall.get()?.session;
      if (call?.inCall && !call.isHost) return null;
      const run = commandExecutor(() => ganttApi.current);
      if (!hosted) return run;
      return async (type: AgentCommandType, args: unknown) => {
        const outcome = await run(type, args);
        const key = triedBy(type);
        if (outcome.ok && key) tried.current(key);
        return outcome;
      };
    },
    takesAll: () => Boolean(liveCall.get()?.session.isHost),
  });
  const assistantDecisions = useAssistantDecisions(assistant);
  const library = useLibraryStore(client, ready.projectId);
  const ganttApi = useRef<GanttWorkspaceApi>(null);
  const gantt = useCallback(() => ganttApi.current?.instance(), []);
  const ganttLook = useCallback(() => ganttApi.current?.look, []);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<readonly number[]>([]);
  const onSelectionChange = useCallback(
    (ids: number[]) => {
      // The selection empties when someone else deletes the task: the panel stays on it, to say so.
      setSelectedTaskId((current) => ids[0] ?? (current !== null && !project.taskStore.getById(current) ? current : null));
      setSelectedTaskIds(ids);
    },
    [project],
  );
  // "Save to library…" in the plan's task menu opens the library's save form on those tasks.
  const [saveRequest, setSaveRequest] = useState<{ taskIds: number[]; nonce: number } | null>(null);
  const saveToLibrary = useCallback((taskIds: number[]) => {
    setSaveRequest({ taskIds, nonce: Date.now() });
    setInspectorTab('library');
  }, []);
  const openTask = useCallback((taskId: number) => {
    if (ganttApi.current?.selectTask(taskId)) {
      setSelectedTaskId(taskId);
    }
  }, []);
  const editTask = useCallback((taskId: number) => {
    ganttApi.current?.selectTask(taskId);
    setSelectedTaskId(taskId);
    setInspectorTab('task');
  }, []);
  const panelIds = useRef<readonly string[]>([]);
  remyScreen.current = {
    chart: () => ganttApi.current?.screen() ?? null,
    panels: () => UI_PANELS.filter((panel) => panelIds.current.includes(panel)),
    openPanel: (panel: UiPanel) => setInspectorTab(panel),
    editTask,
    openPayment: (gateId) => openPayWindow(gateId),
    openInvoice: (button) => openInvoiceReview(button),
    panel: () => inspectorTabRef.current,
    closePanel: () => setInspectorTab(null),
    closePayment: () => closePayWindow(),
    closeInvoice: () => closeInvoiceReview(),
  };
  const showTasks = useCallback((taskIds: readonly number[]) => {
    if ((ganttApi.current?.focusTasks(taskIds) ?? 0) > 0 && taskIds.length === 1) setSelectedTaskId(taskIds[0]!);
  }, []);
  const openRentals = useCallback((taskId?: number) => {
    if (typeof taskId === 'number' && ganttApi.current?.selectTask(taskId)) setSelectedTaskId(taskId);
    setInspectorTab('rentals');
  }, []);
  // What a card is about: the 3D view goes there if it is open; the chart is left as it is.
  const followTasks = useCallback((taskIds: readonly number[]) => ganttApi.current?.followTasks(taskIds), []);
  // A rentals card that is on show can open its own payment, which lists every firm to pay; otherwise it's the list of rentals.
  const payOpeners = useRef(new Set<() => boolean>());
  const openPayment = useCallback(
    (taskId: number) => {
      if ([...payOpeners.current].some((open) => open())) setInspectorTab('assistant');
      else openRentals(taskId);
    },
    [openRentals],
  );
  // The side panel can leave the page and come back (the 3D view): React's own container for it stays the same throughout.
  const [inspectorHost] = useState(() => {
    const host = document.createElement('div');
    host.className = 'inspector-host';
    return host;
  });
  const inspectorSpot = useRef<HTMLDivElement>(null);
  // Only once its container is in the page, so that what mounts in it can measure itself.
  const [inspectorPlaced, setInspectorPlaced] = useState(false);
  useLayoutEffect(() => {
    inspectorSpot.current?.append(inspectorHost);
    setInspectorPlaced(true);
    return () => inspectorHost.remove();
  }, [inspectorHost]);
  const hasAssistant = Boolean(assistant);
  const showPanelTab = useCallback(
    (tab: PanelTab): boolean => {
      if (tab === 'assistant' && !hasAssistant) return false;
      setInspectorTab(tab);
      return true;
    },
    [hasAssistant],
  );
  const snapshot = workflow.state.snapshot;
  // Only a project with rented equipment has rentals to pay for.
  const hasRental = (snapshot?.bookings.length ?? 0) > 0;
  const rentals = useMemo<RentalEditing | undefined>(() => {
    if (!snapshot) return undefined;
    return {
      rentalFor: (taskId) => rentalEditFor(snapshot, project, taskId, canViewCosts),
      lockOf: (taskId, resourceId) => rentalLockOf(snapshot, taskId, resourceId),
    };
  }, [snapshot, project, canViewCosts]);
  // The live schedule is re-read whenever the engine writes new results (local edits included).
  const dataVersion = useProjectDataVersion(project);
  // A payment PayPal was still paying when the page closed: watch it again until PayPal settles it (asked as this person).
  useEffect(() => {
    if (dataVersion > 0) resumeGatePayments(project, { projectId: ready.projectId, token: async () => (await client.auth.getSession()).data.session?.access_token ?? null });
  }, [project, dataVersion, client, ready.projectId]);
  const viewerId = session.user.id;
  // Who may approve a large progress payout, and the approvals asked for (payments/pay-approvals.ts): live with the workflow.
  const payApprovals = useMemo<PayApprovalsValue>(
    () => ({
      client,
      projectId: ready.projectId,
      userId: session.user.id,
      people: (snapshot?.members ?? []).map((member) => ({
        userId: member.user_id,
        name: snapshot?.profiles.find((profile) => profile.user_id === member.user_id)?.display_name ?? 'Someone',
        canViewCosts: member.can_view_costs,
        approvalLimitMinor: member.approval_limit_minor,
        role: member.role,
      })),
      overMinor: snapshot?.secondApprovalOverMinor ?? null,
      approvals: snapshot ? (snapshot.gateApprovals ?? null) : [],
      reload: () => void workflow.controller?.reload(),
    }),
    [client, ready.projectId, session.user.id, snapshot, workflow.controller],
  );
  const decorations = useMemo(
    () =>
      buildDecorations(snapshot, project, canViewCosts, currency ?? 'USD'),
    [snapshot, project, dataVersion, canViewCosts, currency],
  );

  // Presence carries the selected task (others see it highlighted) and follows the revision.
  useEffect(() => {
    presence?.setSelectedTask(selectedTaskId);
  }, [presence, selectedTaskId]);

  const selectedTasks = useMemo(
    () =>
      selectedTaskIds.flatMap((id): SelectedTask[] => {
        const task = project.taskStore.getById(id) as { name?: string; wbsCode?: unknown } | undefined;
        if (!task) return [];
        const wbs = task.wbsCode == null ? '' : String(task.wbsCode);
        return [{ id, name: (task.name ?? 'Untitled task').slice(0, 160), wbs: wbs ? wbs.slice(0, 40) : null }];
      }),
    [selectedTaskIds, project, dataVersion],
  );
  selectionForAssistant.current = selectedTasks;

  // The watch list: rules checked against the live plan; new alerts spring up while people work.
  const watch = useWatchList({ client, projectId: ready.projectId, reloadKey: snapshot, project, decorations, dataVersion, canViewCosts, currency: currency ?? 'USD' });
  const [watchRequest, setWatchRequest] = useState<{ taskIds: readonly number[]; nonce: number } | null>(null);
  // A conversation the assistant opened about a rule (it may be private to the rule's author).
  const canOpenConversation = useCallback((threadId: string) => Boolean(assistant?.getSnapshot().threads.some((thread) => thread.id === threadId)), [assistant]);
  const openConversation = useCallback(
    (threadId: string) => {
      assistant?.openThread(threadId);
      setInspectorTab('assistant');
    },
    [assistant],
  );
  const watchTasks = useCallback((taskIds: number[]) => {
    setWatchRequest({ taskIds, nonce: Date.now() });
    setInspectorTab('alerts');
  }, []);
  // Each question from somewhere in the app is a new conversation (its own thread).
  const askAssistantAbout = useCallback(
    (taskId: number) => {
      ganttApi.current?.selectTask(taskId);
      setSelectedTaskId(taskId);
      setSelectedTaskIds([taskId]);
      assistant?.startNewThread();
      setInspectorTab('assistant');
    },
    [assistant],
  );
  const selectedFor = useCallback(
    (ids: readonly number[]): SelectedTask[] =>
      ids.flatMap((id) => {
        const task = project.taskStore.getById(id) as { name?: string; wbsCode?: unknown } | undefined;
        return task ? [{ id, name: (task.name ?? 'Untitled task').slice(0, 160), wbs: task.wbsCode == null ? null : String(task.wbsCode).slice(0, 40) || null }] : [];
      }),
    [project],
  );
  const askAssistantAboutAlert = useCallback(
    (alert: WatchAlert) => {
      if (!assistant) return;
      setInspectorTab('assistant');
      assistant.startNewThread();
      void assistant.send(`The watch list says: ${alert.title}. What is behind it, and what can we do about it?`, null, 'text', { selected_tasks: selectedFor(alert.taskIds.slice(0, 30)) });
    },
    [assistant, selectedFor],
  );

  const librarySnapshot = useLibrarySnapshot(library);
  // The steps of the work on this project (listed projects only): the rail, the coach and the one next
  // step offered above the message box all read them. Hidden from the rail, back from the account menu.
  // A hosted copy has "Try these" on the same rail instead (below).
  const guideKey = `collab.story-guide-hidden:${load.project.id}:${session.user.id}`;
  // Automated checks set collab.first-run.skip (playwright.config.ts) so nothing covers what they click.
  const [guideShown, setGuideShown] = useState(() => readFlag('collab.first-run.skip') === null && readFlag(guideKey) === null);
  const story = useMemo<Story | null>(
    () =>
      listed && !hosted
        ? storyFor({
            project,
            snapshot,
            rules: watch.rules,
            plan: watch.plan,
            dismissals: watch.dismissals,
            currency,
            assistantPiece: librarySnapshot.entries.some((entry) => entry.origin === 'assistant'),
            otherProjects: projects.filter((entry) => entry.id !== load.project.id),
          })
        : null,
    [listed, hosted, project, snapshot, watch.rules, watch.plan, watch.dismissals, currency, librarySnapshot, projects, load.project.id, dataVersion],
  );
  // Bumped by "Show me", so the coach points right away instead of after a pause.
  const [coachNudge, setCoachNudge] = useState(0);
  const showStoryStep = useCallback((step: StoryStep) => {
    setInspectorTab(step.panel);
    setCoachNudge((count) => count + 1);
  }, []);
  const hideGuide = useCallback(() => {
    setGuideShown(false);
    writeFlag(guideKey, 'hidden');
  }, [guideKey]);
  // The call: with `?call` on the dev server; on the hosted site, whenever calls are switched on.
  const onCall = useMemo(() => Boolean(CallLayer) && (hosted ? hosted.flags.live_calls : callAsked(window.location.search)), [hosted]);

  // "Try these", on the hosted site: the things to try on the counter in the header, ticked off as they happen (by the
  // session's data, presence and the 3D view, and by `tried` above), with the coach pointing at each item's control.
  const tryKey = hosted ? `gantry.try:${load.project.id}:${hosted.copy.joinToken ?? ''}:${session.user.id}` : null;
  const tryThese = useTryThese({
    enabled: Boolean(hosted),
    storageKey: tryKey,
    project,
    snapshot,
    dataVersion,
    presence,
    context: { flags: hosted?.flags ?? FLAGS_OFF, calls: onCall, assistant: Boolean(assistant), site: fx3dEnabled, seesCosts: canViewCosts, pays: powerUser },
  });
  tried.current = tryThese.mark;
  const tryCurrent = tryThese.current;
  const tryStory = useMemo(() => ({ pitch: TRY_PITCH, goal: TRY_GOAL, steps: tryThese.rail }), [tryThese.rail]);
  // "Start here" by the counter, the first time the session opens in this browser.
  const startHere = useStartHere(hosted && guideShown ? `${tryKey}:start-here` : null);
  // "Show me" on an item makes it the one at hand and puts the coach on it, in the panel it happens in.
  const pickTryItem = tryThese.pick;
  const showTryItem = useCallback(
    (item: TryItemView) => {
      pickTryItem(item.key);
      // Paying the footings: their payment hold opens in the task panel, where Review payment is.
      const hold = item.key === 'pay' ? holdToPay(project) : null;
      if (typeof hold === 'number') editTask(hold);
      else if (item.panel) setInspectorTab(item.panel);
      setCoachNudge((count) => count + 1);
    },
    [pickTryItem, project, editTask],
  );
  // Above Remy's message box: the project's next step; on the hosted site, the question of the item at hand.
  const next = useMemo<NextStep | null>(() => (hosted ? (tryCurrent?.ask ? { kind: 'say', label: tryCurrent.ask } : null) : offerOf(story)), [hosted, tryCurrent, story]);
  // The hosted site counts the invoices this person sends and the rentals they pay.
  useActionReports(Boolean(hosted), snapshot, session.user.id);

  // The walkthrough the address asks for (`?rails=`), on its own project, played like a call: the assistant
  // joins and performs each step through the real interface, one per press of Next. While it shows, the
  // steps and the coach don't. Loaded when asked for; a hosted build has none.
  const [railScript, setRailScript] = useState<RailScript | null>(null);
  useEffect(() => {
    let alive = true;
    loadRailScript(load.project.id).then(
      (script) => {
        if (alive) setRailScript(script);
      },
      (error: unknown) => console.error('Could not load the walkthrough', error),
    );
    return () => {
      alive = false;
    };
  }, [load.project.id]);
  const railApp = useRef<RailApp | null>(null);
  const railTeam = useRef<TeamHandle | null>(null);
  railApp.current = {
    gantt,
    project,
    you: profile.displayName,
    openPanel: (panel) => setInspectorTab(panel),
    closePanel: () => setInspectorTab(null),
    showTasks,
    openTask: editTask,
    newConversation: assistant ? () => assistant.startNewThread() : undefined,
    send: (text, channel) => (assistant ? assistant.send(text, null, channel) : Promise.resolve(false)),
    // Simulated people, in this page only: presence and pointers, nothing written (crowd/in-page-team.ts).
    team: {
      start: async (people) => {
        const { startTeam } = await import('../crowd/in-page-team');
        railTeam.current = startTeam({ people });
        return railTeam.current.people.map((person) => person.name);
      },
      stop: () => {
        railTeam.current?.stop();
        railTeam.current = null;
      },
    },
  };
  const rail = useRail(railScript, railApp);
  // Remy on the call this tab hosts, on presence: the assistant service greets the call.
  const onRemyCall = useCallback((call: { remy: boolean; thread: string | null } | null) => presence?.setCall(call), [presence]);
  const takeNextStep = useCallback(
    (step: NextStep) => {
      switch (step.kind) {
        case 'say':
          void assistant?.send(step.label);
          break;
        case 'library':
          setInspectorTab('library');
          break;
        case 'finish':
          void runProjectTransaction(project, step.label, () => {
            for (const id of step.taskIds) (project.taskStore.getById(id) as TaskModel | undefined)?.set('percentDone', 100);
          });
          break;
        case 'open-project':
          openProject(step.projectId);
          break;
      }
    },
    [assistant, project],
  );

  const taskName = useCallback((taskId: number) => (project.taskStore.getById(taskId) as { name?: string } | undefined)?.name ?? null, [project]);

  // The project's files arrive with the workflow snapshot (and refresh with it).
  const documents = useMemo(() => snapshot?.documents ?? [], [snapshot]);
  const names = useMemo(() => new Map((snapshot?.profiles ?? []).map((profile) => [profile.user_id, profile.display_name])), [snapshot]);
  // Who can be invited into an assistant thread, and who may see costs there.
  const threadMembers = useMemo(() => (snapshot?.members ?? []).map((member) => ({ userId: member.user_id, canViewCosts: member.can_view_costs })), [snapshot]);
  const nameOf = useCallback((userId: string | null) => (userId === null ? null : (names.get(userId) ?? null)), [names]);
  const documentsClient = client as unknown as DocumentsClient;
  const [fileError, setFileError] = useState<string | null>(null);
  const openDocument = useCallback(
    (id: string) => {
      const doc = documents.find((candidate) => candidate.id === id);
      if (!doc) return;
      // Opened now, while the click still counts as the person's own: a window opened after the
      // link arrives would be blocked as a pop-up.
      const opened = window.open('', '_blank');
      documentUrl(documentsClient, doc).then(
        (url) => {
          if (opened) opened.location.href = url;
          else window.location.assign(url);
        },
        (error: unknown) => {
          opened?.close();
          setFileError(error instanceof Error ? error.message : String(error));
        },
      );
    },
    [documents, documentsClient],
  );
  const uploadFile = useCallback(
    async (taskId: number | null, file: File, kind: FileKind) => {
      await uploadDocument(documentsClient, { projectId: load.project.id, taskId, kind, file });
      await workflow.controller?.reload();
    },
    [documentsClient, load.project.id, workflow.controller],
  );
  const deleteFile = useCallback(
    (id: string) => {
      deleteDocument(documentsClient, id).then(
        () => workflow.controller?.reload(),
        (error: unknown) => setFileError(error instanceof Error ? error.message : String(error)),
      );
    },
    [documentsClient, workflow.controller],
  );


  // The tab says which project this is.
  useEffect(() => {
    document.title = `${load.project.name} · Gantry`;
  }, [load.project.name]);

  // A rule on a listed project answers in its conversation: that conversation comes forward.
  useEffect(() => {
    if (!listed) return;
    for (const run of watch.freshRuns) {
      watch.seenRun(run.id);
      if (run.thread_id && canOpenConversation(run.thread_id)) openConversation(run.thread_id);
    }
  }, [listed, watch.freshRuns, watch.seenRun, canOpenConversation, openConversation]);

  // The assistant raised something on its own: its tab comes forward, unless this person is typing.
  useEffect(() => {
    if (!assistant) return undefined;
    let seen = assistant.getSnapshot().raised;
    return assistant.subscribe(() => {
      const { raised } = assistant.getSnapshot();
      if (raised === seen) return;
      seen = raised;
      const focused = document.activeElement as HTMLElement | null;
      if (!focused?.closest('input, textarea, select, [contenteditable="true"]')) setInspectorTab('assistant');
    });
  }, [assistant]);
  // After this person drops a library piece, an offer to repeat it elsewhere brings the assistant forward.
  const dropAsked = useRef(0);
  useEffect(() => {
    if (!assistant) return undefined;
    let count = assistant.getSnapshot().messages.length;
    return assistant.subscribe(() => {
      const { messages } = assistant.getSnapshot();
      const fresh = messages.slice(count);
      count = messages.length;
      if (Date.now() - dropAsked.current > 90_000) return;
      if (fresh.some((message) => message.role === 'assistant' && message.cards.some((card) => card.component === 'show_plan_edit'))) {
        dropAsked.current = 0;
        setInspectorTab('assistant');
      }
    });
  }, [assistant]);
  const colors = useMemo(() => new Map((snapshot?.profiles ?? []).map((profile) => [profile.user_id, profile.color ?? null])), [snapshot]);
  const colorOf = useCallback((userId: string | null) => (userId === null ? null : (colors.get(userId) ?? null)), [colors]);
  const rentalPay = { controller: workflow.controller, state: workflow.state, currency: currency ?? 'USD', onOpenDocument: openDocument } as const;
  const rentalsPanel = (
    <RentalsPanel
      controller={workflow.controller}
      state={workflow.state}
      currency={currency ?? 'USD'}
      canViewCosts={canViewCosts}
      project={project}
      dataVersion={dataVersion}
      selectedTaskId={selectedTaskId}
      onOpenTask={openTask}
      onOpenDocument={openDocument}
    />
  );

  const hasFloors = floorsOf(project).length >= 2;
  // Only the copy's owner starts it over: it goes back to how it started for everyone in it.
  const startOver = hosted && membership.role === 'cm' ? hosted.startOver : undefined;
  const inspectorTabs: InspectorTab[] = [
    {
      id: 'task',
      label: 'Task',
      icon: 'pen-to-square',
      hint: 'details, scheduling, links, crew and notes of the selected task',
      render: () => (
        <TaskInspector
          project={project}
          taskId={selectedTaskId}
          dataVersion={dataVersion}
          canViewCosts={canViewCosts}
          currency={currency ?? 'USD'}
          workflow={snapshot}
          decorations={decorations}
          onOpenTask={editTask}
          onOpenRentals={() => openRentals()}
          rentalPay={rentalPay}
          onOpenDocument={openDocument}
          files={{
            items: documents,
            viewerId: session.user.id,
            nameOf,
            onUpload: (taskId, file, kind) => uploadFile(taskId, file, kind),
            onDelete: deleteFile,
          }}
        />
      ),
    },
    {
      id: 'alerts',
      label: 'Watch',
      icon: 'bell',
      badge: listed ? null : watch.alerts.length || null,
      hint: 'rules that keep an eye on the plan, what they raise now, and what they said before',
      render: () => (
        <AlertsPanel
          watch={watch}
          project={project}
          viewerId={session.user.id}
          viewerIsPm={membership.role === 'pm'}
          selected={selectedTasks}
          onDescribe={
            assistant
              ? (text) => {
                  void assistant.send(text);
                  setInspectorTab('assistant');
                }
              : undefined
          }
          prefill={watchRequest}
          showTasks={showTasks}
          askAssistant={askAssistantAboutAlert}
          canOpenConversation={canOpenConversation}
          openConversation={openConversation}
        />
      ),
    },
    ...(assistant
      ? [
          {
            id: 'assistant' as const,
            label: ASSISTANT_NAME,
            mark: <RemyMark />,
            hint: 'notices problems, prepares fixes and answers questions; people approve',
            render: () => (
              <AssistantPanel
                session={assistant}
                viewerId={session.user.id}
                currency={currency ?? 'USD'}
                nameOf={nameOf}
                colorOf={colorOf}
                project={project}
                library={library}
                dataVersion={dataVersion}
                showTasks={showTasks}
                pointAt={(ids) => void remy.ui.pointAt(ids)}
                selected={selectedTasks}
                quiet={listed}
                next={rail ? null : next}
                onNext={takeNextStep}
                rules={{
                  watch,
                  workflow: workflow.state,
                  controller: workflow.controller,
                  client: client as unknown as WorkflowClient,
                  projectId: ready.projectId,
                  gantt,
                  openDocument,
                  payOpeners: payOpeners.current,
                }}
                followTasks={followTasks}
                viewerIsPm={membership.role === 'pm'}
                members={threadMembers}
                showCrew={(name) => ganttApi.current?.setSearch(name)}
                assistantName={rail?.call.name ?? ASSISTANT_NAME}
              />
            ),
          },
        ]
      : []),
    {
      id: 'crews',
      label: 'Crews',
      icon: 'people-group',
      hint: 'who does the work; drag a crew onto a task',
      more: listed,
      render: () => (
        <CrewsPanel project={project} gantt={() => ganttApi.current?.instance()} selectedTaskId={selectedTaskId} onShowTasks={(name) => ganttApi.current?.setSearch(name)} />
      ),
    },
    {
      id: 'library',
      label: 'Library',
      icon: 'cubes',
      hint: 'ready-made pieces of plan to drag in',
      more: listed && !hasFloors,
      render: () => (
        <LibraryPanel
          project={project}
          gantt={() => ganttApi.current?.instance()}
          selectedTaskId={selectedTaskId}
          selectedTaskIds={selectedTaskIds}
          library={library}
          saveRequest={saveRequest}
          askPlacement={askPlacement}
          onAsk={
            assistant
              ? (text) => {
                  assistant.startNewThread();
                  void assistant.send(text);
                  setInspectorTab('assistant');
                }
              : undefined
          }
          onDropped={
            assistant
              ? (detail: LibraryDropDetail) => {
                  dropAsked.current = Date.now();
                  const entry = librarySnapshot.entries.find((candidate) => candidate.id === detail.snippet_id);
                  // The other places that look the same are the assistant's idea, so it asks before adding the piece there.
                  void assistant.send(dropMessage(detail, taskName, entry ? isFlatSnippet(entry.snippet) : false), { kind: 'library_drop', detail }, 'text', { approval_mode: 'ask' });
                }
              : undefined
          }
        />
      ),
    },
    {
      id: 'documents',
      label: 'Documents',
      icon: 'folder-open',
      hint: 'quotes, invoices, receipts and photos on this project',
      more: listed,
      render: () => (
        <DocumentsPanel
          project={project}
          files={documents}
          selectedTaskId={selectedTaskId}
          viewerId={session.user.id}
          canViewCosts={canViewCosts}
          nameOf={nameOf}
          onOpen={openDocument}
          onUpload={uploadFile}
          onDelete={deleteFile}
          onShowTask={openTask}
        />
      ),
    },
    {
      id: 'history',
      label: 'History',
      icon: 'clock-rotate-left',
      hint: 'every change and payment, newest first',
      more: listed,
      render: () => (
        <ChangelogPanel
          client={client}
          session={ready}
          workflow={snapshot}
          decisions={assistantDecisions}
          canViewCosts={canViewCosts}
          currency={currency ?? 'USD'}
          onOpenTask={openTask}
          onClose={() => setInspectorTab(null)}
        />
      ),
    },
    ...(hasRental && canViewCosts
      ? [
          {
            id: 'rentals' as const,
            label: 'Rentals',
            icon: 'weight-hanging',
            hint: 'what the rented equipment comes to, and paying for it with PayPal',
            more: listed,
            render: () => rentalsPanel,
          },
        ]
      : []),
  ];
  panelIds.current = inspectorTabs.map((tab) => tab.id);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <span className="app-logo" aria-hidden="true">
            <GantryMark />
          </span>
          <span className="app-wordmark">Gantry</span>
          <span className="app-brand-rule" aria-hidden="true" />
          <ProjectSummary
            projects={projects}
            currentProjectId={load.project.id}
            onOpenProject={hosted ? undefined : openProject}
            name={load.project.name}
            project={project}
            revision={dataVersion}
            canViewCosts={canViewCosts}
            currency={currency}
            alertCount={watch.ready && !listed ? watch.alerts.length : 0}
            onOpenAlerts={() => setInspectorTab('alerts')}
            onAsk={
              assistant
                ? () => {
                    assistant.startNewThread();
                    void assistant.send('What needs attention in the plan?');
                    setInspectorTab('assistant');
                  }
                : undefined
            }
          />
          {rail ? (
            railScript?.auto ? null : <RailBar runner={rail.runner} />
          ) : !guideShown ? null : hosted ? (
            <StoryRail<TryItemView> story={tryStory} anyOrder onShow={showTryItem} onHide={hideGuide} cue={<StartHere shown={startHere} />} />
          ) : (
            story && <StoryRail story={story} onShow={showStoryStep} onHide={hideGuide} />
          )}
        </div>
        <div className="app-header-actions">
          <PlanDate />
          {membership.can_view_costs && currency === null && (
            <span className="app-note" title={`Currency ${load.project.currency} is not supported by the Money module`}>
              Costs unavailable ({load.project.currency})
            </span>
          )}
          {CallLayer && onCall && (
            <Suspense fallback={null}>
              <CallLayer
                projectId={ready.projectId}
                sessionId={ready.sessionId}
                name={profile.displayName}
                color={profile.color ?? fallbackColor(session.user.id)}
                role={CROWD_PEOPLE.find((person) => person.id === session.user.id)?.title ?? membership.role}
                sim={CROWD_PEOPLE.some((person) => person.id === session.user.id)}
                assistant={assistant}
                rail={rail}
                onRemyCall={onRemyCall}
                accessToken={hosted?.accessToken}
                onJoined={hosted ? () => tryThese.mark('call') : undefined}
              />
            </Suspense>
          )}
          <LivePresenceBar session={presence} taskName={taskName} onShowTask={showTasks} />
          {hosted?.copy.joinToken && <InviteButton token={hosted.copy.joinToken} code={hosted.copy.code} />}
          {hosted?.lease && <SessionEnds clock={hosted.lease} />}
          <SyncBadge state={sync} onRetry={onRetrySync} onReload={onRestart} />
          <UserMenu
            name={profile.displayName}
            color={profile.color ?? '#64748b'}
            role={membership.role}
            onSignOut={hosted ? undefined : onSignOut}
            onStartOver={startOver}
            onGuide={
              (story || hosted) && !guideShown
                ? () => {
                    setGuideShown(true);
                    writeFlag(guideKey, null);
                  }
                : undefined
            }
          />
        </div>
      </header>
      {signOutError && (
        <p className="app-banner app-banner-error" role="alert">
          Sign-out failed: {signOutError}
        </p>
      )}
      {fileError && (
        <p className="app-banner app-banner-error" role="alert">
          {fileError}{' '}
          <button type="button" className="button is-link" onClick={() => setFileError(null)}>
            Dismiss
          </button>
        </p>
      )}
      <main className="app-body">
        <div className="workspace-layout">
          <div className="workspace-main">
            <GanttWorkspace
              apiRef={ganttApi}
              layoutKey={listed ? `${session.user.id}:${load.project.id}` : session.user.id}
              hideColumns={listed ? (hasFloors ? ['schedule-when'] : ['schedule-crew', 'schedule-when']) : undefined}
              project={project}
              canViewCosts={canViewCosts}
              decorations={decorations}
              revision={dataVersion}
              currency={currency ?? undefined}
              quiet={listed}
              onSelectionChange={onSelectionChange}
              onEditTask={editTask}
              {...(powerUser ? { onOpenRentals: openRentals, onOpenPayment: openPayment } : {})}
              onShowPanelTab={showPanelTab}
              hasAssistant={Boolean(assistant)}
              onSaveToLibrary={saveToLibrary}
              onWatchTasks={watchTasks}
              onAskAssistant={askAssistantAbout}
              rentals={rentals}
              onOddsAnswered={hosted ? () => tryThese.mark('odds') : undefined}
            />
            {presence && <PresenceLayer session={presence} gantt={gantt} look={ganttLook} />}
          </div>
          <div className="inspector-spot" ref={inspectorSpot} />
          {inspectorPlaced &&
            createPortal(
              <PayApprovalsProvider value={payApprovals}>
                <Inspector tabs={inspectorTabs} active={inspectorTab} onActive={setInspectorTab} />
              </PayApprovalsProvider>,
              inspectorHost,
            )}
        </div>
      </main>
      {/* Someone asks this person to approve a large payout: the request comes up in the middle of the screen. */}
      {canViewCosts && currency && (
        <PayApprovalsProvider value={payApprovals}>
          <PayWindowHost project={project} currency={currency} dataVersion={dataVersion} />
          <ApprovalRequests project={project} currency={currency} />
        </PayApprovalsProvider>
      )}
      {/* The idle tips and their corner marks: not on the walkthrough (it points the way itself) or a voice call. */}
      {!rail && story && guideShown && <StoryCoach step={currentStep(story)} nudge={coachNudge} onShow={showStoryStep} />}
      {/* On the hosted site, the coach points at the "Try these" item at hand. */}
      {hosted && guideShown && <StoryCoach<TryItemView> step={tryCurrent} nudge={coachNudge} onShow={showTryItem} />}
      {/* On a call, the call panel is the walkthrough's call bar, grown (call/CallLayer.tsx). */}
      {rail && !onCall && <RailCall call={rail.call} hand={rail.hand} you={{ name: profile.displayName, color: profile.color ?? '#64748b' }} voice={rail.voice} />}
      {!listed && inspectorTab !== 'alerts' && (
        <AlertToasts
          alerts={watch.fresh}
          runs={watch.freshRuns.filter((run) => run.thread_id && canOpenConversation(run.thread_id))}
          ruleName={(ruleId) => watch.rules.find((rule) => rule.id === ruleId)?.name ?? 'A rule'}
          onShow={(alert) => {
            showTasks(alert.taskIds);
            watch.seen([alert.fingerprint]);
          }}
          onOpen={() => setInspectorTab('alerts')}
          onClose={(alert) => watch.seen([alert.fingerprint])}
          onOpenRun={(run) => {
            watch.seenRun(run.id);
            if (run.thread_id) openConversation(run.thread_id);
          }}
          onCloseRun={(run) => watch.seenRun(run.id)}
        />
      )}
    </div>
  );
}

const roleLabel = (role: MemberRole) => ROLE_LABELS[role];

/** What the thread shows when someone drops a library piece into the plan (the assistant hears the details). */
function dropMessage(detail: LibraryDropDetail, taskName: (taskId: number) => string | null, flat: boolean): string {
  const anchor = detail.anchor_id === null ? null : taskName(detail.anchor_id);
  const parent = detail.parent_id === null ? null : taskName(detail.parent_id);
  const copies = !flat && detail.top_ids.length > 1 ? ` × ${detail.top_ids.length}` : '';
  const where = anchor ? ` after “${anchor}”` : parent ? ` in “${parent}”` : '';
  return `I added “${detail.name}”${copies} from the library${where}.`;
}

/** The avatars, subscribed to presence on their own: pointers and frames must not redraw the workspace. */
function LivePresenceBar({ session, taskName, onShowTask }: { session: PresenceSession | null; taskName(taskId: number): string | null; onShowTask(taskIds: readonly number[]): void }) {
  const snapshot = usePresenceSnapshot(session);
  return <PresenceBar session={session} snapshot={snapshot} roleLabel={roleLabel} taskName={taskName} onShowTask={(taskId) => onShowTask([taskId])} />;
}

/** A per-browser flag (localStorage may be missing or blocked: then nothing is remembered). */
function readFlag(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeFlag(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Not remembered; it still holds for this visit.
  }
}

/**
 * The signed-in person: an avatar that opens their name, role, the hidden steps and sign-out. On the hosted site
 * there is no signing out (the session is the visit's); the copy's owner can start the copy over instead.
 */
function UserMenu({
  name,
  color,
  role,
  onSignOut,
  onStartOver,
  onGuide,
}: {
  name: string;
  color: string;
  role: MemberRole;
  onSignOut?: () => void;
  onStartOver?: () => void;
  onGuide?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, root, () => setOpen(false));
  return (
    <div className="app-user-menu" ref={root}>
      <button
        type="button"
        className={`app-user${open ? ' is-open' : ''}`}
        data-testid="viewer"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${name} · ${ROLE_LABELS[role]}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="app-user-dot" style={{ background: color, color: readableInkOn(color) }} aria-hidden="true">
          {initialsOf(name)}
        </span>
        <span className="visually-hidden">
          {name},{' '}
          <span data-testid="viewer-role" data-role={role}>
            {ROLE_LABELS[role]}
          </span>
        </span>
        <i className="fa fa-chevron-down app-user-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="popover app-user-popover" role="menu" aria-label="Your account">
          <p className="app-user-who">
            <strong>{name}</strong>
            <span>{ROLE_LABELS[role]}</span>
          </p>
          {onGuide && (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              data-testid="show-steps"
              onClick={() => {
                setOpen(false);
                onGuide();
              }}
            >
              <i className="fa fa-list-check" aria-hidden="true" /> Show the steps
            </button>
          )}
          {onStartOver && (
            <StartOverItem
              onStartOver={() => {
                setOpen(false);
                onStartOver();
              }}
            />
          )}
          {onSignOut && (
            <button type="button" role="menuitem" className="menu-item" data-testid="sign-out" onClick={onSignOut}>
              <i className="fa fa-right-from-bracket" aria-hidden="true" /> Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
}
