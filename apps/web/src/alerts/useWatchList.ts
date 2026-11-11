/**
 * The watch list for one open project: the rules, dismissed alerts and latest runs (reloaded whenever
 * the workflow snapshot reloads, which every change to them announces), the alerts the rules raise on
 * the live plan now, and the alerts that appeared since the last look (the toasts). Alerts present
 * when the plan opens are not "new": only what changes while people work springs up. Runs are the
 * assistant service's record of each time a rule spoke up (and the conversation it opened, if any);
 * the ones that arrive while the plan is open with a conversation spring up too.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProjectModel } from '@bryntum/gantt';
import { evaluateWatch, type CurrencyCode, type WatchAlert, type WatchDismissalRow, type WatchPlan, type WatchRuleRow, type WatchRunRow } from '@collab/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssistantClient } from '../assistant/api';
import { engineCommitting, type Decorations } from '../gantt/look';
import { deleteRule, dismissAlert, loadWatch, saveRule, type RuleInput } from './api';
import { watchPlan } from './live';

export interface WatchList {
  ready: boolean;
  rules: readonly WatchRuleRow[];
  /** The latest runs, newest first. */
  runs: readonly WatchRunRow[];
  /** Runs with a conversation that arrived while the plan was open and nobody has opened yet. */
  freshRuns: readonly WatchRunRow[];
  /** The plan as the rules read it now. */
  plan(): WatchPlan;
  /** What needs a look now, most urgent first (dismissed ones left out). */
  alerts: readonly WatchAlert[];
  /** What people declined or dismissed (each until the situation changes). */
  dismissals: readonly WatchDismissalRow[];
  /** Alerts that appeared while the plan was open and nobody has looked at yet. */
  fresh: readonly WatchAlert[];
  error: string | null;
  save(rule: RuleInput): Promise<boolean>;
  remove(ruleId: string): Promise<boolean>;
  dismiss(alert: WatchAlert): Promise<void>;
  /** The person saw the new alerts (opened the list or closed the toast). */
  seen(fingerprints?: readonly string[]): void;
  /** The person saw (or closed) a run's toast. */
  seenRun(runId: string): void;
}

export interface UseWatchListOptions {
  client: SupabaseClient;
  projectId: string;
  /** Changes whenever the workflow snapshot reloads (any change to the rules does that). */
  reloadKey: unknown;
  project: ProjectModel;
  decorations: Decorations;
  /** Moves whenever the plan changes. */
  dataVersion: number;
  canViewCosts: boolean;
  currency: CurrencyCode;
}

const NO_RULES: WatchRuleRow[] = [];
const NO_RUNS: WatchRunRow[] = [];
const SETTLE_MS = 6_000;
const NO_DISMISSALS: WatchDismissalRow[] = [];

