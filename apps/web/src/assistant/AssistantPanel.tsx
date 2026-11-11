/**
 * The Assistant tab of the side panel: a new conversation for each question (a private thread, until
 * its starter invites someone or shares it), and the threads this person can read (the main thread
 * "General" is everyone's). The assistant answers questions about the whole plan (about the
 * selected tasks when there are some), works out numbers exactly, finds problems when asked, drafts
 * changes and library pieces, and draws cards (the problem, tasks, charts,
 * checks, a change to apply, snippet drafts); people answer by typing or with the cards' buttons. It
 * never approves or pays. A drafted change applies the way the person who asked for it chose under
 * the composer (always ask, ask if risky, auto-apply); the approval chain card carries the same
 * buttons as the fix panel, for the person whose turn it is. Task names in its replies are buttons
 * that show the task in the plan.
 *
 * What people do with a card (apply or dismiss a change, save a draft, drop a library piece) is
 * posted to the thread with an action, so every viewer's card shows the same outcome; those messages
 * show as one-line activity rows.
 */
import { Component, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import {
  AGENT_TOOL_WORDS,
  parseCardProps,
  type AgentAction,
  type AgentEditDecisionRow,
  type AgentMessageContext,
  type AgentMessageRow,
  type ApprovalMode,
  type CurrencyCode,
  type SelectedTask,
  type UiComponentName,
} from '@collab/shared';
import { InspectorHeader } from '../inspector/Inspector';
import { markRows } from '../library/drag';
import { ASSISTANT_NAME, AssistantName } from './identity';
import { RemyMark } from './RemyMark';
import { initialsOf, readableInkOn } from '../presence/peers';
import { when } from '../editor/ui';
import type { LibraryStore } from '../library/store';
import { tasksOfCard } from './card-tasks';
import { ChoicesView, IssueCardView, type CardEnv } from './cards';
import { ChangeInvoiceCardView } from './change-invoice-card';
import { ChartCardView, FindingsCardView, FollowUpsView, PlanEditCardView, SnippetsCardView, TaskCardView, TasksCardView, type CardOutcome, type PlanCardEnv } from './plan-cards';
import { Composer } from './Composer';
import { HowToCardView } from './how-to-card';
import { planEntities, RichParagraphs, type RichTextEnv } from './rich-text';
import type { AssistantSession, LiveCard, LiveTurn } from './session';
import { ThreadBar, type ThreadMember } from './ThreadBar';
import { CAPABILITY_ROWS } from './capabilities';
import { CapabilityMarquee } from './CapabilityMarquee';
import type { NextStep } from '../onboarding/story';
import { InvoicesCardView, ReviewCardView, RuleDraftCardView, type RuleCardEnv } from './rule-cards';
import '../styles/assistant.css';

/** How soon after the person's own wheel, touch or key a scroll away from the bottom counts as theirs. */
const SCROLL_INTENT_MS = 800;

export interface AssistantPanelProps {
  session: AssistantSession;
  viewerId: string;
  currency: CurrencyCode;
  nameOf(userId: string | null): string | null;
  colorOf(userId: string | null): string | null;
  /** The live plan the plan cards read (and apply drafted changes to). */
  project: ProjectModel;
  library: LibraryStore | null;
  /** Moves whenever the plan changes. */
  dataVersion: number;
  /** Selects tasks in the plan and brings them into view. */
  showTasks(ids: readonly number[]): void;
  /** Remy's cursor goes to the first of these tasks (a change just applied). */
  pointAt?(ids: readonly number[]): void;
  /** What a card is about: a 3D view goes there if it is open, and the chart stays as it is. */
  followTasks?(ids: readonly number[]): void;
  /** What is selected in the plan now (it goes along with the next message). */
  selected: readonly SelectedTask[];
  /** Project managers may rename and delete any thread. */
  viewerIsPm: boolean;
  /** The project's members: who can be invited into a thread, and who may see costs. */
  members: readonly ThreadMember[];
  /** Shows a crew's work in the plan (a crew named in a reply is a link). */
  showCrew?(name: string): void;
  /** A quieter panel: the one next step, no capability strip, no approval switch (changes always ask). */
  quiet?: boolean;
  /** What a person would do next on this project, offered above the message box. */
  next?: NextStep | null;
  onNext?(step: NextStep): void;
  /** What the rule, review and invoice cards work with. */
  rules?: Pick<RuleCardEnv, 'watch' | 'workflow' | 'controller' | 'client' | 'projectId' | 'gantt' | 'openDocument' | 'payOpeners'>;
  /** The assistant's name on its replies, when the walkthrough gives it one. */
  assistantName?: string;
}


const ACTION_WORDS: Partial<Record<AgentAction['kind'], { icon: string; verb: string }>> = {
  apply_edit: { icon: 'circle-check', verb: 'applied a change' },
  dismiss_edit: { icon: 'circle-minus', verb: 'declined a change' },
  save_snippet: { icon: 'cubes', verb: 'saved to the library' },
  library_drop: { icon: 'cubes', verb: 'added from the library' },
};

/** One card that cannot be drawn stays one card: the thread and the plan around it carry on. */
class CardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.warn('[assistant] could not draw a card', error);
  }

  override render() {
    return this.state.failed ? <p className="ac-muted">This card could not be drawn.</p> : this.props.children;
  }
}

