/**
 * The task tab of the side panel: everything about the selected task, edited in place, with the
 * fields of Bryntum's own task editor. A header (where it sits, its name, state and crews) over
 * tabs: Details (dates, progress, deadline, color, parts), Scheduling (Bryntum's Advanced tab:
 * manually scheduled, effort, constraint, mode, calendar...), Links (predecessors and successors),
 * Crew, Equipment (each machine with its own dates), Costs (budget, forecast and payments; cost
 * viewers only) and Notes. The rule: what can be done to a task on the chart or in a cell can be
 * done from here, because in the 3D view this panel is the only way to do it.
 *
 * Every field saves on its own when committed, as one short transaction (one change for the other
 * person); nothing holds the project queue while the panel is open, so the other person's changes
 * keep arriving and show here live. When the task disappears (the other person removed it) the
 * panel says so calmly instead of editing a detached record.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import type { CurrencyCode } from '@collab/shared';
import { NO_DECORATIONS, type Decorations } from '../gantt/look';
import type { RentalPayEnv } from '../editor/PayRental';
import type { WorkflowSnapshot } from '../workflow/api';
import { InspectorHeader } from './Inspector';
import { CrewTab } from './task/CrewTab';
import { DetailsTab } from './task/DetailsTab';
import { EquipmentTab } from './task/EquipmentTab';
import { LinksTab } from './task/LinksTab';
import { findTask, taskView } from './task/model';
import { CostsTab } from './task/CostsTab';
import { HeldNotice, PayGateCard } from './task/PayGateCard';
import { FilesTab } from './task/FilesTab';
import type { FileItem, FileKind } from './DocumentList';
import { NotesTab } from './task/NotesTab';
import { SchedulingTab } from './task/SchedulingTab';
import { taskPaymentFacts } from './task/payments';
import { TaskHeader } from './task/TaskHeader';
import { TaskPanelProvider, useEditRunner, type TaskPanelContext } from './task/ui';
import '../styles/task-inspector.css';

export interface TaskInspectorProps {
  project: ProjectModel;
  taskId: number | null;
  /** Moves with every engine result (local edits and applied revisions). */
  dataVersion: number;
  canViewCosts: boolean;
  /** Currency of the task money fields. */
  currency?: CurrencyCode;
  /** The proposal workflow (rental, fix, PayPal payment), for the money tab. */
  workflow?: WorkflowSnapshot | null;
  /** What the workflow draws on bars (rental, fix and payment badges). */
  decorations?: Decorations;
  /** Shows another task here (and selects it in the plan): linked tasks are one click away. */
  onOpenTask?: (taskId: number) => void;
  /** Opens the list of the project's rentals. */
  onOpenRentals?: () => void;
  /** What the panel pays a rental with. */
  rentalPay?: RentalPayEnv;
  /** Opens a filed document (a payment receipt) in a new tab. */
  onOpenDocument?: (documentId: string) => void;
  /** The project's files, for the Files tab (the task's own are picked out here). */
  files?: {
    items: readonly FileItem[];
    viewerId: string;
    nameOf(userId: string | null): string | null;
    onUpload(taskId: number | null, file: File, kind: FileKind): Promise<void>;
    onDelete(id: string): void;
  };
}

export type TaskTabId = 'details' | 'scheduling' | 'links' | 'crew' | 'equipment' | 'money' | 'files' | 'notes';

/** The tab last used, kept while the panel is closed and between tasks. */
let rememberedTab: TaskTabId = 'details';

/**
 * Moves whenever tasks, links, crews or assignments change (names and notes included, which the
 * engine's dataReady does not always announce), batched to one render per frame.
 */
function useStoreVersion(project: ProjectModel): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let frame = 0;
    const bump = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setVersion((current) => current + 1);
      });
    };
    const detachers = [
      project.taskStore.on('change', bump),
      project.dependencyStore.on('change', bump),
      project.assignmentStore.on('change', bump),
      project.resourceStore.on('change', bump),
    ] as unknown as ((() => void) | undefined)[];
    return () => {
      if (frame) cancelAnimationFrame(frame);
      detachers.forEach((detach) => detach?.());
    };
  }, [project]);
  return version;
}

