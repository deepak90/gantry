/**
 * The Watch tab: the project's rules about what deserves a look, in three parts.
 *
 * - **Now**: what the rules raise on the live plan at this moment (checked in this browser as the plan
 *   changes). Each alert shows its tasks, hands the question to the assistant, or is dismissed for
 *   everyone; when the assistant already looked into it, its conversation is a click away.
 * - **Rules**: each rule as a sentence, "When the plan changes, if the whole plan has rented equipment
 *   paid while idle, then ask the assistant for alternatives", with how often it spoke up. Anyone adds
 *   a rule (from a recipe, or from scratch); its author or a project manager changes or removes it.
 *   Nothing is watched until someone adds a rule: a fresh plan raises nothing by itself.
 * - **History**: each time a rule spoke up on the server and when it cleared (the assistant service
 *   keeps this record, once per change, however many people have the plan open).
 *
 * AlertToasts is the small stack that springs up when a new alert appears while people work, or when
 * the assistant opened a conversation about one.
 */
import type { ProjectModel, ResourceModel } from '@bryntum/gantt';
import {
  WATCH_CONDITION_WORDS,
  WATCH_RECIPES,
  clockTime,
  conditionWords,
  describeAction,
  describeRule,
  describeTrigger,
  type SelectedTask,
  type WatchAlert,
  type WatchCondition,
  type WatchRecipe,
  type WatchSimpleCondition,
  type WatchSimpleKind,
  type WatchRuleRow,
  type WatchRunRow,
  type WatchScope,
} from '@collab/shared';
import { useEffect, useMemo, useState } from 'react';
import { InspectorHeader } from '../inspector/Inspector';
import { ruleInput, type RuleInput } from './api';
import { isoDay } from './live';
import type { WatchList } from './useWatchList';
import '../styles/alerts.css';
import { ASSISTANT_NAME } from '../assistant/identity';
import { RemyMark } from '../assistant/RemyMark';
import { planClock } from '../plan-clock';

export interface AlertsPanelProps {
  watch: WatchList;
  project: ProjectModel;
  viewerId: string;
  viewerIsPm: boolean;
  /** What is selected in the plan now (a rule can watch it). */
  selected: readonly SelectedTask[];
  /** Hands what someone wrote to the assistant, which turns it into a rule. */
  onDescribe?(text: string): void;
  /** "Watch this task…" from the plan: opens the form on these tasks. */
  prefill: { taskIds: readonly number[]; nonce: number } | null;
  showTasks(ids: readonly number[]): void;
  askAssistant(alert: WatchAlert): void;
  /** Opens one of the assistant's conversations; false when this person cannot see it. */
  canOpenConversation(threadId: string): boolean;
  openConversation(threadId: string): void;
}

type Part = 'now' | 'rules' | 'history';

const SEVERITY_ICON = { high: 'circle-exclamation', medium: 'triangle-exclamation', low: 'circle-info' } as const;

const ago = (iso: string) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const lasted = (from: string, to: string) => {
  const minutes = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
};

