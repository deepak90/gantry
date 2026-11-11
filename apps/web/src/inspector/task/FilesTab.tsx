/**
 * Files filed against one task (quotes, invoices, payment receipts, photos, drawings, reports), with
 * an area to drop more. Everyone sees the task's files; quotes, invoices and receipts only reach
 * cost viewers (the database leaves them out for everyone else).
 */
import { FileDrop, FileRows, type FileItem, type FileKind } from '../DocumentList';

export interface FilesTabProps {
  files: readonly FileItem[];
  viewerId: string;
  canViewCosts: boolean;
  nameOf(userId: string | null): string | null;
  onOpen(id: string): void;
  onUpload(file: File, kind: FileKind): Promise<void>;
  onDelete(id: string): void;
}

export function FilesTab({ files, viewerId, canViewCosts, nameOf, onOpen, onUpload, onDelete }: FilesTabProps) {
  return (
    <div className="ti-tab-body" data-testid="task-files">
      {files.length > 0 ? (
        <FileRows files={files} nameOf={nameOf} onOpen={onOpen} onDelete={onDelete} canDelete={(file) => file.kind !== 'receipt' && file.created_by === viewerId} />
      ) : (
        <p className="ti-empty-line">No files on this task yet.</p>
      )}
      <FileDrop target="this task" canViewCosts={canViewCosts} onUpload={onUpload} />
    </div>
  );
}