export function useAssistantSnapshot(session: AssistantSession) {
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const read = useCallback(() => session.getSnapshot(), [session]);
  return useSyncExternalStore(subscribe, read, read);
}

const NO_DECISIONS: readonly AgentEditDecisionRow[] = [];

/** The decisions about the assistant's drafted changes, for the changelog (none while the assistant starts). */
export function useAssistantDecisions(session: AssistantSession | null): readonly AgentEditDecisionRow[] {
  const subscribe = useCallback((listener: () => void) => session?.subscribe(listener) ?? (() => undefined), [session]);
  const read = useCallback(() => session?.getSnapshot().decisions ?? NO_DECISIONS, [session]);
  return useSyncExternalStore(subscribe, read, read);
}

interface ShownCard {
  key: string;
  component: string;
  props: unknown;
  partial: boolean;
  /** When its message was written; a card still being written has none. */
  at?: string;
}

export function AssistantPanel({ session, viewerId, currency, nameOf, colorOf, project, library, dataVersion, showTasks, pointAt, followTasks, selected, viewerIsPm, members, showCrew, quiet = false, next = null, onNext, rules, assistantName = ASSISTANT_NAME }: AssistantPanelProps) {
  const snapshot = useAssistantSnapshot(session);
  const { messages, live, sentHere } = snapshot;
  // The plan's task and crew names, linked wherever a reply mentions them (dataVersion: names change).
  const entities = useMemo(() => planEntities(project), [project, dataVersion]);
  const rich: RichTextEnv = { project, showTasks, entities, ...(showCrew ? { showCrew } : {}) };
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** When the person last scrolled the thread themselves (a wheel, a touch, a key, the scrollbar). */
  const scrolledByHand = useRef(0);
  const markScrolled = () => {
    scrolledByHand.current = performance.now();
  };

  // What happened to each card afterwards, from the people's later messages.
  const outcomes = new Map<string, CardOutcome>();
  for (const message of messages) {
    const action = message.action;
    if (!action || !('card_id' in action)) continue;
    const kind = action.kind === 'apply_edit' ? 'applied' : action.kind === 'dismiss_edit' ? 'dismissed' : action.kind === 'save_snippet' ? 'saved' : null;
    if (kind) {
      outcomes.set(action.card_id, {
        kind,
        by: message.author_id === viewerId ? 'you' : (nameOf(message.author_id) ?? 'a member'),
        at: message.created_at,
        ...(kind === 'applied' && message.context?.approval_mode === 'auto' ? { auto: true } : {}),
      });
    }
  }

  // The question each reply answers: the person's message just before it, or the library piece they just dropped.
  const askedBefore = (index: number): AgentMessageRow | null =>
    messages.slice(0, index).reverse().find((earlier) => earlier.role === 'person' && (!earlier.action || earlier.action.kind === 'library_drop')) ?? null;
  // A change applies by itself only in the tab that asked for it since it opened, under the mode it was asked with.
  const autoApplyFor = (index: number): ApprovalMode | null => {
    const asked = askedBefore(index);
    return asked && sentHere.has(asked.id) ? (asked.context?.approval_mode ?? null) : null;
  };

  // An answer to this viewer's own question that lists tasks "to show" selects them in their plan.
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (known.current === null) {
      known.current = new Set(messages.map((message) => message.id));
      return;
    }
    messages.forEach((message, index) => {
      if (known.current!.has(message.id)) return;
      known.current!.add(message.id);
      const asked = messages.slice(0, index).reverse().find((earlier) => earlier.role === 'person');
      // Only an answer to what this tab just asked (not an old one in a thread opened later).
      if (message.role !== 'assistant' || !asked || !sentHere.has(asked.id)) return;
      for (const card of message.cards) {
        const props = card.component === 'show_tasks' ? parseCardProps('show_tasks', card.props) : null;
        if (props?.show_in_plan) showTasks(props.task_ids as number[]);
      }
      // Whatever else the answer is about, a 3D view goes to it.
      const about = message.cards.map((card) => tasksOfCard(card.component, card.props as Record<string, unknown> | null)).find((ids) => ids.length > 0);
      if (about) followTasks?.(about);
    });
  }, [messages, sentHere, showTasks, followTasks]);

  // The newest card of each kind takes clicks; older ones stay as a record. An issue card stops
  // offering to prepare the fix once a change to the plan has been shown after it.
  const newest = new Map<string, string>();
  let fixAfterIssue = false;
  const see = (component: string, key: string) => {
    newest.set(component, key);
    if (component === 'show_issue_card') fixAfterIssue = false;
    if (component === 'show_plan_edit') fixAfterIssue = true;
  };
  for (const message of messages) for (const card of message.cards) see(card.component, `${message.id}:${card.id}`);
  if (live) for (const card of live.cards) see(card.component, `live:${card.id}`);
  if (fixAfterIssue) newest.delete('show_issue_card');

  // Follow the conversation down unless the person scrolled up to read.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });
  // Cards also grow after they render (a change's preview, a chart): keep following them down.
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const follow = () => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
    };
    const observer = new ResizeObserver(follow);
    const watch = () => {
      observer.disconnect();
      for (const child of Array.from(element.children)) observer.observe(child);
    };
    watch();
    const mutations = new MutationObserver(() => {
      watch();
      follow();
    });
    mutations.observe(element, { childList: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);

  // Whatever the viewer sends, the thread follows down to the answer.
  const send = (text: string, action: AgentAction | null = null, context?: Partial<AgentMessageContext>) => {
    pinned.current = true;
    void session.send(text, action, 'text', context);
  };

  const renderCard = (card: ShownCard, key: string, autoApply: ApprovalMode | null = null) => {
    // The thread is a shared conversation: what the assistant says aloud, its cards show to everyone
    // (the fix panel and the Costs tab still keep money to cost viewers).
    const env: CardEnv = { currency, canViewCosts: true, active: newest.get(card.component) === key, partial: card.partial };
    const cardId = (card.key.split(':').at(-1) ?? card.key).slice(0, 64);
    const planEnv: PlanCardEnv = {
      ...env,
      project,
      library,
      dataVersion,
      showTasks,
      ...(pointAt ? { pointAt } : {}),
      send,
      outcome: outcomes.get(cardId) ?? null,
      cardId,
      autoApply,
      bookingOn: (taskId) => rules?.workflow.snapshot?.bookings.find((booking) => booking.task_id === taskId) ?? null,
      markTasks: (ids) => {
        const gantt = rules?.gantt();
        if (!gantt || gantt.isDestroyed) return () => undefined;
        const tasks = ids.map((id) => project.taskStore.getById(id) as TaskModel | undefined).filter((task): task is TaskModel => Boolean(task));
        return markRows(gantt, tasks, 'remy-chart-mark');
      },
    };
    const component = card.component as UiComponentName;
    // A finished card is checked against its schema; a card being written is drawn as it is.
    const props = (card.partial ? card.props : parseCardProps(component, card.props)) as Record<string, unknown> | null;
    if (!props) return null;
    switch (component) {
      case 'show_issue_card':
        return (
          <IssueCardView
            key={card.key}
            card={props}
            env={env}
            {...(tasksOfCard(component, props).length > 0 ? { onShow: () => showTasks(tasksOfCard(component, props)) } : {})}
            onAction={(kind) => {
              followTasks?.(tasksOfCard(component, props));
              const issueId = typeof props.issue_id === 'string' ? props.issue_id : 'issue';
              send(kind === 'prepare_fix' ? 'Yes, prepare the fix.' : 'Not now.', { kind, issue_id: issueId });
            }}
          />
        );
      case 'show_choices':
        return <ChoicesView key={card.key} card={props} env={env} onPick={(reply) => send(reply, { kind: 'choice', card_id: cardId })} />;
      case 'show_tasks':
        return <TasksCardView key={card.key} card={props} env={planEnv} />;
      case 'show_task':
        return <TaskCardView key={card.key} card={props} env={planEnv} />;
      case 'show_chart':
        return <ChartCardView key={card.key} card={props} env={planEnv} />;
      case 'show_findings':
        return <FindingsCardView key={card.key} card={props} env={planEnv} />;
      case 'show_plan_edit':
        return <PlanEditCardView key={card.key} card={props} env={planEnv} />;
      case 'show_snippets':
        return <SnippetsCardView key={card.key} card={props} env={planEnv} />;
      case 'show_how':
        return <HowToCardView key={card.key} card={props} env={env} />;
      case 'suggest_next':
        return <FollowUpsView key={card.key} card={props} env={planEnv} />;
      case 'show_rule_draft':
      case 'show_review':
      case 'show_invoices': {
        if (!rules) return null;
        // These read the live plan, so an older one keeps working.
        const ruleEnv: RuleCardEnv = { ...env, active: true, ...rules, project, threadId: snapshot.threadId, dataVersion, showTasks, ...(followTasks ? { followTasks } : {}) };
        if (component === 'show_rule_draft') return <RuleDraftCardView key={card.key} card={props} env={ruleEnv} />;
        const ruleId = typeof props.rule_id === 'string' ? props.rule_id : null;
        if (!ruleId) return null;
        if (card.partial) return null;
        return component === 'show_review' ? <ReviewCardView key={card.key} ruleId={ruleId} env={ruleEnv} /> : <InvoicesCardView key={card.key} ruleId={ruleId} env={ruleEnv} />;
      }
      case 'show_change_invoice': {
        if (!rules) return null;
        // It follows the invoice recorded on the change, so an older one keeps working; Send waits for a person who sees costs.
        const canSend = members.find((member) => member.userId === viewerId)?.canViewCosts ?? false;
        const liveCost = (ids: readonly number[]) => {
          let sum = 0;
          for (const id of ids) {
            const task = project.taskStore.getById(id) as (TaskModel & { budgetMinor?: number }) | undefined;
            if (!task) return null;
            sum += task.budgetMinor ?? 0;
          }
          return sum;
        };
        return <ChangeInvoiceCardView key={card.key} card={props} env={{ ...env, active: true, watching: env.active, ...rules, showTasks, canSend, liveCost, ...(card.at ? { drawnAt: card.at } : {}) }} />;
      }
      default:
        return null;
    }
  };

  const panel = (
    <div className="inspector-body assistant-panel" data-testid="assistant-panel">
      <InspectorHeader
        mark={<RemyMark motion="still" />}
        title={assistantName}
        subtitle={
          snapshot.status === 'reconnecting'
            ? 'Reconnecting…'
            : live && !live.ending
              ? 'Thinking…'
              : quiet
                ? null
                : 'Answers about the plan, works out the numbers, drafts changes; you apply and approve'
        }
      />
      <>
      <ThreadBar
        threadId={snapshot.threadId}
        draft={snapshot.draft}
        threads={snapshot.threads}
        invited={snapshot.members}
        members={members}
        unread={snapshot.unread}
        busyThread={snapshot.busyThread}
        viewerId={viewerId}
        viewerIsPm={viewerIsPm}
        mentionsAmounts={messages.some((message) => message.role === 'assistant' && /\$\s?\d/.test(message.text))}
        nameOf={nameOf}
        onOpen={(threadId) => {
          pinned.current = true;
          session.openThread(threadId);
        }}
        onNew={() => session.startNewThread()}
        onRename={(threadId, title) => session.renameThread(threadId, title)}
        onDelete={(threadId) => session.deleteThread(threadId)}
        onInvite={(userId, shareCosts) => session.invite(userId, shareCosts)}
        onRemove={(userId) => session.removePerson(userId)}
        onShare={(visibility, shareCosts) => session.setVisibility(visibility, shareCosts)}
      />
      <div
        className="assistant-thread"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          // Back at the bottom: follow again. Away from it: only the person's own scrolling stops the following, never
          // the page moving the thread itself as a reply or a card grows.
          if (atBottom) pinned.current = true;
          else if (performance.now() - scrolledByHand.current < SCROLL_INTENT_MS) pinned.current = false;
        }}
        onWheel={markScrolled}
        onTouchMove={markScrolled}
        onKeyDown={markScrolled}
        onPointerDown={markScrolled}
        data-testid="assistant-thread"
        aria-live="polite"
      >
        {messages.length === 0 && !live && (
          <div className="empty-state assistant-empty">
            <span className="assistant-orb is-large" aria-hidden="true">
              <RemyMark motion="breath" />
            </span>
            <p>
              {quiet
                ? 'Ask about the plan, or tell me what to keep an eye on.'
                : snapshot.draft
                  ? 'Ask about the plan: what sets the handover date, what is wrong with a task, what the costs add up to. Select tasks first to ask about them. This conversation is yours until you invite someone into it.'
                  : snapshot.threadId
                    ? 'Nothing here yet.'
                    : 'The project’s shared thread: everyone in the project reads it.'}
            </p>
            {!quiet && <CapabilityMarquee rows={CAPABILITY_ROWS} onAsk={(prompt) => send(prompt)} />}
          </div>
        )}
        {messages.map((message, index) =>
          message.role === 'person' && message.action && ACTION_WORDS[message.action.kind] ? (
            <ActivityRow key={message.id} message={message} mine={message.author_id === viewerId} nameOf={nameOf} />
          ) : message.role === 'person' ? (
            <PersonMessage key={message.id} message={message} mine={message.author_id === viewerId} nameOf={nameOf} colorOf={colorOf} showTasks={showTasks} />
          ) : (
            <AssistantMessage key={message.id} at={message.created_at} text={message.text} proactive={message.channel === 'app'} rich={rich}>
              {message.cards.map((card) => (
                <CardBoundary key={card.id}>{renderCard({ key: `${message.id}:${card.id}`, component: card.component, props: card.props, partial: false, at: message.created_at }, `${message.id}:${card.id}`, card.component === 'show_plan_edit' ? autoApplyFor(index) : null)}</CardBoundary>
              ))}
            </AssistantMessage>
          ),
        )}
        {live && !(live.ending && !live.text && live.cards.length === 0) && (
          <LiveMessage live={live} nameOf={nameOf} rich={rich}>
            {live.cards.map((card: LiveCard) => (
              <CardBoundary key={card.id}>{renderCard({ key: `live:${card.id}`, component: card.component, props: card.props, partial: true }, `live:${card.id}`)}</CardBoundary>
            ))}
          </LiveMessage>
        )}
      </div>
      {snapshot.error && (
        <p className="note is-danger assistant-error" role="alert">
          <i className="fa fa-circle-exclamation" aria-hidden="true" />
          <span>{snapshot.error}</span>
          <button type="button" className="button is-link" onClick={() => session.dismissError()}>
            Dismiss
          </button>
        </p>
      )}
      {next && !live && !snapshot.sending && (
        <div className="assistant-next" data-testid="assistant-next">
          <button
            type="button"
            className="assistant-next-chip"
            data-testid="assistant-next-chip"
            data-kind={next.kind}
            onClick={() => {
              pinned.current = true;
              onNext?.(next);
            }}
          >
            {next.kind === 'say' ? (
              <RemyMark motion="still" className="remy-inline" />
            ) : (
              <i className={`fa fa-${next.kind === 'library' ? 'cubes' : next.kind === 'finish' ? 'circle-check' : 'arrow-right'}`} aria-hidden="true" />
            )}
            {next.label}
          </button>
        </div>
      )}
      <Composer
        quiet={quiet}
        sending={snapshot.sending}
        selected={selected}
        excluded={snapshot.excluded}
        approvalMode={snapshot.approvalMode}
        onToggleTask={(taskId) => session.toggleExcluded(taskId)}
        onShowTask={(taskId) => showTasks([taskId])}
        onApprovalMode={(mode) => session.setApprovalMode(mode)}
        onSend={(text) => {
          pinned.current = true;
          return session.send(text);
        }}
      />
      </>
    </div>
  );
  return <AssistantName.Provider value={assistantName}>{panel}</AssistantName.Provider>;
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n{2,}/)
        .filter((paragraph) => paragraph.trim())
        .map((paragraph, index) => (
          <p key={index}>{paragraph.trim()}</p>
        ))}
    </>
  );
}

