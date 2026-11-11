/**
 * Files on the project: quotes, invoices, payment receipts, photos, drawings and reports, each
 * filed against a task (or the whole project). Used twice: in a task's Files tab (that task's files,
 * with an upload area) and in the Documents panel (every file, grouped by task, with a filter by
 * kind). Purely presentational: loading, uploading and opening go through the callbacks.
 *
 * These files are also what the assistant reads to understand the project (their text is kept with
 * them), so the panel says so.
 */
import { useRef, useState, type DragEvent } from 'react';
import { MAX_DOCUMENT_BYTES } from '@collab/shared';
import '../styles/documents.css';
import { ASSISTANT_NAME } from '../assistant/identity';

export type FileKind = 'quote' | 'invoice' | 'receipt' | 'photo' | 'drawing' | 'report' | 'other';

export const FILE_KINDS: readonly { kind: FileKind; label: string; icon: string }[] = [
  { kind: 'quote', label: 'Quote', icon: 'file-signature' },
  { kind: 'invoice', label: 'Invoice', icon: 'file-invoice' },
  { kind: 'receipt', label: 'Payment receipt', icon: 'file-invoice-dollar' },
  { kind: 'photo', label: 'Photo', icon: 'image' },
  { kind: 'drawing', label: 'Drawing', icon: 'compass-drafting' },
  { kind: 'report', label: 'Report', icon: 'file-lines' },
  { kind: 'other', label: 'Other', icon: 'file' },
];

const KIND = new Map(FILE_KINDS.map((entry) => [entry.kind, entry]));

/** A filed document, as far as the list shows it. */
export interface FileItem {
  id: string;
  task_id: number | null;
  kind: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  created_by: string | null;
  created_via: string;
  created_at: string;
  summary?: string | null;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

/** The kind a file most likely is, from its name and type (the person can change it before uploading). */
export function guessKind(file: { name: string; type: string }): FileKind {
  const name = file.name.toLowerCase();
  if (/receipt|remittance/.test(name)) return 'receipt';
  if (/invoice|inv[-_ ]?\d/.test(name)) return 'invoice';
  if (/quote|quotation|estimate|offer/.test(name)) return 'quote';
  if (file.type.startsWith('image/')) return 'photo';
  if (/\.(dwg|dxf)$/.test(name) || /drawing|plan|section|elevation/.test(name)) return 'drawing';
  if (/report|minutes|inspection|survey/.test(name)) return 'report';
  return 'other';
}

export interface FileRowsProps {
  files: readonly FileItem[];
  nameOf(userId: string | null): string | null;
  onOpen(id: string): void;
  /** Files this person may remove (their own uploads; never receipts). */
  canDelete?(file: FileItem): boolean;
  onDelete?(id: string): void;
}

export function FileRows({ files, nameOf, onOpen, canDelete, onDelete }: FileRowsProps) {
  return (
    <ul className="doc-rows" data-testid="file-rows">
      {files.map((file) => {
        const kind = KIND.get(file.kind as FileKind) ?? KIND.get('other')!;
        const by = file.created_via === 'system' ? 'Filed automatically' : file.created_via === 'agent' ? `Filed by ${ASSISTANT_NAME}` : (nameOf(file.created_by) ?? 'A member');
        return (
          <li key={file.id} className={`doc-row is-${file.kind}`} data-testid={`file-${file.kind}`}>
            <span className="doc-icon" aria-hidden="true">
              <i className={`fa fa-${kind.icon}`} />
            </span>
            <button type="button" className="doc-main" onClick={() => onOpen(file.id)} title={`Open ${file.name}`}>
              <span className="doc-name">{file.name}</span>
              <span className="doc-meta">
                {kind.label} · {fileSize(file.size_bytes)} · {by} · {day(file.created_at)}
              </span>
              {file.summary && <span className="doc-summary">{file.summary}</span>}
            </button>
            {onDelete && canDelete?.(file) && (
              <button type="button" className="button is-quiet is-icon is-sm doc-delete" aria-label={`Remove ${file.name}`} title="Remove" onClick={() => onDelete(file.id)}>
                <i className="fa fa-trash-can" aria-hidden="true" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface FileDropProps {
  /** Uploads one file as `kind`; rejects with a message to show. */
  onUpload(file: File, kind: FileKind): Promise<void>;
  /** Where the file goes, in words ("this task", "the project"). */
  target: string;
  /** Quotes and invoices are cost documents: someone without cost access is told they won't see theirs again. */
  canViewCosts?: boolean;
}

/** Drop a file (or choose one), check its kind, and it is filed. */
export function FileDrop({ onUpload, target, canViewCosts = true }: FileDropProps) {
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<{ file: File; kind: FileKind } | null>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [over, setOver] = useState(false);

  const take = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_DOCUMENT_BYTES) {
      setState({ busy: false, error: `${file.name} is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.` });
      return;
    }
    setPicked({ file, kind: guessKind(file) });
    setState({ busy: false, error: null });
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer.files[0]);
  };
  const send = async () => {
    if (!picked) return;
    setState({ busy: true, error: null });
    try {
      await onUpload(picked.file, picked.kind);
      setPicked(null);
      setState({ busy: false, error: null });
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div
      className={`doc-drop${over ? ' is-over' : ''}${picked ? ' has-file' : ''}`}
      data-testid="file-drop"
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <input ref={input} type="file" hidden data-testid="file-input" onChange={(event) => take(event.target.files?.[0] ?? undefined)} />
      {picked ? (
        <div className="doc-drop-picked">
          <span className="doc-name">{picked.file.name}</span>
          <label>
            Filed as
            <select className="input" value={picked.kind} onChange={(event) => setPicked({ ...picked, kind: event.target.value as FileKind })} data-testid="file-kind">
              {FILE_KINDS.filter((entry) => entry.kind !== 'receipt').map((entry) => (
                <option key={entry.kind} value={entry.kind}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          {!canViewCosts && (picked.kind === 'quote' || picked.kind === 'invoice') && (
            <p className="note is-warning doc-drop-note">Quotes and invoices are shown to people who see costs only: once added, you won't be able to open this file.</p>
          )}
          <div className="doc-drop-actions">
            <button type="button" className="button is-primary" disabled={state.busy} onClick={() => void send()} data-testid="file-upload">
              {state.busy ? 'Uploading…' : `Add to ${target}`}
            </button>
            <button type="button" className="button is-quiet" disabled={state.busy} onClick={() => setPicked(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="doc-drop-prompt" onClick={() => input.current?.click()}>
          <i className="fa fa-cloud-arrow-up" aria-hidden="true" />
          <span>
            Drop a file here or <u>choose one</u>
          </span>
          <small>Quotes, invoices, photos, drawings, reports · PDF, PNG, JPEG or text, up to 5 MB</small>
        </button>
      )}
      {state.error && (
        <p className="note is-danger doc-error" role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}
