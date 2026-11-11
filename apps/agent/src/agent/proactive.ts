/**
 * The proactive gate: decides in code, without a model call, whether an app event is worth waking
 * the model for. The model then decides the wording, or still stays quiet.
 *
 * Triggers: a person joins (waits until a meeting is possible: two people, one of whom sees costs),
 * the meeting starts, the plan changes (debounced by the caller). Raising a problem on its own is off
 * unless `raiseIssues` is set (AGENT_PROACTIVE=issues): by default the assistant waits to be asked,
 * and the app's alerts show what it would have raised. Rules that keep
 * it from nagging when it does raise problems:
 *   - one open issue at a time: while a raised issue is unresolved, nothing new is raised;
 *   - an issue is raised once (its fingerprint holds the dates and rate, so a new idle window is new);
 *   - "Not now" snoozes that issue for SNOOZE_MS;
 *   - when people already have a fix on the table for it, the agent leaves it to them;
 *   - nobody present, nobody to talk to.
 */
import type { AgentMessageRow } from '@collab/shared';
import { findIssues, type Issue } from '../plan/detectors';
import { meetingReady, type PlanMember, type PlanSnapshot } from '../plan/snapshot';
import { openProposal, type WorkflowRows } from '../workflow/state';

export type Trigger =
  | { kind: 'meeting_started'; present: PlanMember[] }
  | { kind: 'person_joined'; member: PlanMember; present: PlanMember[] }
  | { kind: 'plan_changed'; revision: number };

export interface GateDecision {
  wake: boolean;
  reason: string;
  issue?: Issue;
}

export const SNOOZE_MS = 30 * 60_000;

export class ProactiveGate {
  /** Issues raised: derived from the thread (assistant messages with an issue card), see syncFrom. */
  private raised = new Set<string>();
  /** Snoozes: "Not now" messages in the thread younger than SNOOZE_MS, plus ones heard just now. */
  private snoozed = new Map<string, number>();
  private heardSnoozes = new Map<string, number>();
  /** Issues whose fix was declined in this conversation (forgotten when the project is reset). */
  private closed = new Set<string>();
  openIssueId: string | null = null;

  private readonly raiseIssues: boolean;

  constructor(
    private readonly now: () => number = Date.now,
    options: { raiseIssues?: boolean } = {},
  ) {
    this.raiseIssues = options.raiseIssues ?? true;
  }

  snooze(issueId: string): void {
    this.heardSnoozes.set(issueId, this.now() + SNOOZE_MS);
    this.snoozed.set(issueId, this.now() + SNOOZE_MS);
    if (this.openIssueId === issueId) this.openIssueId = null;
  }

  /** The model raised this issue (its turn showed the card); the stored reply makes it permanent. */
  markRaised(issueId: string): void {
    this.raised.add(issueId);
    this.openIssueId = issueId;
  }

  /** A declined fix closes the open issue; it stays raised, so it is not brought up again. */
  closeOpenIssue(): void {
    if (this.openIssueId) this.closed.add(this.openIssueId);
    this.openIssueId = null;
  }

  /** Forgets everything (the project was reset). */
  reset(): void {
    this.raised.clear();
    this.snoozed.clear();
    this.heardSnoozes.clear();
    this.closed.clear();
    this.openIssueId = null;
  }

  /**
   * Makes the gate's memory follow the database: an issue counts as raised only while the thread
   * still holds an assistant message with its card, and as snoozed only while a "Not now" for it is
   * younger than SNOOZE_MS. After `pnpm demo:reset` empties the thread, the issue can be raised again.
   */
  syncFrom(messages: readonly AgentMessageRow[]): void {
    const raisedInOrder: string[] = [];
    const snoozed = new Map<string, number>();
    for (const message of messages) {
      if (message.role === 'assistant') {
        for (const card of message.cards) {
          const issueId = card.component === 'show_issue_card' ? (card.props as { issue_id?: unknown } | null)?.issue_id : undefined;
          if (typeof issueId === 'string') raisedInOrder.push(issueId);
        }
      } else if (message.action?.kind === 'not_now') {
        const until = Date.parse(message.created_at) + SNOOZE_MS;
        if (until > this.now()) snoozed.set(message.action.issue_id, Math.max(until, snoozed.get(message.action.issue_id) ?? 0));
      }
    }
    for (const [issueId, until] of this.heardSnoozes) if (until > this.now()) snoozed.set(issueId, Math.max(until, snoozed.get(issueId) ?? 0));
    this.raised = new Set(raisedInOrder);
    this.snoozed = snoozed;
    const latest = [...raisedInOrder].reverse().find((issueId) => !this.closed.has(issueId) && !((snoozed.get(issueId) ?? 0) > this.now()));
    this.openIssueId = latest ?? null;
  }

  decide(trigger: Trigger, plan: PlanSnapshot, workflow: WorkflowRows, present: PlanMember[]): GateDecision {
    if (present.length === 0) return { wake: false, reason: 'nobody is in the meeting' };

    if (!this.raiseIssues) return { wake: false, reason: 'waits to be asked (AGENT_PROACTIVE=off)' };

    const issues = findIssues(plan);
    if (this.openIssueId && !issues.some((issue) => issue.id === this.openIssueId)) this.openIssueId = null;
    if (this.openIssueId) return { wake: false, reason: `an issue is already open (${this.openIssueId})` };

    if (trigger.kind === 'person_joined' && !meetingReady(present)) {
      return { wake: false, reason: 'waiting for a second person, and someone who sees costs' };
    }

    const candidates = issues.filter((issue) => {
      if (!issue.worth_raising || issue.explained_by) return false;
      if (this.raised.has(issue.id)) return false;
      const until = this.snoozed.get(issue.id);
      if (until !== undefined && until > this.now()) return false;
      if (issue.booking_id && openProposal(workflow, issue.booking_id)) return false;
      return true;
    });
    const top = candidates[0];
    if (!top) {
      const already = issues.find((issue) => issue.worth_raising && this.raised.has(issue.id));
      return { wake: false, reason: already ? `already raised: ${already.title}` : 'no issue worth raising' };
    }
    return { wake: true, reason: `worth raising: ${top.title}`, issue: top };
  }
}
