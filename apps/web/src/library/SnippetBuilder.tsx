/**
 * The snippet builder: a dialog for making or changing a piece of the library. The piece is a small
 * Bryntum Gantt of its own (SnippetGanttEditor), edited the way the plan is: names, working days,
 * crews and "waits for" in the cells, links by dragging between bars. Above it, the name and one line
 * for the library card; below, the time ranges (shaded bands, laid over the rows selected in the
 * Gantt), what the tasks cost and who is paid, and anything that stops a save, in plain words. Where
 * it is filed and how copies are counted
 * sit by the save button.
 *
 * The builder edits a draft in memory; nothing is saved until "Save to library".
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectModel, ResourceModel } from '@bryntum/gantt';
import { COST_DUE, COST_DUE_WORDS, SNIPPET_RANGE_TONES, SnippetCost, checkSnippet, crewNamesOf, format, leavesOf, money, normalName, scheduleSnippet, type CostDue, type SnippetDraft, type SnippetTask, type SnippetTimeRange } from '@collab/shared';
import { crewColor } from '../gantt/look';
import { newTimeRange, outlineRows, setTimeRanges, type NewRowKind } from './outline';
import { SnippetGanttEditor, type SnippetGanttApi } from './SnippetGanttEditor';
import { TONE_COLORS } from './SnippetTimeline';
import type { LibraryFolder } from './store';
import '../styles/builder.css';
import { ASSISTANT_NAME } from '../assistant/identity';

export interface BuilderCrew {
  name: string;
  color: string;
  company?: string;
}

/**
 * The crews a snippet can name: each trade on the project first (the library names crews by trade, so
 * a piece fits any site; a drop gives the work to a firm of that trade), then each firm by name.
 */
export function builderCrews(project: ProjectModel): BuilderCrew[] {
  const resources = project.resourceStore.allRecords as (ResourceModel & { trade?: string; company?: string })[];
  const trades = new Map<string, { name: string; color: string; firms: string[] }>();
  for (const resource of resources) {
    const trade = (resource.trade ?? '').trim();
    if (!trade) continue;
    const entry = trades.get(normalName(trade)) ?? { name: trade, color: crewColor(resource), firms: [] };
    entry.firms.push(resource.name ?? '');
    trades.set(normalName(trade), entry);
  }
  const firms = resources.map((resource) => ({ name: resource.name ?? '', color: crewColor(resource), company: resource.trade || resource.company || undefined }));
  return [
    ...[...trades.values()].filter((trade) => !firms.some((firm) => normalName(firm.name) === normalName(trade.name))).map((trade) => ({ name: trade.name, color: trade.color, company: trade.firms.length === 1 ? trade.firms[0] : `${trade.firms.length} firms` })),
    ...firms,
  ];
}

export interface SnippetBuilderProps {
  initial: SnippetDraft;
  /** What the dialog is doing, e.g. "New piece of work", "Edit “X-ray room lead lining”". */
  title: string;
  folders: readonly LibraryFolder[];
  folderId: string | null;
  crews: readonly BuilderCrew[];
  /** Set when changing a snippet already in the library ("Save as a copy" appears). */
  existingId?: string;
  onSave(draft: SnippetDraft, folderId: string | null, asCopy: boolean): Promise<void>;
  onClose(): void;
}

const ICONS = [
  'cubes', 'cube', 'layer-group', 'door-open', 'building', 'stairs', 'hammer', 'helmet-safety', 'ruler-combined', 'paint-roller',
  'bolt', 'plug', 'faucet-drip', 'restroom', 'wind', 'temperature-half', 'fire-extinguisher', 'radiation', 'lungs', 'network-wired',
  'wheelchair', 'bed', 'truck', 'clipboard-check', 'key', 'folder-open',
];

type Popover = 'icon' | 'unit' | null;

