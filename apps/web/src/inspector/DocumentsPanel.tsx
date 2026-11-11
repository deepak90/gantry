/**
 * The Documents tab of the side panel: every file on the project in one place, grouped by the task
 * it belongs to, with a filter by kind. Files dropped here go to the selected task, or to the
 * project when no task is selected. The assistant reads the text of these files when it looks at
 * the project, so a quote or an inspection report filed here informs what it suggests.
 */
import { useMemo, useState } from 'react';
import type { ProjectModel } from '@bryntum/gantt';
import { InspectorHeader } from './Inspector';
import { RemyMark } from '../assistant/RemyMark';
import { FILE_KINDS, FileDrop, FileRows, type FileItem, type FileKind } from './DocumentList';
import { ASSISTANT_NAME } from '../assistant/identity';

export interface DocumentsPanelProps {
  project: ProjectModel;
  files: readonly FileItem[];
  selectedTaskId: number | null;
  viewerId: string;
  canViewCosts: boolean;
  nameOf(userId: string | null): string | null;
  onOpen(id: string): void;
  onUpload(taskId: number | null, file: File, kind: FileKind): Promise<void>;
  onDelete(id: string): void;
  onShowTask(taskId: number): void;
}

export function DocumentsPanel({ project, files, selectedTaskId, viewerId, canViewCosts, nameOf, onOpen, onUpload, onDelete, onShowTask }: DocumentsPanelProps) {
  const [kind, setKind] = useState<FileKind | 'all'>('all');
  const taskName = (id: number) => (project.taskStore.getById(id) as { name?: string } | undefined)?.name ?? `Task ${id}`;
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const file of files) map.set(file.kind, (map.get(file.kind) ?? 0) + 1);
    return map;
  }, [files]);
  const shown = kind === 'all' ? files : files.filter((file) => file.kind === kind);
  const groups = useMemo(() => {
    const byTask = new Map<number | null, FileItem[]>();
    for (const file of shown) byTask.set(file.task_id, [...(byTask.get(file.task_id) ?? []), file]);
    return [...byTask.entries()].sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : 0));
  }, [shown]);
  const target = selectedTaskId !== null ? `“${taskName(selectedTaskId)}”` : 'the project';

  return (
    <div className="inspector-body docs-panel" data-testid="documents-panel">
      <InspectorHeader icon="folder-open" title="Documents" subtitle={`${files.length} file${files.length === 1 ? '' : 's'} on this project`} />
      <div className="docs-panel-body">
        <p className="note docs-note">
          <RemyMark motion="still" className="remy-inline" />
          {ASSISTANT_NAME} reads these files when she checks the plan, so a quote or a site report filed here informs what she suggests.
        </p>
        <FileDrop target={target} canViewCosts={canViewCosts} onUpload={(file, fileKind) => onUpload(selectedTaskId, file, fileKind)} />
        <div className="segmented docs-filter" role="radiogroup" aria-label="Show">
          <button type="button" role="radio" aria-checked={kind === 'all'} className={kind === 'all' ? 'is-active' : undefined} onClick={() => setKind('all')}>
            All <span>{files.length}</span>
          </button>
          {FILE_KINDS.filter((entry) => counts.get(entry.kind)).map((entry) => (
            <button key={entry.kind} type="button" role="radio" aria-checked={kind === entry.kind} className={kind === entry.kind ? 'is-active' : undefined} onClick={() => setKind(entry.kind)}>
              {entry.label} <span>{counts.get(entry.kind)}</span>
            </button>
          ))}
        </div>
        {groups.length === 0 ? (
          <p className="empty-state docs-empty">No files yet. Drop the supplier's quote, an invoice or a site photo above.</p>
        ) : (
          groups.map(([taskId, group]) => (
            <section key={String(taskId)} className="docs-group">
              <h3>
                {taskId === null ? (
                  'Whole project'
                ) : (
                  <button type="button" className="button is-link docs-task" onClick={() => onShowTask(taskId)} title="Show this task in the plan">
                    {taskName(taskId)} <i className="fa fa-arrow-right" aria-hidden="true" />
                  </button>
                )}
              </h3>
              <FileRows files={group} nameOf={nameOf} onOpen={onOpen} onDelete={onDelete} canDelete={(file) => file.kind !== 'receipt' && file.created_by === viewerId} />
            </section>
          ))
        )}
      </div>
    </div>
  );
}