/** A person did something the assistant hears (applied a change, saved a draft, dropped a piece): one quiet line. */
function ActivityRow({ message, mine, nameOf }: { message: AgentMessageRow; mine: boolean; nameOf(id: string | null): string | null }) {
  const words = ACTION_WORDS[message.action!.kind]!;
  return (
    <p className="assistant-activity" data-testid="assistant-activity">
      <i className={`fa fa-${words.icon}`} aria-hidden="true" />
      <span>
        <strong>{nameOf(message.author_id) ?? (mine ? 'You' : 'A member')}</strong> {message.text.replace(/^I /, '').replace(/^(.)/, (first) => first.toLowerCase())}
      </span>
      <time dateTime={message.created_at}>{when(message.created_at)}</time>
    </p>
  );
}

function PersonMessage({
  message,
  mine,
  nameOf,
  colorOf,
  showTasks,
}: {
  message: AgentMessageRow;
  mine: boolean;
  nameOf(id: string | null): string | null;
  colorOf(id: string | null): string | null;
  showTasks(ids: readonly number[]): void;
}) {
  const name = nameOf(message.author_id) ?? 'A member';
  // A person's own color (from presence); without one the avatar falls back to a neutral in the CSS.
  const color = colorOf(message.author_id);
  const about = message.context?.selected_tasks ?? [];
  return (
    <div className={`assistant-msg is-person${mine ? ' is-mine' : ''}`} data-testid="assistant-person-message">
      <span className="assistant-avatar" style={color ? ({ '--who': color, '--who-ink': readableInkOn(color) } as CSSProperties) : undefined} aria-hidden="true">
        {initialsOf(name)}
      </span>
      <div className="assistant-bubble">
        <p className="assistant-meta">
          {/* Everyone by name, this person too (a recording of the call shows who is who); "You" only without a name. */}
          <strong>{mine && name === 'A member' ? 'You' : name}</strong>
          {message.channel === 'voice' && <i className="fa fa-microphone" aria-label="said aloud" />}
          <time dateTime={message.created_at}>{when(message.created_at)}</time>
        </p>
        <Paragraphs text={message.text} />
        {about.length > 0 && (
          <p className="assistant-about">
            <i className="fa fa-arrow-pointer" aria-hidden="true" /> about{' '}
            {about.slice(0, 3).map((task, index) => (
              <span key={task.id}>
                {index > 0 && ', '}
                <button type="button" className="assistant-task-link" onClick={() => showTasks([task.id])}>
                  {task.name}
                </button>
              </span>
            ))}
            {about.length > 3 && ` and ${about.length - 3} more`}
          </p>
        )}
      </div>
    </div>
  );
}