export function useWatchList({ client, projectId, reloadKey, project, decorations, dataVersion, canViewCosts, currency }: UseWatchListOptions): WatchList {
  const api = client as unknown as AssistantClient;
  const [rules, setRules] = useState<WatchRuleRow[]>(NO_RULES);
  const [dismissals, setDismissals] = useState<WatchDismissalRow[]>(NO_DISMISSALS);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<WatchAlert[]>([]);
  const [runs, setRuns] = useState<WatchRunRow[]>(NO_RUNS);
  const [freshRuns, setFreshRuns] = useState<WatchRunRow[]>(NO_RUNS);
  /** Runs this tab has seen (the first load counts as seen). */
  const knownRuns = useRef<Set<string> | null>(null);
  /** Every fingerprint this tab has shown. */
  const known = useRef(new Set<string>());
  /** When the rules first arrived: what the plan raises while it settles (decorations, engine) is not "new". */
  const readyAt = useRef<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const rows = await loadWatch(api, projectId);
      setRules(rows.rules);
      setDismissals(rows.dismissals);
      setRuns(rows.runs);
      if (knownRuns.current === null) {
        knownRuns.current = new Set(rows.runs.map((run) => run.id));
      } else {
        const known = knownRuns.current;
        // A run is announced once its conversation is there (the service saves the thread just after the run).
        const arrived = rows.runs.filter((run) => !known.has(run.id) && run.thread_id && run.resolved_at === null);
        for (const run of arrived) known.add(run.id);
        if (arrived.length > 0) setFreshRuns((current) => [...arrived, ...current].slice(0, 3));
      }
      setReady(true);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [api, projectId]);

  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  // A render can land in the middle of an engine commit, when slack cannot be read: the rules keep their
  // last answer and are checked again when the commit ends.
  const committing = engineCommitting(project);
  const [commitsWaited, setCommitsWaited] = useState(0);
  useEffect(() => {
    if (!committing) return undefined;
    let alive = true;
    const done = () => {
      if (alive) setCommitsWaited((count) => count + 1);
    };
    // In the queue: a commit started here could end in the middle of `applyRevisions()`, whose STM refuses
    // that and leaves this client out of sync for good (see RevisionSync.apply).
    void (project as unknown as { queue(step: () => unknown): Promise<unknown> }).queue(() => project.commitAsync()).then(done, done);
    return () => {
      alive = false;
    };
  }, [committing, commitsWaited, project]);
  const lastAlerts = useRef<WatchAlert[]>([]);

  const alerts = useMemo(() => {
    if (!ready) return [];
    if (committing) return lastAlerts.current;
    const dismissed = new Set(dismissals.map((row) => `${row.rule_id}|${row.fingerprint}`));
    try {
      lastAlerts.current = evaluateWatch(rules, watchPlan(project, decorations), { canViewCosts, currency }).filter((alert) => !dismissed.has(`${alert.ruleId}|${alert.fingerprint}`));
      return lastAlerts.current;
    } catch (failure) {
      console.warn('[watch] could not check the rules', failure);
      return [];
    }
  }, [ready, rules, dismissals, project, decorations, dataVersion, canViewCosts, currency, committing, commitsWaited]);

  // What is new since the last evaluation springs up; what was there when the plan opened (or what
  // appears while it settles in its first seconds) does not.
  useEffect(() => {
    if (!ready) return;
    readyAt.current ??= Date.now();
    if (Date.now() - readyAt.current < SETTLE_MS) {
      for (const alert of alerts) known.current.add(alert.fingerprint);
      return;
    }
    const added = alerts.filter((alert) => !known.current.has(alert.fingerprint));
    for (const alert of added) known.current.add(alert.fingerprint);
    const live = new Set(alerts.map((alert) => alert.fingerprint));
    setFresh((current) => {
      const kept = current.filter((alert) => live.has(alert.fingerprint));
      return added.length || kept.length !== current.length ? [...added, ...kept].slice(0, 5) : current;
    });
  }, [alerts, ready]);

  const save = useCallback(
    async (rule: RuleInput) => {
      try {
        await saveRule(api, projectId, rule);
        await reload();
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return false;
      }
    },
    [api, projectId, reload],
  );

  const remove = useCallback(
    async (ruleId: string) => {
      try {
        await deleteRule(api, ruleId);
        await reload();
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return false;
      }
    },
    [api, reload],
  );

  const dismiss = useCallback(
    async (alert: WatchAlert) => {
      setFresh((current) => current.filter((item) => item.fingerprint !== alert.fingerprint));
      try {
        await dismissAlert(api, alert.ruleId, alert.fingerprint);
        await reload();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
    [api, reload],
  );

  const seen = useCallback((fingerprints?: readonly string[]) => {
    setFresh((current) => (fingerprints ? current.filter((alert) => !fingerprints.includes(alert.fingerprint)) : current.length ? [] : current));
  }, []);

  const seenRun = useCallback((runId: string) => setFreshRuns((current) => current.filter((run) => run.id !== runId)), []);

  const plan = useCallback(() => watchPlan(project, decorations), [project, decorations]);

  return { ready, rules, runs, freshRuns, plan, alerts, dismissals, fresh, error, save, remove, dismiss, seen, seenRun };
}
