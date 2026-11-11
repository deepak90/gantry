/**
 * The watch list on the server. The project's rules are checked here, once per change, rather than
 * in each browser, so what a rule does happens once however many people have the plan open:
 *
 *   change   rules that watch every change, after the plan is re-read for a new revision
 *   saved    a rule someone just added or changed, at once (whatever its trigger)
 *   tick     daily rules, once a day when the clock passes their time
 *
 * Each pass opens a run for a situation a rule now raises (false to true) and closes the open runs
 * whose situation is gone; a paused rule's runs close. Titles are worked out without amounts, since
 * every member reads the runs. A rule whose action is "ask the assistant" opens a conversation for
 * its author (one per pass, and at most one every ten minutes per rule, so a plan that keeps moving
 * does not bury them in threads).
 *
 * Passes run one at a time; requests that arrive meanwhile are merged into the next pass, so a burst
 * of revisions is checked once against the latest plan.
 *
 * The rules read the plan on the plan's today (pinned by GANTRY_PLAN_DATE on the hosted site, plan/today.ts); a
 * daily rule still runs at its time on the real clock, once a real day.
 */
import { evaluateWatch, type WatchAlert, type WatchRuleRow, type WatchRunRow } from '@collab/shared';
import type { ProjectStore } from '../data/store';
import type { Logger } from '../log';
import type { PlanSnapshot } from '../plan/snapshot';
import { planDay } from '../plan/today';
import { diffRuns, dueDailyRules, isoDay, watchPlanFrom } from '../plan/watch';

export type WatchReason = 'change' | 'saved' | 'tick';

/** At most one new conversation per rule in this long. */
export const ASK_EVERY_MS = 10 * 60_000;

export interface WatchRunnerOptions {
  projectId: string;
  store: ProjectStore;
  /** The plan as last read. */
  plan(): PlanSnapshot;
  /** Re-reads the plan (a daily check may come long after the last change). */
  refresh?(): Promise<void>;
  log: Logger;
  now?: () => Date;
  /** The plan's today when it is pinned (GANTRY_PLAN_DATE); absent or null: the day it is now. */
  planDate?: string | null;
  /** Opens the conversation a rule asks for about what it found; resolves with its thread id (null: none opened). */
  ask?(rule: WatchRuleRow, found: WatchAlert[]): Promise<string | null>;
}

export class WatchRunner {
  private readonly pending = new Set<WatchReason>();
  private draining: Promise<void> | null = null;
  /** Each rule's `updated_at` as last seen (null before the first pass): a new or changed one is checked once. */
  private seenRules: Map<string, string> | null = null;
  /** The day each daily rule last ran. */
  private readonly lastDaily = new Map<string, string>();
  /** When each rule last opened a conversation. */
  private readonly lastAsked = new Map<string, number>();

  constructor(private readonly options: WatchRunnerOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Asks for a pass; resolves once every pass asked for so far has run. */
  request(reason: WatchReason): Promise<void> {
    this.pending.add(reason);
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /** Resolves when no pass is running or waiting. */
  async whenIdle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      const reasons = new Set(this.pending);
      this.pending.clear();
      try {
        await this.pass(reasons);
      } catch (error) {
        this.options.log.warn('could not check the watch list', error);
      }
    }
  }

  private async pass(reasons: ReadonlySet<WatchReason>): Promise<void> {
    const { store, projectId } = this.options;
    if (!store.loadWatch || !store.insertWatchRun || !store.resolveWatchRuns) return;
    const now = this.now();
    const today = isoDay(now);
    const { rules, open } = await store.loadWatch(projectId);
    const first = this.seenRules === null;
    // Daily rules whose time had passed before the service started speak at their next time.
    if (first) for (const rule of dueDailyRules(rules, now, this.lastDaily)) this.lastDaily.set(rule.id, today);

    const checked = new Map<string, WatchRuleRow>();
    if (reasons.has('change')) for (const rule of rules) if (rule.enabled && rule.trigger.kind === 'change') checked.set(rule.id, rule);
    // On every pass, not only when told a rule was saved: the notice can be lost, and the rule would never speak.
    if (!first) for (const rule of rules) if (rule.enabled && this.seenRules!.get(rule.id) !== rule.updated_at) checked.set(rule.id, rule);
    if (reasons.has('tick')) {
      for (const rule of dueDailyRules(rules, now, this.lastDaily)) {
        checked.set(rule.id, rule);
        this.lastDaily.set(rule.id, today);
      }
    }
    this.seenRules = new Map(rules.map((rule) => [rule.id, rule.updated_at]));

    // A paused rule watches nothing: what it had seen closes.
    const paused = new Set(rules.filter((rule) => !rule.enabled).map((rule) => rule.id));
    const closing = open.filter((run) => paused.has(run.rule_id));
    let fire: WatchAlert[] = [];
    if (checked.size > 0 && reasons.has('tick')) await this.options.refresh?.();
    const plan = this.options.plan();
    if (checked.size > 0 && plan.tasks.length > 0) {
      const alerts = evaluateWatch([...checked.values()], watchPlanFrom(plan, planDay(this.options.planDate, now)), { canViewCosts: false, currency: plan.currency });
      const diff = diffRuns([...checked.values()], alerts, open);
      fire = diff.fire;
      closing.push(...diff.resolve);
    }
    if (closing.length > 0) await store.resolveWatchRuns(closing.map((run) => run.id));

    const opened = new Map<string, { rule: WatchRuleRow; alerts: WatchAlert[]; runs: WatchRunRow[] }>();
    const revision = plan.revision;
    for (const alert of fire) {
      const rule = checked.get(alert.ruleId)!;
      const run = await store.insertWatchRun({
        project_id: projectId,
        rule_id: rule.id,
        situation: alert.situation.slice(0, 200),
        fingerprint: alert.fingerprint.slice(0, 200),
        severity: alert.severity,
        title: alert.title.slice(0, 400),
        detail: alert.detail.slice(0, 1000),
        task_ids: alert.taskIds.slice(0, 50),
        revision: rule.trigger.kind === 'change' ? revision : null,
      });
      if (!run) continue;
      this.options.log.info(`watch: “${rule.name}” spoke up: ${alert.title}`);
      const entry = opened.get(rule.id) ?? { rule, alerts: [], runs: [] };
      entry.alerts.push(alert);
      entry.runs.push(run);
      opened.set(rule.id, entry);
    }

    for (const { rule, alerts, runs } of opened.values()) {
      if (rule.action.kind === 'alert' || !this.options.ask) continue;
      // An invoice is not a conversation that piles up: each finished floor gets its own, at once.
      if (rule.action.kind === 'ask_assistant' && !this.mayAsk(rule, open, now)) continue;
      this.lastAsked.set(rule.id, now.getTime());
      try {
        const threadId = await this.options.ask(rule, alerts);
        if (threadId) await store.setWatchRunThread?.(runs.map((run) => run.id), threadId);
      } catch (error) {
        this.options.log.warn(`could not open a conversation for the watch rule “${rule.name}”`, error);
      }
    }
  }

  /** Whether a rule may open a conversation now: none from it in the last ASK_EVERY_MS (in memory, or an open run's). */
  private mayAsk(rule: WatchRuleRow, open: readonly WatchRunRow[], now: Date): boolean {
    const since = now.getTime() - ASK_EVERY_MS;
    if ((this.lastAsked.get(rule.id) ?? Number.NEGATIVE_INFINITY) > since) return false;
    return !open.some((run) => run.rule_id === rule.id && run.thread_id !== null && Date.parse(run.fired_at) > since);
  }
}