function AssistantMessage({ at, text, proactive, rich, children }: { at: string; text: string; proactive: boolean; rich: RichTextEnv; children: ReactNode }) {
  const name = useContext(AssistantName);
  return (
    <div className="assistant-msg is-assistant" data-testid="assistant-message">
      <span className="assistant-orb" aria-hidden="true">
        <RemyMark motion="still" />
      </span>
      <div className="assistant-body">
        <p className="assistant-meta">
          <strong>{name}</strong>
          {proactive && <span className="pill is-info">noticed</span>}
          <time dateTime={at}>{when(at)}</time>
        </p>
        {text && (
          <div className="assistant-text">
            <RichParagraphs text={text} env={rich} />
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function LiveMessage({ live, nameOf, rich, children }: { live: LiveTurn; nameOf(id: string | null): string | null; rich: RichTextEnv; children: ReactNode }) {
  const working = live.tools.filter((tool) => tool.state === 'start');
  const step = working.at(-1) ?? null;
  const progress = step ? (AGENT_TOOL_WORDS[step.name] ?? 'Working') : live.text ? null : live.kind === 'proactive' ? 'Looking over the plan' : `Thinking about ${firstName(nameOf(live.speakerId)) ?? 'that'}'s question`;
  const name = useContext(AssistantName);
  return (
    <div className="assistant-msg is-assistant is-live" data-testid="assistant-live">
      <span className="assistant-orb is-busy" aria-hidden="true">
        <RemyMark motion="work" />
      </span>
      <div className="assistant-body">
        <p className="assistant-meta">
          <strong>{name}</strong>
          {live.kind === 'proactive' && <span className="pill is-info">noticed</span>}
        </p>
        {progress && !live.ending && (
          <p className="assistant-progress">
            <span className="assistant-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {progress}…
          </p>
        )}
        {live.text && (
          <div className={`assistant-text${live.ending ? '' : ' is-streaming'}`}>
            <RichParagraphs text={live.text} env={rich} />
          </div>
        )}
        {children}
        {live.error && <p className="assistant-error-inline">{live.error}</p>}
      </div>
    </div>
  );
}

const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] ?? null;
