/**
 * The watch list's server calls (supabase/migrations/*_watch_list.sql, *_watch_triggers.sql): read
 * the rules, the dismissed alerts and the latest runs (members, under RLS), add or change a rule,
 * remove one, dismiss an alert for everyone. Rows are checked against the shared schemas.
 */
import { WatchAction, WatchCondition, WatchDismissalRow, WatchRuleRow, WatchRunRow, WatchScope, WatchTrigger } from '@collab/shared';
import { z } from 'zod';
import type { AssistantClient } from '../assistant/api';

export interface WatchRows {
  rules: WatchRuleRow[];
  dismissals: WatchDismissalRow[];
  /** The latest runs, newest first. */
  runs: WatchRunRow[];
}

/** How many runs the History shows. */
const RUNS_SHOWN = 60;

export async function loadWatch(client: Pick<AssistantClient, 'from'>, projectId: string): Promise<WatchRows> {
  const [rules, dismissals, runs] = await Promise.all([
    client.from('watch_rules').select('*').eq('project_id', projectId).order('created_at', { ascending: true }),
    client.from('watch_dismissals').select('*').eq('project_id', projectId),
    client.from('watch_runs').select('*').eq('project_id', projectId).order('fired_at', { ascending: false }).limit(RUNS_SHOWN),
  ]);
  if (rules.error) throw new Error(`Cannot read the watch list: ${rules.error.message}`);
  if (dismissals.error) throw new Error(`Cannot read the dismissed alerts: ${dismissals.error.message}`);
  if (runs.error) throw new Error(`Cannot read the watch history: ${runs.error.message}`);
  const parsedRules = z.array(WatchRuleRow).safeParse(rules.data ?? []);
  const parsedDismissals = z.array(WatchDismissalRow).safeParse(dismissals.data ?? []);
  const parsedRuns = z.array(WatchRunRow).safeParse(runs.data ?? []);
  if (!parsedRules.success || !parsedDismissals.success || !parsedRuns.success) throw new Error('The watch list came back in an unexpected shape.');
  return { rules: parsedRules.data, dismissals: parsedDismissals.data, runs: parsedRuns.data };
}

async function call<T>(client: AssistantClient, fn: string, args: object, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(error.message.replace(/^[a-z_]+: /, ''));
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`${fn} returned an unexpected shape`);
  return parsed.data;
}

export interface RuleInput {
  id: string | null;
  name: string;
  scope: WatchScope;
  condition: WatchCondition;
  trigger: WatchTrigger;
  action: WatchAction;
  enabled: boolean;
  /** The conversation it was drafted in: what it finds is told there. */
  threadId?: string | null;
}

export function saveRule(client: AssistantClient, projectId: string, rule: RuleInput): Promise<WatchRuleRow> {
  return call(
    client,
    'save_watch_rule',
    {
      p_project: projectId,
      p_rule: rule.id,
      p_name: rule.name,
      p_scope: WatchScope.parse(rule.scope),
      p_condition: WatchCondition.parse(rule.condition),
      p_enabled: rule.enabled,
      p_trigger: WatchTrigger.parse(rule.trigger),
      p_action: WatchAction.parse(rule.action),
      p_thread: rule.threadId ?? null,
    },
    WatchRuleRow,
  );
}

/** A saved rule as the form edits it. */
export function ruleInput(rule: WatchRuleRow): RuleInput {
  return { id: rule.id, name: rule.name, scope: rule.scope, condition: rule.condition, trigger: rule.trigger, action: rule.action, enabled: rule.enabled, threadId: rule.thread_id };
}

export async function deleteRule(client: AssistantClient, ruleId: string): Promise<void> {
  await call(client, 'delete_watch_rule', { p_rule: ruleId }, z.string());
}

export function dismissAlert(client: AssistantClient, ruleId: string, fingerprint: string): Promise<WatchDismissalRow> {
  return call(client, 'dismiss_watch_alert', { p_rule: ruleId, p_fingerprint: fingerprint }, WatchDismissalRow);
}
