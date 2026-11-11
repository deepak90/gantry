/**
 * The builder's editor: the snippet in a real Bryntum Gantt on its own small project (nothing here
 * touches the live plan). People edit the way they already edit the plan: names and durations in
 * the cells, crews in the crew column, links in the predecessor column ("3FS+2d", a negative lag is a
 * lead) or by dragging between bars, indent and outdent, Bryntum's task editor on double-click, the
 * task menu for adding tasks, subtasks and milestones. The engine lays the snippet out; the time axis
 * counts working days ("Week 1", "Day 3") from a fixed Monday because a snippet has no dates.
 * A task with one cost line takes a new amount right in its Cost cell: a double-click opens a box over
 * the cell, Enter keeps it, Escape leaves it as it was. A task with several lines is changed in the
 * costs below the Gantt, where each line is.
 * Every change is read back into the snippet (snippet-project.ts) and handed to `onChange`.
 */
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { BryntumGantt, type BryntumGanttProps } from '@bryntum/gantt-react';
import { ProjectModel, StringHelper, type AssignmentModel, type Gantt, type ResourceModel, type TaskModel } from '@bryntum/gantt';
import { format, money, scheduleSnippet, type SnippetCost, type SnippetDraft, type SnippetTimeRange } from '@collab/shared';
import { ANCHOR, SnippetTaskModel, costsOf, dateOfWorkingDay, projectDataOf, snippetBodyOf, workingDayIndex, type BuilderCrewColor } from './snippet-project';

export interface SnippetGanttApi {
  add(kind: 'task' | 'group' | 'milestone'): void;
  /** Selects the row of a snippet task and brings it into view. */
  select(key: string): void;
  indent(): void;
  outdent(): void;
  remove(): void;
  zoom(delta: number): void;
  /** Replaces a task's costs (a leaf, by its snippet key). */
  setCosts(key: string, costs: SnippetCost[]): void;
}

export interface SnippetGanttEditorProps {
  /** The snippet as the editor opens; later edits come from the Gantt itself. */
  initial: Pick<SnippetDraft, 'children' | 'links'>;
  crews: readonly BuilderCrewColor[];
  timeRanges: readonly SnippetTimeRange[];
  onChange(body: Pick<SnippetDraft, 'children' | 'links'>): void;
  /** The snippet keys of the selected rows, in plan order. */
  onSelect(keys: string[]): void;
  apiRef?: Ref<SnippetGanttApi>;
}

const dayLabel = (date: Date | string | null | undefined) => (date instanceof Date ? `Day ${workingDayIndex(date) + 1}` : '');

/** A cost being typed into its cell: whose, where the cell is, and what it was. */
interface CostEdit {
  key: string;
  amount: number;
  box: { left: number; top: number; width: number; height: number };
}

/** The box over a Cost cell. Enter or leaving it keeps a whole-dollar amount; Escape keeps what was. */
function CostCellInput({ edit, onDone }: { edit: CostEdit; onDone(amount: number | null): void }) {
  const field = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const finish = (keep: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const amount = Number((field.current?.value ?? '').replace(/[$,\s]/g, ''));
    onDone(keep && Number.isInteger(amount) && amount >= 0 ? amount : null);
  };
  useEffect(() => field.current?.select(), []);
  return createPortal(
    <input
      ref={field}
      className="snippet-cost-input num"
      style={{ left: edit.box.left, top: edit.box.top, width: edit.box.width, height: edit.box.height }}
      defaultValue={String(edit.amount)}
      inputMode="numeric"
      aria-label="What it costs, in whole dollars"
      data-testid="snippet-cost-input"
      autoFocus
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') {
          // Leaves the amount as it was, and keeps the builder open.
          event.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />,
    document.body,
  );
}