export function SnippetBuilder({ initial, title, folders, folderId: initialFolder, crews, existingId, onSave, onClose }: SnippetBuilderProps) {
  const [draft, setDraft] = useState<SnippetDraft>(initial);
  const [folderId, setFolderId] = useState<string | null>(initialFolder);
  const [selected, setSelected] = useState<string[]>([]);
  const [popover, setPopover] = useState<Popover>(null);
  const [newRange, setNewRange] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const ganttApi = useRef<SnippetGanttApi>(null);

  const rows = useMemo(() => outlineRows(draft.children), [draft.children]);
  const schedule = useMemo(() => scheduleSnippet(draft), [draft]);
  const problems = useMemo(() => checkSnippet(draft, crews.map((crew) => crew.name)), [draft, crews]);
  const errors = problems.filter((problem) => problem.level === 'error');
  const dirty = draft !== initial || folderId !== initialFolder;
  const leaves = leavesOf(draft.children);
  const critical = leaves.filter((task) => schedule.tasks.get(task.key)?.critical).map((task) => task.name);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (popover) setPopover(null);
      else requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const requestClose = () => {
    if (dirty && !confirmClose) setConfirmClose(true);
    else onClose();
  };

  const save = async (asCopy: boolean) => {
    if (errors.length > 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft, folderId, asCopy);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
    }
  };

  const add = (kind: NewRowKind) => ganttApi.current?.add(kind);

  /** A band over the selected rows: from the start of the first of them to the end of the last. */
  const addBand = () => {
    const placed = selected.filter((key) => schedule.tasks.has(key));
    if (placed.length === 0) return;
    const first = placed.reduce((best, key) => (schedule.tasks.get(key)!.start < schedule.tasks.get(best)!.start ? key : best));
    const last = placed.reduce((best, key) => (schedule.tasks.get(key)!.finish > schedule.tasks.get(best)!.finish ? key : best));
    const range = newTimeRange(draft, first, last);
    setDraft(setTimeRanges(draft, [...(draft.timeRanges ?? []), range]));
    setNewRange(range.key);
  };

  const span = schedule.span;
  const crewCount = crewNamesOf(draft.children).length;
  const ranges = draft.timeRanges ?? [];
  const bandLabel = selected.length > 1 ? `Add a band over the ${selected.length} selected rows` : 'Add a band over the selected row';

  return createPortal(
    <div className="builder-backdrop" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <div className="builder" role="dialog" aria-modal="true" aria-label={title} data-testid="snippet-builder">
        <header className="builder-head">
          <div className="builder-icon-wrap">
            <button type="button" className="builder-icon" aria-label="Choose an icon" aria-expanded={popover === 'icon'} onClick={() => setPopover(popover === 'icon' ? null : 'icon')}>
              <i className={`fa fa-${draft.icon}`} aria-hidden="true" />
            </button>
            {popover === 'icon' && (
              <div className="popover builder-icons" role="listbox" aria-label="Icons">
                {ICONS.map((icon) => (
                  <button
                    key={icon}
                    type="button"
                    role="option"
                    aria-selected={draft.icon === icon}
                    aria-label={icon.replace(/-/g, ' ')}
                    className={draft.icon === icon ? 'is-active' : undefined}
                    onClick={() => {
                      setDraft({ ...draft, icon });
                      setPopover(null);
                    }}
                  >
                    <i className={`fa fa-${icon}`} aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="builder-title">
            <span className="builder-eyebrow">{title}</span>
            <input className="builder-name" value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} aria-label="Name of the piece of work" data-testid="builder-name" />
            <input
              className="builder-summary"
              value={draft.summary}
              maxLength={400}
              placeholder="One line for the library card (optional)"
              onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
              aria-label="What it is, in one line"
            />
          </div>
          <dl className="builder-stats">
            <div>
              <dt>Takes</dt>
              <dd className="num">
                {span} working day{span === 1 ? '' : 's'}
              </dd>
            </div>
            <div>
              <dt>Tasks</dt>
              <dd className="num">{leaves.length}</dd>
            </div>
            <div>
              <dt>Crews</dt>
              <dd className="num">{crewCount}</dd>
            </div>
            <div>
              <dt>Costs</dt>
              <dd className="num" data-testid="builder-cost-total">
                {dollars(leaves.reduce((sum, task) => sum + (task.costs ?? []).reduce((total, cost) => total + cost.amount, 0), 0))}
              </dd>
            </div>
          </dl>
          <button type="button" className="button is-quiet is-icon builder-close" aria-label="Close the builder" onClick={requestClose} data-testid="builder-close">
            <i className="fa fa-xmark" aria-hidden="true" />
          </button>
        </header>

        <div className="builder-toolbar" role="toolbar" aria-label="Rows">
          <div className="builder-tool-group">
            <ToolButton icon="plus" label="Task" onClick={() => add('task')} testId="builder-add-task" />
            <ToolButton icon="folder-plus" label="Group" onClick={() => add('group')} />
            <ToolButton icon="diamond" label="Milestone" onClick={() => add('milestone')} />
          </div>
          <div className="builder-tool-group">
            <ToolButton icon="outdent" label="Out" title="Move out of its group" onClick={() => ganttApi.current?.outdent()} />
            <ToolButton icon="indent" label="In" title="Move into the row above" onClick={() => ganttApi.current?.indent()} />
          </div>
          <div className="builder-tool-group">
            <ToolButton icon="swatchbook" label="Band" title={selected.length > 0 ? bandLabel : 'Select rows first, then lay a band over them'} disabled={selected.length === 0} onClick={addBand} testId="builder-add-band" />
            <ToolButton icon="trash-can" label="Delete" danger disabled={selected.length === 0} onClick={() => ganttApi.current?.remove()} />
          </div>
          <div className="builder-tool-spacer" />
          <p className="builder-legend" aria-label="How to read the timeline">
            <span className="builder-legend-critical" /> sets the length
            <span>columns are working days</span>
          </p>
          <div className="builder-tool-group" aria-label="Zoom the timeline">
            <ToolButton icon="magnifying-glass-minus" title="Zoom out" onClick={() => ganttApi.current?.zoom(-6)} />
            <ToolButton icon="magnifying-glass-plus" title="Zoom in" onClick={() => ganttApi.current?.zoom(6)} />
          </div>
        </div>

        <div className="builder-main">
          <SnippetGanttEditor
            initial={draft}
            crews={crews}
            timeRanges={ranges}
            onChange={(body) => setDraft((current) => ({ ...current, ...body }))}
            onSelect={setSelected}
            apiRef={ganttApi}
          />
        </div>

        <div className="builder-lower">
          <section className="builder-section" aria-label="Time ranges">
            <header>
              <h3 className="section-label">
                <i className="fa fa-swatchbook" aria-hidden="true" /> Bands
              </h3>
              <span className="builder-hint">Shaded on the timeline and tied to tasks, so they move with the work (e.g. “Floor topping drying: keep off”).</span>
            </header>
            {ranges.length === 0 ? (
              <p className="builder-empty">None yet. Select rows in the Gantt, then press Band.</p>
            ) : (
              <ul className="builder-ranges">
                {ranges.map((range) => (
                  <RangeRow
                    key={range.key}
                    range={range}
                    autoFocus={range.key === newRange}
                    rows={rows.map((row) => ({ key: row.task.key, label: `${row.number} ${row.task.name}` }))}
                    onChange={(next) => setDraft(setTimeRanges(draft, ranges.map((item) => (item.key === range.key ? next : item))))}
                    onRemove={() => setDraft(setTimeRanges(draft, ranges.filter((item) => item.key !== range.key)))}
                  />
                ))}
              </ul>
            )}
          </section>
          <CostsSection
            leaves={leaves}
            selected={selected}
            payees={[...new Set([...crews.map((crew) => crew.company ?? crew.name), ...leaves.flatMap((task) => (task.costs ?? []).map((cost) => cost.payee))])]}
            onSetCosts={(key, costs) => ganttApi.current?.setCosts(key, costs)}
          />
          <section className="builder-section builder-checks" aria-label="Checks">
            <header>
              <h3 className="section-label">
                <i className={`fa fa-${errors.length > 0 ? 'circle-exclamation' : 'circle-check'}`} aria-hidden="true" /> {errors.length > 0 ? 'Before you can save' : 'Ready to save'}
              </h3>
            </header>
            {problems.length === 0 ? (
              <p className="builder-empty">
                {critical.length > 0 ? `The length is set by: ${critical.slice(0, 4).join(' → ')}${critical.length > 4 ? ' …' : ''}.` : 'Nothing to fix.'}
              </p>
            ) : (
              <ul className="builder-problems">
                {problems.map((problem, index) => (
                  <li key={index} className={`is-${problem.level}`}>
                    <i className={`fa fa-${problem.level === 'error' ? 'circle-xmark' : 'triangle-exclamation'}`} aria-hidden="true" />
                    <button type="button" onClick={() => problem.key && ganttApi.current?.select(problem.key)}>
                      {problem.message}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <footer className="builder-foot">
          {confirmClose ? (
            <>
              <p className="builder-notice" role="status">
                Close without saving your changes?
              </p>
              <button type="button" className="button" onClick={() => setConfirmClose(false)} data-testid="builder-keep-editing">
                Keep editing
              </button>
              <button type="button" className="button is-danger is-primary" onClick={onClose} data-testid="builder-discard">
                Discard changes
              </button>
            </>
          ) : (
            <>
              <div className="builder-filing">
                <label className="builder-filed">
                  <span>Filed in</span>
                  <select className="input is-sm" value={folderId ?? ''} onChange={(event) => setFolderId(event.target.value || null)}>
                    <option value="">Library (top level)</option>
                    {folderOptions(folders).map(({ folder, depth }) => (
                      <option key={folder.id} value={folder.id}>
                        {`${'  '.repeat(depth)}${folder.name}`}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="builder-unit-wrap">
                  <button type="button" className="button is-link is-sm" aria-expanded={popover === 'unit'} onClick={() => setPopover(popover === 'unit' ? null : 'unit')}>
                    Copies count as {draft.unit.many}
                  </button>
                  {popover === 'unit' && (
                    <div className="popover builder-unit" role="dialog" aria-label="How copies are counted">
                      <p className="builder-hint">When several copies are added at once, the library card says e.g. “3 {draft.unit.many}”.</p>
                      <label className="field">
                        <span className="field-label">One copy is a</span>
                        <input className="input is-sm" value={draft.unit.one} maxLength={30} onChange={(event) => setDraft({ ...draft, unit: { ...draft.unit, one: event.target.value } })} aria-label="One copy covers (singular)" />
                      </label>
                      <label className="field">
                        <span className="field-label">Several are</span>
                        <input className="input is-sm" value={draft.unit.many} maxLength={30} onChange={(event) => setDraft({ ...draft, unit: { ...draft.unit, many: event.target.value } })} aria-label="Several copies (plural)" />
                      </label>
                    </div>
                  )}
                </span>
              </div>
              <p className="builder-notice" role="status">
                {error ?? 'Double-click a task for the full editor · drag from one bar to another to link them'}
              </p>
              <button type="button" className="button" onClick={requestClose}>
                Cancel
              </button>
              {existingId && (
                <button type="button" className="button" disabled={errors.length > 0 || saving} onClick={() => void save(true)}>
                  Save as a copy
                </button>
              )}
              <button type="button" className="button is-primary" disabled={errors.length > 0 || saving} onClick={() => void save(false)} data-testid="builder-save">
                <i className={`fa fa-${saving ? 'spinner fa-spin' : 'cubes'}`} aria-hidden="true" /> {existingId ? 'Save changes' : 'Save to library'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** Whole dollars as money, without cents: "$18,400". */
const dollars = (amount: number) => format(money(amount * 100, 'USD')).replace(/\.00$/, '');

/** One cost line while it is typed: text fields, so a half-typed amount is kept until it is valid. */
interface CostDraft {
  label: string;
  payee: string;
  amount: string;
  due: CostDue;
}

const toDraft = (cost: SnippetCost): CostDraft => ({ label: cost.label, payee: cost.payee, amount: String(cost.amount), due: cost.due });

/** The lines that are complete enough to keep (a label, a payee and a whole amount). */
function validCosts(rows: readonly CostDraft[]): SnippetCost[] {
  return rows.flatMap((row) => {
    const parsed = SnippetCost.safeParse({ label: row.label, payee: row.payee, amount: Number(row.amount.replace(/[$,\s]/g, '')), due: row.due });
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * What the piece costs and who is paid: the selected task's lines to change, or, with no single task
 * selected, the totals by payee. The lines become the task's budget when the piece is dropped, and
 * the payments the assistant works out.
 */
function CostsSection({ leaves, selected, payees, onSetCosts }: { leaves: readonly SnippetTask[]; selected: readonly string[]; payees: readonly string[]; onSetCosts(key: string, costs: SnippetCost[]): void }) {
  const task = selected.length === 1 ? leaves.find((leaf) => leaf.key === selected[0]) : undefined;
  const byPayee = new Map<string, number>();
  for (const leaf of leaves) for (const cost of leaf.costs ?? []) byPayee.set(cost.payee, (byPayee.get(cost.payee) ?? 0) + cost.amount);
  return (
    <section className="builder-section builder-costs" aria-label="Costs" data-testid="builder-costs">
      <header>
        <h3 className="section-label">
          <i className="fa fa-coins" aria-hidden="true" /> Costs
        </h3>
        <span className="builder-hint">{task ? `For “${task.name}”: who is paid, how much and when.` : `They become the tasks’ budgets, and the payments ${ASSISTANT_NAME} works out.`}</span>
      </header>
      {task ? (
        <CostEditor key={task.key} task={task} payees={payees} onChange={(costs) => onSetCosts(task.key, costs)} />
      ) : byPayee.size === 0 ? (
        <p className="builder-empty">None yet. Select a task in the Gantt to add what it costs.</p>
      ) : (
        <ul className="builder-payees">
          {[...byPayee.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([payee, amount]) => (
              <li key={payee}>
                <span>{payee}</span>
                <strong className="num">{dollars(amount)}</strong>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function CostEditor({ task, payees, onChange }: { task: SnippetTask; payees: readonly string[]; onChange(costs: SnippetCost[]): void }) {
  const [rows, setRows] = useState<CostDraft[]>(() => (task.costs ?? []).map(toDraft));
  // The lines as this editor last handed them on. Lines that come back different were changed elsewhere
  // (typed into the Cost cell, say), so the editor takes them up; its own half-typed lines are kept.
  const handedOn = useRef(JSON.stringify(task.costs ?? []));
  useEffect(() => {
    const now = JSON.stringify(task.costs ?? []);
    if (now === handedOn.current) return;
    handedOn.current = now;
    setRows((task.costs ?? []).map(toDraft));
  }, [task.costs]);
  const update = (next: CostDraft[]) => {
    setRows(next);
    const valid = validCosts(next);
    handedOn.current = JSON.stringify(valid);
    onChange(valid);
  };
  const listId = `builder-payees-${task.key}`;
  return (
    <div className="builder-cost-editor">
      {rows.length > 0 && (
        <ul className="builder-cost-rows">
          {rows.map((row, index) => (
            <li key={index} className="builder-cost-row" data-testid="builder-cost-row">
              <input className="input is-sm" value={row.label} maxLength={80} placeholder="What for, e.g. LED panels" aria-label="What the cost is for" onChange={(event) => update(rows.map((item, at) => (at === index ? { ...item, label: event.target.value } : item)))} />
              <input className="input is-sm" value={row.payee} maxLength={80} placeholder="Who is paid" list={listId} aria-label="Who is paid" onChange={(event) => update(rows.map((item, at) => (at === index ? { ...item, payee: event.target.value } : item)))} />
              <span className="builder-cost-amount">
                <span aria-hidden="true">$</span>
                <input className="input is-sm num" value={row.amount} inputMode="numeric" placeholder="0" aria-label="Amount in whole dollars" onChange={(event) => update(rows.map((item, at) => (at === index ? { ...item, amount: event.target.value } : item)))} />
              </span>
              <select className="input is-sm" value={row.due} aria-label="When it is owed" onChange={(event) => update(rows.map((item, at) => (at === index ? { ...item, due: event.target.value as CostDue } : item)))}>
                {COST_DUE.map((due) => (
                  <option key={due} value={due}>
                    {COST_DUE_WORDS[due]}
                  </option>
                ))}
              </select>
              <button type="button" className="button is-quiet is-icon is-sm" aria-label={`Remove ${row.label || 'this cost'}`} onClick={() => update(rows.filter((_, at) => at !== index))}>
                <i className="fa fa-trash-can" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <datalist id={listId}>
        {payees.map((payee) => (
          <option key={payee} value={payee} />
        ))}
      </datalist>
      <button type="button" className="button is-sm" onClick={() => setRows([...rows, { label: '', payee: '', amount: '', due: 'on_completion' }])} disabled={rows.length >= 6} data-testid="builder-add-cost">
        <i className="fa fa-plus" aria-hidden="true" /> Add a cost
      </button>
    </div>
  );
}

function ToolButton({ icon, label, title, onClick, disabled, danger, testId }: { icon: string; label?: string; title?: string; onClick(): void; disabled?: boolean; danger?: boolean; testId?: string }) {
  return (
    <button type="button" className={`button is-quiet is-sm${danger ? ' is-danger' : ''}${label ? '' : ' is-icon'}`} onClick={onClick} disabled={disabled} title={title ?? label} aria-label={title ?? label} data-testid={testId}>
      <i className={`fa fa-${icon}`} aria-hidden="true" />
      {label && <span>{label}</span>}
    </button>
  );
}

/** Folders in outline order with their depth (for a select). */
export function folderOptions(folders: readonly LibraryFolder[]): { folder: LibraryFolder; depth: number }[] {
  const out: { folder: LibraryFolder; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of folders.filter((candidate) => candidate.parentId === parentId).sort((a, b) => a.position - b.position)) {
      out.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function RangeRow({ range, rows, autoFocus, onChange, onRemove }: { range: SnippetTimeRange; rows: { key: string; label: string }[]; autoFocus: boolean; onChange(next: SnippetTimeRange): void; onRemove(): void }) {
  const edge = (which: 'from' | 'to'): ReactNode => (
    <span className="builder-range-edge">
      <select className="input is-sm" value={range[which].edge} aria-label={`${which === 'from' ? 'From' : 'To'}: start or end`} onChange={(event) => onChange({ ...range, [which]: { ...range[which], edge: event.target.value as 'start' | 'end' } })}>
        <option value="start">start of</option>
        <option value="end">end of</option>
      </select>
      <select className="input is-sm" value={range[which].task} aria-label={`${which === 'from' ? 'From' : 'To'}: task`} onChange={(event) => onChange({ ...range, [which]: { ...range[which], task: event.target.value } })}>
        {rows.map((row) => (
          <option key={row.key} value={row.key}>
            {row.label}
          </option>
        ))}
      </select>
    </span>
  );
  return (
    <li className="builder-range">
      <span className="builder-tones" role="radiogroup" aria-label="Color">
        {SNIPPET_RANGE_TONES.map((tone) => (
          <button
            key={tone}
            type="button"
            role="radio"
            aria-checked={(range.tone ?? 'amber') === tone}
            aria-label={tone}
            className={(range.tone ?? 'amber') === tone ? 'is-active' : undefined}
            style={{ background: TONE_COLORS[tone] }}
            onClick={() => onChange({ ...range, tone })}
          />
        ))}
      </span>
      <input
        className="input is-sm builder-range-name"
        value={range.name}
        maxLength={80}
        autoFocus={autoFocus}
        onFocus={(event) => autoFocus && event.currentTarget.select()}
        aria-label="Name of the band"
        onChange={(event) => onChange({ ...range, name: event.target.value })}
      />
      <span className="builder-range-span">
        from {edge('from')} to {edge('to')}
      </span>
      <button type="button" className="button is-quiet is-icon is-sm" aria-label={`Remove ${range.name}`} onClick={onRemove}>
        <i className="fa fa-trash-can" aria-hidden="true" />
      </button>
    </li>
  );
}