export function TaskInspector({
  project,
  taskId,
  dataVersion,
  canViewCosts,
  currency = 'USD',
  workflow = null,
  decorations = NO_DECORATIONS,
  onOpenTask,
  onOpenRentals,
  rentalPay,
  onOpenDocument,
  files,
}: TaskInspectorProps) {
  const storeVersion = useStoreVersion(project);
  const { state: edit, failures, run, dismiss } = useEditRunner();
  const [tab, setTabState] = useState<TaskTabId>(rememberedTab);
  const setTab = (next: TaskTabId) => {
    rememberedTab = next;
    setTabState(next);
  };

  const task: TaskModel | null = findTask(project, taskId);
  // Re-read on every engine result and store change; the view is cheap to build.
  const view = useMemo(() => (task ? taskView(project, task) : null), [project, task, dataVersion, storeVersion]);
  const payments = useMemo(() => (canViewCosts && typeof view?.id === 'number' ? taskPaymentFacts(workflow, view.id) : null), [canViewCosts, workflow, view?.id]);
  const context = useMemo<TaskPanelContext>(() => ({ project, currency, canViewCosts, run, openTask: onOpenTask }), [project, currency, canViewCosts, run, onOpenTask]);

  if (taskId === null) {
    return (
      <div className="inspector-body task-inspector" data-testid="task-inspector">
        <InspectorHeader icon="pen-to-square" title="Task" subtitle="Nothing selected" />
        <div className="empty-state ti-empty">
          <i className="fa fa-hand-pointer" aria-hidden="true" />
          <p className="empty-state-title">Click a task in the plan to see it here, or double-click a bar.</p>
          <p>Dates, scheduling, links, crews, money and notes can all be changed from this panel.</p>
        </div>
      </div>
    );
  }
  if (!task || !view) {
    return (
      <div className="inspector-body task-inspector" data-testid="task-inspector">
        <InspectorHeader icon="pen-to-square" title="Task" subtitle="No longer in the plan" />
        <div className="empty-state ti-empty" data-testid="task-gone">
          <i className="fa fa-box-archive" aria-hidden="true" />
          <p className="empty-state-title">This task is no longer in the plan.</p>
          <p>Someone may have removed it a moment ago. Nothing was lost on your side; pick another task to continue.</p>
        </div>
      </div>
    );
  }

  const decoration = decorations.get(view.id as number);
  const taskFiles = files ? files.items.filter((file) => file.task_id === view.id) : [];
  const showMoney = canViewCosts;
  const current: TaskTabId = tab === 'money' && !showMoney ? 'details' : tab;
  const linkCount = view.waitsFor.length + view.leadsTo.length;
  const onTask = view.isPhase ? view.crewInside : view.crew;
  const machineCount = onTask.filter((member) => member.equipment).length;
  const crewCount = onTask.length - machineCount;
  const tabs: { id: TaskTabId; label: string; title?: string; count?: string }[] = [
    { id: 'details', label: 'Details' },
    { id: 'scheduling', label: 'Scheduling', count: view.isManual || view.isInactive || view.constraint.note?.tone === 'warn' ? '•' : undefined },
    { id: 'links', label: 'Links', count: linkCount > 0 ? String(linkCount) : undefined },
    { id: 'crew', label: 'Crew', count: crewCount > 0 ? String(crewCount) : undefined },
    { id: 'equipment', label: 'Equipment', title: 'Machines on this task and their dates', count: machineCount > 0 ? String(machineCount) : undefined },
    ...(showMoney ? [{ id: 'money' as const, label: 'Costs', title: 'Budget, forecast and payments', count: payments?.payment ? '•' : undefined }] : []),
    ...(files ? [{ id: 'files' as const, label: 'Files', title: 'Quotes, invoices, receipts, photos', count: taskFiles.length > 0 ? String(taskFiles.length) : undefined }] : []),
    { id: 'notes', label: 'Notes', count: view.note.trim() ? '•' : undefined },
  ];

  return (
    <TaskPanelProvider value={context}>
      <div className="inspector-body task-inspector" data-testid="task-inspector" data-task-id={String(view.id)}>
        <TaskHeader task={task} view={view} badges={decoration?.badges ?? []} edit={edit} onDismissError={dismiss} />
        {/* A payment gate shows its payment first; work it holds says what it waits for. */}
        <PayGateCard task={task} dataVersion={`${String(dataVersion)}-${storeVersion}`} />
        <HeldNotice task={task} />
        <div className="ti-tabs" role="tablist" aria-label="Task details">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`ti-tab-${entry.id}`}
              aria-selected={current === entry.id}
              aria-controls="ti-tabpanel"
              className={`ti-tab${current === entry.id ? ' is-active' : ''}`}
              data-testid={`task-tab-${entry.id}`}
              title={entry.title}
              onClick={() => setTab(entry.id)}
            >
              <span>{entry.label}</span>
              {entry.count && (
                <span className={`ti-tab-count${entry.count === '•' ? ' is-dot' : ''}`} aria-label={entry.count === '•' ? 'has content' : undefined}>
                  {entry.count}
                </span>
              )}
            </button>
          ))}
        </div>
        {/* Keyed by task, tab and refused edits: switching task starts every field afresh, and a refused edit shows the stored values again. */}
        <div className="ti-tabpanel" id="ti-tabpanel" role="tabpanel" aria-labelledby={`ti-tab-${current}`} key={`${String(view.id)}-${current}-${failures}`}>
          {current === 'details' && <DetailsTab view={view} />}
          {current === 'scheduling' && <SchedulingTab task={task} view={view} />}
          {current === 'links' && <LinksTab task={task} view={view} />}
          {current === 'crew' && <CrewTab task={task} view={view} />}
          {current === 'equipment' && <EquipmentTab task={task} view={view} workflow={workflow} rentalPay={rentalPay} />}
          {current === 'money' && showMoney && <CostsTab view={view} payments={payments} onOpenRentals={onOpenRentals} onOpenDocument={onOpenDocument} />}
          {current === 'files' && files && (
            <FilesTab
              files={taskFiles}
              viewerId={files.viewerId}
              canViewCosts={canViewCosts}
              nameOf={files.nameOf}
              onOpen={(id) => onOpenDocument?.(id)}
              onUpload={(file, kind) => files.onUpload(view.id as number, file, kind)}
              onDelete={files.onDelete}
            />
          )}
          {current === 'notes' && <NotesTab view={view} />}
        </div>
      </div>
    </TaskPanelProvider>
  );
}