export function AlertsPanel({ watch, project, viewerId, viewerIsPm, selected, onDescribe, prefill, showTasks, askAssistant, canOpenConversation, openConversation }: AlertsPanelProps) {
  const [part, setPart] = useState<Part>('now');
  const [editing, setEditing] = useState<RuleInput | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [described, setDescribed] = useState('');
  const taskName = (id: number) => (project.taskStore.getById(id) as { name?: string } | undefined)?.name ?? null;
  const crewName = (id: number) => (project.resourceStore.getById(id) as { name?: string } | undefined)?.name ?? null;
  const ruleOf = (id: string) => watch.rules.find((rule) => rule.id === id);

  // Looking at the list counts as seeing what was new.
  useEffect(() => watch.seen(), [watch.fresh.length]);

  useEffect(() => {
    if (!prefill) return;
    const names = prefill.taskIds.map(taskName).filter(Boolean);
    setPart('rules');
    setEditing({
      id: null,
      name: `Watch ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` and ${names.length - 2} more` : ''}`.slice(0, 120),
      scope: { kind: 'tasks', task_ids: [...prefill.taskIds].slice(0, 50) },
      condition: { kind: 'finish_slip', days: 0 },
      trigger: { kind: 'change' },
      action: { kind: 'alert' },
      enabled: true,
    });
  }, [prefill?.nonce]);

  const canChange = (rule: WatchRuleRow) => rule.created_by === viewerId || viewerIsPm;
  /** The open run (with a conversation) about an alert's situation. */
  const runAbout = (alert: WatchAlert) => watch.runs.find((run) => run.resolved_at === null && run.situation === alert.situation && run.thread_id);
  const newRule = (): RuleInput => ({
    id: null,
    name: '',
    scope: selected.length ? { kind: 'tasks', task_ids: selected.map((task) => task.id).slice(0, 50) } : { kind: 'plan' },
    condition: { kind: 'finish_slip', days: 0 },
    trigger: { kind: 'change' },
    action: { kind: 'alert' },
    enabled: true,
  });
  /** The handover: the plan's last milestone (what the header counts down to). */
  const handoverId = useMemo(() => {
    let best: { id: number; at: number } | null = null;
    for (const task of project.taskStore.allRecords as { id: unknown; isMilestone?: boolean; startDate?: unknown }[]) {
      if (task.isMilestone && typeof task.id === 'number' && task.startDate instanceof Date && (!best || task.startDate.getTime() > best.at)) best = { id: task.id, at: task.startDate.getTime() };
    }
    return best?.id ?? null;
  }, [project, watch.alerts]);
  const recipeScope = (recipe: WatchRecipe): WatchScope => (recipe.forHandover && handoverId !== null ? { kind: 'tasks', task_ids: [handoverId] } : recipe.scope);
  const fromRecipe = (recipe: WatchRecipe): RuleInput => ({ id: null, name: recipe.name, scope: recipeScope(recipe), condition: recipe.condition, trigger: recipe.trigger, action: recipe.action, enabled: true });
  const added = new Set(watch.rules.map((rule) => rule.name));

  return (
    <div className="inspector-body alerts-panel" data-testid="alerts-panel">
      <InspectorHeader
        icon="bell"
        title="Watch"
        subtitle="Rules that keep an eye on the plan while it changes"
        actions={
          <button
            type="button"
            className="button is-sm"
            onClick={() => {
              setPart('rules');
              setEditing(newRule());
            }}
            data-testid="watch-add"
          >
            <i className="fa fa-plus" aria-hidden="true" /> New rule
          </button>
        }
      />
      {onDescribe && (
        <form
          className="watch-describe"
          onSubmit={(event) => {
            event.preventDefault();
            const text = described.trim();
            if (!text) return;
            onDescribe(text);
            setDescribed('');
          }}
        >
          <input className="input" value={described} maxLength={400} placeholder={`Tell ${ASSISTANT_NAME} what to watch for…`} aria-label="What to watch for" onChange={(event) => setDescribed(event.target.value)} data-testid="watch-describe" />
          <button type="submit" className="button is-primary is-icon" disabled={!described.trim()} aria-label="Send">
            <i className="fa fa-arrow-up" aria-hidden="true" />
          </button>
        </form>
      )}
      <div className="segmented watch-parts" role="tablist" aria-label="Watch">
        {(
          [
            ['now', 'Now', watch.alerts.length],
            ['rules', 'Rules', watch.rules.length],
            ['history', 'History', null],
          ] as const
        ).map(([key, label, count]) => (
          <button key={key} type="button" role="tab" aria-selected={part === key} onClick={() => setPart(key)} data-testid={`watch-part-${key}`}>
            {label}
            {count ? <span className="pill is-sm">{count}</span> : null}
          </button>
        ))}
      </div>
      {watch.error && <p className="note is-danger is-sm watch-error">{watch.error}</p>}

      <div className="alerts-scroll">
        {part === 'now' && (
          <section className="alerts-section" aria-label="What needs a look">
            {!watch.ready && <p className="alerts-muted">Reading the watch list…</p>}
            {watch.ready && watch.rules.length === 0 && (
              <div className="empty-state watch-empty">
                <p>
                  <strong>Nothing is watched yet.</strong> A rule speaks up when something you care about happens to the plan: rented equipment standing idle, work running over budget,
                  the handover slipping. It can also ask the assistant to look into it and suggest alternatives.
                </p>
                <button type="button" className="button is-primary is-sm" onClick={() => setPart('rules')} data-testid="watch-start">
                  Add a rule
                </button>
              </div>
            )}
            {watch.ready && watch.rules.length > 0 && watch.alerts.length === 0 && (
              <p className="alerts-empty">
                <i className="fa fa-circle-check" aria-hidden="true" /> Nothing needs a look. {watch.rules.filter((rule) => rule.enabled).length} of {watch.rules.length} rules are watching.
              </p>
            )}
            <ul className="alerts-list">
              {watch.alerts.map((alert) => {
                const run = runAbout(alert);
                return (
                  <li key={`${alert.ruleId}|${alert.fingerprint}`} className={`alert-item is-${alert.severity}`} data-testid="alert-item">
                    <i className={`fa fa-${SEVERITY_ICON[alert.severity]} alert-icon`} aria-hidden="true" />
                    <div className="alert-body">
                      <p className="alert-title">{alert.title}</p>
                      <p className="alert-detail">{alert.detail}</p>
                      <div className="alert-actions">
                        <button type="button" className="button is-sm" onClick={() => showTasks(alert.taskIds)}>
                          <i className="fa fa-crosshairs" aria-hidden="true" /> Show
                        </button>
                        {run?.thread_id && canOpenConversation(run.thread_id) ? (
                          <button type="button" className="button is-sm" onClick={() => openConversation(run.thread_id!)} data-testid="alert-conversation">
                            <i className="fa fa-comments" aria-hidden="true" /> {ASSISTANT_NAME} looked into it
                          </button>
                        ) : (
                          <button type="button" className="button is-sm" onClick={() => askAssistant(alert)} data-testid="alert-ask">
                            <RemyMark motion="still" className="remy-inline" /> Ask {ASSISTANT_NAME}
                          </button>
                        )}
                        <button type="button" className="button is-sm is-quiet" onClick={() => void watch.dismiss(alert)} title="Hide it for everyone until the situation changes" data-testid="alert-dismiss">
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {part === 'rules' && (
          <section className="alerts-section" aria-label="Rules">
            {editing && (
              <RuleForm
                key={editing.id ?? `new:${editing.name}`}
                initial={editing}
                project={project}
                selected={selected}
                onCancel={() => setEditing(null)}
                onSave={async (rule) => {
                  if (await watch.save(rule)) setEditing(null);
                }}
              />
            )}
            {watch.rules.length > 0 && (
              <ul className="watch-rules">
                {watch.rules.map((rule) => {
                  const words = WATCH_CONDITION_WORDS[rule.condition.kind];
                  const raised = watch.alerts.filter((alert) => alert.ruleId === rule.id).length;
                  const runs = watch.runs.filter((run) => run.rule_id === rule.id);
                  return (
                    <li key={rule.id} className={`watch-rule${rule.enabled ? '' : ' is-off'}`} data-testid="watch-rule">
                      <i className={`fa fa-${words.icon} watch-rule-icon`} aria-hidden="true" />
                      <div className="watch-rule-body">
                        <p className="watch-rule-name">
                          {rule.name}
                          {raised > 0 && rule.enabled && <span className="pill is-warning is-sm">{raised} now</span>}
                        </p>
                        <RuleSentence rule={rule} what={describeRule(rule, { task: taskName, crew: crewName })} />
                        <p className="watch-rule-meta">
                          {runs.length === 0 ? 'Has not spoken up yet' : `Spoke up ${runs.length === 1 ? 'once' : `${runs.length} times`}, last ${ago(runs[0]!.fired_at)}`}
                        </p>
                        {confirming === rule.id ? (
                          <p className="watch-rule-confirm">
                            Remove this rule?{' '}
                            <button type="button" className="button is-sm is-danger is-primary" onClick={() => void watch.remove(rule.id).then(() => setConfirming(null))}>
                              Remove
                            </button>
                            <button type="button" className="button is-link" onClick={() => setConfirming(null)}>
                              Keep
                            </button>
                          </p>
                        ) : (
                          canChange(rule) && (
                            <p className="watch-rule-actions">
                              <button
                                type="button"
                                className="switch"
                                role="switch"
                                aria-checked={rule.enabled}
                                aria-label={rule.enabled ? `Pause “${rule.name}”` : `Turn “${rule.name}” back on`}
                                onClick={() => void watch.save({ ...ruleInput(rule), enabled: !rule.enabled })}
                              >
                                <span />
                              </button>
                              <span className="watch-rule-state">{rule.enabled ? 'On' : 'Paused'}</span>
                              <button type="button" className="button is-link" onClick={() => setEditing(ruleInput(rule))}>
                                Change
                              </button>
                              <button type="button" className="button is-link" onClick={() => setConfirming(rule.id)}>
                                Remove
                              </button>
                            </p>
                          )
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <h3 className="section-label alerts-heading">Recipes</h3>
            <p className="alerts-muted">Rules other teams keep. Add one as it is, or adjust it first.</p>
            <ul className="watch-recipes">
              {WATCH_RECIPES.map((recipe) => (
                <li key={recipe.key} className="watch-recipe" data-testid="watch-recipe">
                  <div className="watch-recipe-text">
                    <strong>{recipe.name}</strong>
                    <span>{recipe.why}</span>
                    <RuleSentence rule={recipe} what={describeRule({ ...recipe, scope: recipeScope(recipe) }, { task: taskName, crew: crewName })} />
                  </div>
                  <div className="watch-recipe-actions">
                    <button type="button" className="button is-sm" disabled={added.has(recipe.name)} onClick={() => void watch.save(fromRecipe(recipe))} data-testid={`watch-recipe-add-${recipe.key}`}>
                      {added.has(recipe.name) ? 'Added' : 'Add'}
                    </button>
                    <button type="button" className="button is-link" onClick={() => setEditing(fromRecipe(recipe))}>
                      Adjust
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {part === 'history' && (
          <section className="alerts-section" aria-label="History">
            {watch.runs.length === 0 ? (
              <p className="alerts-muted">Nothing has spoken up yet. Each time a rule does, it is kept here, with the conversation {ASSISTANT_NAME} opened about it.</p>
            ) : (
              <ul className="watch-history">
                {watch.runs.map((run) => (
                  <HistoryItem key={run.id} run={run} rule={ruleOf(run.rule_id)} showTasks={showTasks} canOpen={run.thread_id ? canOpenConversation(run.thread_id) : false} open={openConversation} />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/** "When the plan changes, if the whole plan: rented equipment paid while idle, then ask the assistant for alternatives." */
function RuleSentence({ rule, what }: { rule: Pick<WatchRuleRow, 'trigger' | 'action'>; what: string }) {
  const when = rule.trigger.kind === 'change' ? 'the plan changes' : `it is ${clockTime(rule.trigger.at)}, every day`;
  const then = describeAction(rule.action).replace(/^\w/, (letter) => letter.toLowerCase());
  return (
    <p className="watch-sentence" title={`${describeTrigger(rule.trigger)}. ${describeAction(rule.action)}.`}>
      <span className="watch-word">When</span> {when}, <span className="watch-word">if</span> {what}, <span className="watch-word">then</span> {then}
    </p>
  );
}

function HistoryItem({ run, rule, showTasks, canOpen, open }: { run: WatchRunRow; rule: WatchRuleRow | undefined; showTasks(ids: readonly number[]): void; canOpen: boolean; open(threadId: string): void }) {
  return (
    <li className={`watch-run is-${run.severity}${run.resolved_at ? ' is-cleared' : ''}`} data-testid="watch-run">
      <i className={`fa fa-${run.resolved_at ? 'circle-check' : SEVERITY_ICON[run.severity]} alert-icon`} aria-hidden="true" />
      <div className="alert-body">
        <p className="alert-title">{run.title}</p>
        <p className="alert-detail">
          {rule?.name ?? 'A removed rule'} · {ago(run.fired_at)}
          {run.resolved_at ? ` · cleared after ${lasted(run.fired_at, run.resolved_at)}` : ' · still on'}
        </p>
        <div className="alert-actions">
          {run.task_ids.length > 0 && (
            <button type="button" className="button is-sm" onClick={() => showTasks(run.task_ids)}>
              <i className="fa fa-crosshairs" aria-hidden="true" /> Show
            </button>
          )}
          {run.thread_id && canOpen && (
            <button type="button" className="button is-sm" onClick={() => open(run.thread_id!)}>
              <i className="fa fa-comments" aria-hidden="true" /> Open the conversation
            </button>
          )}
          {run.thread_id && !canOpen && <span className="alerts-muted">{ASSISTANT_NAME} answered its author privately.</span>}
        </div>
      </div>
    </li>
  );
}

// ---- the rule form: a sentence ------------------------------------------------------------------

const CONDITIONS: WatchSimpleKind[] = ['finish_slip', 'start_slip', 'starts_soon', 'slack_below', 'over_budget', 'spent_ahead', 'in_window', 'idle_rental', 'crew_overbooked', 'all_done'];

function defaultCondition(kind: WatchSimpleKind, today: string): WatchSimpleCondition {
  switch (kind) {
    case 'finish_slip':
    case 'start_slip':
      return { kind, days: 0 };
    case 'starts_soon':
      return { kind, days: 5 };
    case 'slack_below':
      return { kind, days: 3 };
    case 'over_budget':
      return { kind, percent: 10 };
    case 'spent_ahead':
      return { kind, points: 20 };
    case 'in_window':
      return { kind, from: today, to: today };
    case 'idle_rental':
    case 'crew_overbooked':
    case 'all_done':
      return { kind };
  }
}

function RuleForm({
  initial,
  project,
  selected,
  onCancel,
  onSave,
}: {
  initial: RuleInput;
  project: ProjectModel;
  selected: readonly SelectedTask[];
  onCancel(): void;
  onSave(rule: RuleInput): Promise<void>;
}) {
  const [rule, setRule] = useState<RuleInput>(initial);
  const [busy, setBusy] = useState(false);
  const today = isoDay(planClock.now());
  const crews = useMemo(() => (project.resourceStore.records as ResourceModel[]).filter((crew) => typeof crew.id === 'number'), [project]);
  const scopeTasks = rule.scope.kind === 'tasks' ? rule.scope.task_ids : [];
  const taskNames = scopeTasks.map((id) => (project.taskStore.getById(id) as { name?: string } | undefined)?.name ?? `Task ${id}`);
  const setScope = (scope: WatchScope) => setRule((current) => ({ ...current, scope }));
  const setCondition = (condition: WatchCondition) => setRule((current) => ({ ...current, condition }));
  const condition = rule.condition;
  const suggested = `${WATCH_CONDITION_WORDS[condition.kind].label}${rule.scope.kind === 'tasks' ? `: ${taskNames.slice(0, 2).join(', ')}` : ''}`.slice(0, 120);
  const valid =
    (rule.scope.kind !== 'tasks' || rule.scope.task_ids.length > 0) &&
    (rule.scope.kind !== 'dates' || rule.scope.from <= rule.scope.to) &&
    (condition.kind !== 'in_window' || condition.from <= condition.to);

  const number = (value: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(value) || 0)));

  return (
    <form
      className="card rule-form"
      data-testid="watch-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || busy) return;
        setBusy(true);
        void onSave({ ...rule, name: rule.name.trim() || suggested }).finally(() => setBusy(false));
      }}
    >
      <fieldset>
        <legend className="rule-word">When</legend>
        <div className="segmented" role="radiogroup" aria-label="When to check">
          <button type="button" role="radio" aria-checked={rule.trigger.kind === 'change'} onClick={() => setRule((current) => ({ ...current, trigger: { kind: 'change' } }))}>
            The plan changes
          </button>
          <button type="button" role="radio" aria-checked={rule.trigger.kind === 'daily'} onClick={() => setRule((current) => ({ ...current, trigger: { kind: 'daily', at: '07:00' } }))} data-testid="watch-daily">
            Every day
          </button>
        </div>
        {rule.trigger.kind === 'daily' && (
          <div className="rule-row">
            <span>at</span>
            <input type="time" className="input" value={rule.trigger.at} aria-label="Time of day" onChange={(event) => event.target.value && setRule((current) => ({ ...current, trigger: { kind: 'daily', at: event.target.value.slice(0, 5) } }))} />
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend className="rule-word">Watch</legend>
        <div className="rule-choices">
          <label>
            <input type="radio" checked={rule.scope.kind === 'plan'} onChange={() => setScope({ kind: 'plan' })} /> The whole plan
          </label>
          <label title={selected.length ? '' : 'Select tasks in the plan first'}>
            <input
              type="radio"
              checked={rule.scope.kind === 'tasks'}
              disabled={selected.length === 0 && rule.scope.kind !== 'tasks'}
              onChange={() => setScope({ kind: 'tasks', task_ids: selected.map((task) => task.id).slice(0, 50) })}
            />{' '}
            {rule.scope.kind === 'tasks' ? `${taskNames.slice(0, 2).join(', ')}${taskNames.length > 2 ? ` +${taskNames.length - 2}` : ''} (and what is under them)` : `The selected tasks (${selected.length})`}
          </label>
          <label>
            <input type="radio" checked={rule.scope.kind === 'dates'} onChange={() => setScope({ kind: 'dates', from: today, to: today })} /> Work between two dates
          </label>
          <label>
            <input type="radio" checked={rule.scope.kind === 'crew'} disabled={crews.length === 0} onChange={() => setScope({ kind: 'crew', resource_ids: [crews[0]!.id as number] })} /> A crew
          </label>
        </div>
        {rule.scope.kind === 'tasks' && selected.length > 0 && (
          <button type="button" className="button is-link" onClick={() => setScope({ kind: 'tasks', task_ids: selected.map((task) => task.id).slice(0, 50) })}>
            Use the tasks selected now ({selected.length})
          </button>
        )}
        {rule.scope.kind === 'dates' && (
          <div className="rule-row">
            <input type="date" className="input" value={rule.scope.from} aria-label="From" onChange={(event) => setScope({ kind: 'dates', from: event.target.value, to: (rule.scope as { to: string }).to })} />
            <span>to</span>
            <input type="date" className="input" value={rule.scope.to} aria-label="To" onChange={(event) => setScope({ kind: 'dates', from: (rule.scope as { from: string }).from, to: event.target.value })} />
          </div>
        )}
        {rule.scope.kind === 'crew' && (
          <select className="input" value={rule.scope.resource_ids[0]} aria-label="Crew" onChange={(event) => setScope({ kind: 'crew', resource_ids: [Number(event.target.value)] })}>
            {crews.map((crew) => (
              <option key={crew.id as number} value={crew.id as number}>
                {crew.name}
              </option>
            ))}
          </select>
        )}
      </fieldset>

      <fieldset>
        <legend className="rule-word">If</legend>
        {condition.kind === 'any' || condition.kind === 'all' ? (
          <p className="rule-row">{condition.of.map((part) => conditionWords(part)).join(condition.kind === 'any' ? ' or ' : ' and ')}</p>
        ) : (
          <select className="input" value={condition.kind} aria-label="Condition" onChange={(event) => setCondition(defaultCondition(event.target.value as WatchSimpleKind, today))} data-testid="watch-condition">
            {CONDITIONS.map((kind) => (
              <option key={kind} value={kind}>
                {WATCH_CONDITION_WORDS[kind].label}
              </option>
            ))}
          </select>
        )}
        {(condition.kind === 'finish_slip' || condition.kind === 'start_slip') && (
          <div className="rule-row">
            <span>by more than</span>
            <input type="number" className="input" min={0} max={365} value={condition.days} aria-label="Days" onChange={(event) => setCondition({ kind: condition.kind, days: number(event.target.value, 0, 365) })} />
            <span>days</span>
          </div>
        )}
        {condition.kind === 'starts_soon' && (
          <div className="rule-row">
            <span>within</span>
            <input type="number" className="input" min={0} max={90} value={condition.days} aria-label="Days" onChange={(event) => setCondition({ kind: 'starts_soon', days: number(event.target.value, 0, 90) })} />
            <span>days</span>
          </div>
        )}
        {condition.kind === 'slack_below' && (
          <div className="rule-row">
            <span>under</span>
            <input type="number" className="input" min={0} max={60} value={condition.days} aria-label="Days" onChange={(event) => setCondition({ kind: 'slack_below', days: number(event.target.value, 0, 60) })} />
            <span>working days of slack</span>
          </div>
        )}
        {condition.kind === 'over_budget' && (
          <div className="rule-row">
            <span>by</span>
            <input type="number" className="input" min={0} max={1000} value={condition.percent} aria-label="Percent" onChange={(event) => setCondition({ kind: 'over_budget', percent: number(event.target.value, 0, 1000) })} />
            <span>% or more</span>
          </div>
        )}
        {condition.kind === 'spent_ahead' && (
          <div className="rule-row">
            <span>money spent ahead of the work by</span>
            <input type="number" className="input" min={0} max={100} value={condition.points} aria-label="Points" onChange={(event) => setCondition({ kind: 'spent_ahead', points: number(event.target.value, 0, 100) })} />
            <span>points</span>
          </div>
        )}
        {condition.kind === 'in_window' && (
          <div className="rule-row">
            <input type="date" className="input" value={condition.from} aria-label="From" onChange={(event) => setCondition({ kind: 'in_window', from: event.target.value, to: condition.to })} />
            <span>to</span>
            <input type="date" className="input" value={condition.to} aria-label="To" onChange={(event) => setCondition({ kind: 'in_window', from: condition.from, to: event.target.value })} />
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend className="rule-word">Then</legend>
        <div className="segmented" role="radiogroup" aria-label="What happens">
          <button type="button" role="radio" aria-checked={rule.action.kind === 'alert'} onClick={() => setRule((current) => ({ ...current, action: { kind: 'alert' } }))}>
            Show it
          </button>
          <button type="button" role="radio" aria-checked={rule.action.kind === 'ask_assistant'} onClick={() => setRule((current) => ({ ...current, action: { kind: 'ask_assistant' } }))} data-testid="watch-then-assistant">
            <RemyMark motion="still" className="remy-inline" /> Ask {ASSISTANT_NAME}
          </button>
          <button type="button" role="radio" aria-checked={rule.action.kind === 'prepare_invoice'} onClick={() => setRule((current) => ({ ...current, action: { kind: 'prepare_invoice' } }))}>
            <i className="fa fa-file-invoice-dollar" aria-hidden="true" /> Prepare an invoice
          </button>
        </div>
        {rule.action.kind === 'ask_assistant' && (
          <label className="field">
            <span className="field-label">What should it look for? (optional)</span>
            <textarea
              className="input"
              rows={2}
              maxLength={400}
              value={rule.action.note ?? ''}
              placeholder="e.g. Suggest cheaper ways to do the work, or which supplier to talk to"
              onChange={(event) => setRule((current) => ({ ...current, action: event.target.value ? { kind: 'ask_assistant', note: event.target.value } : { kind: 'ask_assistant' } }))}
            />
            <span className="alerts-muted">It opens a new conversation for you each time the situation appears, and suggests alternatives.</span>
          </label>
        )}
      </fieldset>

      <label className="field">
        <span className="field-label">Name</span>
        <input className="input" value={rule.name} maxLength={120} placeholder={suggested} onChange={(event) => setRule((current) => ({ ...current, name: event.target.value }))} data-testid="watch-name" />
      </label>

      <div className="rule-buttons">
        <button type="submit" className="button is-sm is-primary" disabled={!valid || busy} data-testid="watch-save">
          {rule.id ? 'Save the rule' : 'Start watching'}
        </button>
        <button type="button" className="button is-link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---- new alerts, springing up --------------------------------------------------------------------

export function AlertToasts({
  alerts,
  runs,
  ruleName,
  onShow,
  onOpen,
  onClose,
  onOpenRun,
  onCloseRun,
}: {
  alerts: readonly WatchAlert[];
  /** Runs the assistant opened a conversation about. */
  runs: readonly WatchRunRow[];
  ruleName(ruleId: string): string;
  onShow(alert: WatchAlert): void;
  onOpen(): void;
  onClose(alert: WatchAlert): void;
  onOpenRun(run: WatchRunRow): void;
  onCloseRun(run: WatchRunRow): void;
}) {
  if (alerts.length === 0 && runs.length === 0) return null;
  return (
    <div className="alert-toasts" role="status" aria-live="polite" data-testid="alert-toasts">
      {runs.slice(0, 2).map((run) => (
        <div key={run.id} className={`alert-toast is-${run.severity} is-assistant`} data-testid="run-toast">
          <RemyMark motion="still" className="remy-inline alert-icon" />
          <div className="alert-body">
            <p className="alert-kicker">Watch · {ruleName(run.rule_id)}</p>
            <p className="alert-title">{run.title}</p>
            <p className="alert-detail">{ASSISTANT_NAME} is looking into it and suggesting alternatives.</p>
            <div className="alert-actions">
              <button type="button" className="button is-sm is-primary" onClick={() => onOpenRun(run)}>
                Open the conversation
              </button>
            </div>
          </div>
          <button type="button" className="button is-quiet is-sm is-icon alert-toast-close" aria-label="Close" onClick={() => onCloseRun(run)}>
            <i className="fa fa-xmark" aria-hidden="true" />
          </button>
        </div>
      ))}
      {alerts.slice(0, 3 - Math.min(2, runs.length)).map((alert) => (
        <div key={alert.fingerprint} className={`alert-toast is-${alert.severity}`} data-testid="alert-toast">
          <i className={`fa fa-${SEVERITY_ICON[alert.severity]} alert-icon`} aria-hidden="true" />
          <div className="alert-body">
            <p className="alert-kicker">Watch · {alert.ruleName}</p>
            <p className="alert-title">{alert.title}</p>
            <div className="alert-actions">
              <button type="button" className="button is-sm" onClick={() => onShow(alert)}>
                Show
              </button>
              <button type="button" className="button is-sm is-quiet" onClick={onOpen}>
                Open Watch
              </button>
            </div>
          </div>
          <button type="button" className="button is-quiet is-sm is-icon alert-toast-close" aria-label="Close" onClick={() => onClose(alert)}>
            <i className="fa fa-xmark" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