function tooltip({ taskRecord }: { taskRecord: TaskModel }): string {
  const start = taskRecord.startDate as Date | null;
  const end = taskRecord.endDate as Date | null;
  const last = end ? new Date(end.getTime() - 1) : null;
  const days = start && end ? workingDayIndex(end) - workingDayIndex(start) : 0;
  return `<div class="snippet-gantt-tip"><strong>${StringHelper.encodeHtml(taskRecord.name ?? '')}</strong><span>${
    taskRecord.isMilestone ? `Milestone on ${dayLabel(start)}` : `${dayLabel(start)} to ${dayLabel(last)} · ${days} working day${days === 1 ? '' : 's'}`
  }</span></div>`;
}

export function SnippetGanttEditor({ initial, crews, timeRanges, onChange, onSelect, apiRef }: SnippetGanttEditorProps) {
  const ganttRef = useRef<BryntumGantt>(null);
  const keys = useRef(new Map<unknown, string>());
  /** The snippet key of a row (rows added here get theirs when the snippet is read back). */
  const keyOf = (record: TaskModel) => keys.current.get(record.id) ?? (typeof record.id === 'string' ? record.id : null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [version, setVersion] = useState(0);
  const [costEdit, setCostEdit] = useState<CostEdit | null>(null);

  const span = useMemo(() => scheduleSnippet(initial).span, []);
  const [project] = useState(() => {
    const data = projectDataOf(initial, crews);
    const model = new ProjectModel({ ...data.project, calendars: data.calendars, taskModelClass: SnippetTaskModel } as never);
    // The editor may close before the load finishes: then nothing is left to schedule.
    model
      .loadInlineData({ tasksData: data.tasks, dependenciesData: data.dependencies, resourcesData: data.resources, assignmentsData: data.assignments } as never)
      .then(() => (model.isDestroyed ? undefined : model.commitAsync()))
      .catch((error: unknown) => {
        if (!model.isDestroyed) console.error('The snippet could not be loaded into the builder', error);
      });
    return model;
  });

  // Every engine pass after an edit: read the snippet back (merged, so a burst of edits reports once).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loaded = false;
    const changed = () => {
      setVersion((value) => value + 1);
      if (!loaded) {
        loaded = true;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => onChangeRef.current(snippetBodyOf(project, keys.current)), 120);
    };
    const detach = project.on('dataReady', changed) as (() => void) | undefined;
    return () => {
      clearTimeout(timer);
      detach?.();
    };
  }, [project]);
  // Destroyed after the editor goes for good (React's development double mount runs this cleanup and
  // mounts again at once: the pending destroy is called off then).
  const pendingDestroy = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (pendingDestroy.current) clearTimeout(pendingDestroy.current);
    return () => {
      pendingDestroy.current = setTimeout(() => {
        if (!project.isDestroyed) project.destroy();
      }, 0);
    };
  }, [project]);

  // The snippet's time ranges, drawn from the tasks they are tied to.
  useEffect(() => {
    const store = (project as unknown as { timeRangeStore: { removeAll(): void; add(records: unknown[]): void } }).timeRangeStore;
    const byKey = new Map<string, TaskModel>();
    for (const task of project.taskStore.allRecords as TaskModel[]) {
      const key = keyOf(task);
      if (key) byKey.set(key, task);
    }
    const edge = (key: string, which: 'start' | 'end') => {
      const value = which === 'start' ? byKey.get(key)?.startDate : byKey.get(key)?.endDate;
      return value instanceof Date ? value : null;
    };
    store.removeAll();
    store.add(
      timeRanges
        .map((range) => {
          const from = edge(range.from.task, range.from.edge);
          const to = edge(range.to.task, range.to.edge);
          if (!from || !to || from.getTime() === to.getTime()) return null;
          const [startDate, endDate] = from < to ? [from, to] : [to, from];
          // The tone goes in a class: Bryntum puts `style` on the band's body only, not on its header label.
          return { id: `range:${range.key}`, name: range.name, startDate, endDate, cls: `snippet-gantt-band snippet-gantt-band-${range.tone ?? 'amber'}` };
        })
        .filter((range) => range !== null),
    );
  }, [project, timeRanges, version]);

  const gantt = (): Gantt | undefined => ganttRef.current?.instance;
  useImperativeHandle(
    apiRef,
    () => ({
      add(kind) {
        const instance = gantt();
        if (!instance) return;
        const selected = (instance.selectedRecord as TaskModel | null) ?? null;
        const data = { name: kind === 'group' ? 'New group' : kind === 'milestone' ? 'New milestone' : 'New task', duration: kind === 'milestone' ? 0 : 1, durationUnit: 'day' };
        void (async () => {
          const root = (project.taskStore as unknown as { rootNode: TaskModel }).rootNode;
          const added = selected ? await instance.addTaskBelow(selected, { data } as never) : ((root as unknown as { appendChild(data: object): TaskModel }).appendChild(data) as TaskModel);
          if (kind === 'group') await instance.addSubtask(added, { data: { name: 'New task', duration: 1, durationUnit: 'day' } } as never);
          await project.commitAsync();
          instance.selectedRecord = added as never;
          void instance.startEditing({ record: added, field: 'name' } as never);
        })();
      },
      select(key) {
        const instance = gantt();
        const record = (project.taskStore.allRecords as TaskModel[]).find((task) => keyOf(task) === key);
        if (!instance || !record) return;
        instance.selectedRecord = record as never;
        void instance.scrollRowIntoView(record as never, { block: 'nearest' } as never);
      },
      indent() {
        const instance = gantt();
        const records = (instance?.selectedRecords ?? []) as TaskModel[];
        if (instance && records.length > 0) void instance.indent(records);
      },
      outdent() {
        const instance = gantt();
        const records = (instance?.selectedRecords ?? []) as TaskModel[];
        if (instance && records.length > 0) void instance.outdent(records);
      },
      remove() {
        const instance = gantt();
        const records = (instance?.selectedRecords ?? []) as TaskModel[];
        if (instance && records.length > 0) project.taskStore.remove(records as never);
      },
      zoom(delta) {
        const instance = gantt() as (Gantt & { tickSize: number }) | undefined;
        if (instance) instance.tickSize = Math.max(16, Math.min(64, instance.tickSize + delta));
      },
      setCosts(key, costs) {
        const record = (project.taskStore.allRecords as TaskModel[]).find((task) => keyOf(task) === key);
        if (!record || !record.isLeaf) return;
        record.set('costs', costs.length > 0 ? costs : null);
        // Costs do not change the schedule, so no engine pass reports them: read the snippet back now.
        setVersion((value) => value + 1);
        onChangeRef.current(snippetBodyOf(project, keys.current));
      },
    }),
    [project],
  );

  const [config] = useState((): BryntumGanttProps => ({
    project,
    startDate: ANCHOR,
    endDate: dateOfWorkingDay(Math.max(10, span + 10)),
    // Weekends are left out of the time axis: every column is a working day.
    workingTime: { fromDay: 1, toDay: 6 },
    viewPreset: {
      id: 'snippet-working-days',
      base: 'weekAndDayLetter',
      tickWidth: 30,
      headers: [
        { unit: 'week', renderer: (start: Date) => `Week ${Math.floor(workingDayIndex(start) / 5) + 1}` },
        { unit: 'day', renderer: (start: Date) => String(workingDayIndex(start) + 1) },
      ],
    },
    rowHeight: 36,
    barMargin: 7,
    // "Waits for" names tasks by their outline number ("2.3FS+1d"), as people read them.
    dependencyIdField: 'wbsCode',
    // Bars in the color of their first crew; neutral without one.
    taskRenderer: ({ taskRecord, renderData }: { taskRecord: TaskModel; renderData: { style: string | Record<string, string> } }) => {
      const crew = (project.assignmentStore.allRecords as AssignmentModel[]).find((assignment) => assignment.event === (taskRecord as unknown))?.resource as ResourceModel | undefined;
      const color = (crew as (ResourceModel & { eventColor?: string }) | undefined)?.eventColor ?? 'var(--cat-none)';
      if (taskRecord.isLeaf && !taskRecord.isMilestone) {
        renderData.style = typeof renderData.style === 'string' ? `${renderData.style};background-color:${color}` : { ...renderData.style, 'background-color': color };
      }
      return '';
    },
    columns: [
      { type: 'wbs', text: '#', width: 56 },
      { type: 'name', text: 'Name', width: 230 },
      { type: 'duration', text: 'Days', width: 92 },
      { type: 'resourceassignment', text: 'Crews', width: 180, showAvatars: false },
      { type: 'predecessor', text: 'Waits for', width: 120 },
      {
        text: 'Cost',
        field: 'costs',
        width: 96,
        align: 'right',
        editor: false,
        sortable: false,
        renderer: ({ record }: { record: TaskModel }) => {
          const total = costsOf(record).reduce((sum, cost) => sum + cost.amount, 0);
          return total > 0 ? format(money(total * 100, 'USD')).replace(/\.00$/, '') : '';
        },
      },
    ] as BryntumGanttProps['columns'],
    // Bars set no dates of their own here: they move only with their links (dragging would pin a date a snippet cannot keep).
    taskDragFeature: false,
    taskEditFeature: {
      items: {
        generalTab: { items: { startDate: false, endDate: false, percentDone: false, effort: false } },
        advancedTab: false,
      },
    },
    criticalPathsFeature: true,
    timeRangesFeature: { showHeaderElements: true },
    projectLinesFeature: false,
    percentBarFeature: false,
    progressLineFeature: false,
    baselinesFeature: false,
    taskTooltipFeature: { template: tooltip as never },
    rowReorderFeature: { showGrip: true },
  }));

  // A double-click on the Cost cell of a task with one cost line opens a box over the cell to type the
  // amount into. (The column itself has no editor: its value is a list of lines, shown as their total.)
  useEffect(() => {
    const instance = gantt();
    if (!instance) return undefined;
    const detach = instance.on('cellDblClick', ({ record, column, cellElement }: { record: TaskModel; column: { field?: string }; cellElement: HTMLElement }) => {
      if (column.field !== 'costs' || !record.isLeaf) return;
      const lines = costsOf(record);
      const key = keyOf(record);
      if (lines.length !== 1 || !key) return;
      const box = cellElement.getBoundingClientRect();
      setCostEdit({ key, amount: lines[0]!.amount, box: { left: box.left, top: box.top, width: box.width, height: box.height } });
    }) as (() => void) | undefined;
    return () => detach?.();
  });

  const finishCostEdit = (amount: number | null) => {
    const edit = costEdit;
    setCostEdit(null);
    if (!edit || amount === null) return;
    const record = (project.taskStore.allRecords as TaskModel[]).find((task) => keyOf(task) === edit.key);
    const line = record ? costsOf(record)[0] : undefined;
    if (!record || !line || line.amount === amount) return;
    record.set('costs', [{ ...line, amount }]);
    // Costs do not change the schedule, so no engine pass reports them: read the snippet back now.
    setVersion((value) => value + 1);
    onChangeRef.current(snippetBodyOf(project, keys.current));
  };

  // Tell the builder which snippet rows are selected (a band can be laid over them).
  useEffect(() => {
    const instance = gantt();
    if (!instance) return undefined;
    const detach = instance.on('selectionChange', () => {
      const store = instance.store as unknown as { indexOf(record: unknown): number };
      const records = ((instance.selectedRecords ?? []) as TaskModel[]).slice().sort((a, b) => store.indexOf(a) - store.indexOf(b));
      onSelectRef.current(records.map(keyOf).filter((key): key is string => key !== null));
    }) as (() => void) | undefined;
    return () => detach?.();
  });

  return (
    <div className="snippet-gantt" data-testid="snippet-gantt">
      <BryntumGantt ref={ganttRef} {...config} />
      {costEdit && <CostCellInput key={costEdit.key} edit={costEdit} onDone={finishCostEdit} />}
    </div>
  );
}
