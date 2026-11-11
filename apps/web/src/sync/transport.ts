import type { OutgoingRevision, ProjectRevisionRow } from '@collab/shared';

export type TransportStatus = 'connected' | 'reconnecting' | 'closed';

export interface TransportHandlers {
  onRevision(row: ProjectRevisionRow): void;
  onStatus(status: TransportStatus): void;
}

/**
 * Network layer of the Bryntum Revisions protocol: submit, catch-up fetch and live broadcast.
 * Implementations: `SupabaseTransport` (RPC + Realtime) and `InMemoryRelay.connect()` (tests).
 *
 * Methods reject with `TransportUnavailableError` when the server could not be reached (the caller
 * retries; the server dedupes on `(client_id, local_revision_id)` so a retry after a lost response is
 * safe) or with `RevisionRejectedError` when the server refused the payload (retrying the same payload
 * cannot succeed).
 */
export interface RevisionTransport {
  submit(rev: OutgoingRevision): Promise<ProjectRevisionRow>;
  fetchAfter(revisionNo: number): Promise<ProjectRevisionRow[]>;
  subscribe(handlers: TransportHandlers): () => void;
}

export class RevisionRejectedError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'RevisionRejectedError';
    this.code = code;
  }
}

export class TransportUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportUnavailableError';
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
