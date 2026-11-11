/**
 * The project's document repository for the browser (supabase/migrations/*_project_documents.sql):
 * list the documents the viewer may see, upload a file and register it, get a short-lived link to
 * a file, delete a document. Files live in the private Storage bucket `documents` at
 * `{project_id}/{uuid}/{file name}`; RLS hides quotes, invoices and receipts (and their files) from
 * members who cannot view costs. Payment receipts are filed by the payment service, never here.
 * Every row is validated against the shared ProjectDocumentRow schema.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DOCUMENT_MIME_TYPES,
  DOCUMENTS_BUCKET,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_TEXT_CHARS,
  ProjectDocumentRow,
  type DocumentKind,
} from '@collab/shared';
import { z } from 'zod';

/** How long a link from `documentUrl` works. */
export const DOCUMENT_URL_SECONDS = 10 * 60;

interface ErrorLike {
  message: string;
  code?: string;
}

interface StorageErrorLike {
  message: string;
}

/** The slice of a Storage bucket the documents use (StorageFileApi satisfies it). */
export interface DocumentBucket {
  upload(
    path: string,
    body: Blob,
    options: { contentType: string; upsert: boolean; cacheControl?: string },
  ): PromiseLike<{ data: unknown; error: StorageErrorLike | null }>;
  createSignedUrl(path: string, expiresIn: number): PromiseLike<{ data: { signedUrl: string } | null; error: StorageErrorLike | null }>;
  remove(paths: string[]): PromiseLike<{ data: unknown; error: StorageErrorLike | null }>;
}

/** The slice of `SupabaseClient` the documents use; the real client satisfies it, tests fake it. */
export interface DocumentsClient {
  rpc(fn: string, args?: object): PromiseLike<{ data: unknown; error: ErrorLike | null }>;
  /** The real method type: a structural copy of the PostgREST builder chain is too deep to compare. */
  from: SupabaseClient['from'];
  storage: { from(bucket: string): DocumentBucket };
}

/** A refusal or failure. `code` is the SQLSTATE (42501 not allowed, 22023 invalid, P0002 not found) or a local code. */
export class DocumentError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'DocumentError';
    this.code = code;
  }
}

/** `register_document: the file name must ...` reads better without the function prefix. */
function serverError(operation: string, error: ErrorLike): DocumentError {
  return new DocumentError(error.message.replace(/^[a-z_]+: /, '') || `${operation} failed`, error.code);
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DocumentError(`${what} returned an unexpected shape:\n${z.prettifyError(parsed.error)}`, 'INVALID_RESPONSE');
  }
  return parsed.data;
}

// -----------------------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------------------

/** The project's documents the viewer may see, newest first. */
export async function listDocuments(client: Pick<DocumentsClient, 'from'>, projectId: string): Promise<ProjectDocumentRow[]> {
  const { data, error } = await client
    .from('project_documents')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) {
    throw new DocumentError(`Cannot read the documents: ${error.message}`, error.code);
  }
  return parse(z.array(ProjectDocumentRow), data ?? [], 'project_documents');
}

/** A link to the file that works for DOCUMENT_URL_SECONDS (10 minutes). */
export async function documentUrl(
  client: Pick<DocumentsClient, 'storage'>,
  doc: Pick<ProjectDocumentRow, 'storage_path'>,
): Promise<string> {
  const { data, error } = await client.storage.from(DOCUMENTS_BUCKET).createSignedUrl(doc.storage_path, DOCUMENT_URL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new DocumentError(`Cannot open the file: ${error?.message ?? 'no link was returned'}`, 'STORAGE');
  }
  return data.signedUrl;
}

// -----------------------------------------------------------------------------------------
// Upload
// -----------------------------------------------------------------------------------------

export interface UploadDocumentInput {
  projectId: string;
  /** The Bryntum task the file belongs to (a saved task id), or null for the whole project. */
  taskId: number | null;
  kind: DocumentKind;
  file: File;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  dwg: 'image/vnd.dwg',
  dxf: 'image/vnd.dxf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['txt', 'log', 'md', 'markdown', 'csv', 'tsv', 'json']);

function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(name);
  return match?.[1]?.toLowerCase() ?? '';
}

/** The file's media type without parameters; guessed from the extension when the browser gives none. */
export function documentMimeType(file: Pick<File, 'name' | 'type'>): string {
  const declared = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
  if (/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(declared)) {
    return declared;
  }
  return MIME_BY_EXTENSION[extensionOf(file.name)] ?? 'application/octet-stream';
}

/** Text files whose content is kept for the AI agent: text/*, JSON, CSV and Markdown. */
export function isTextLike(file: Pick<File, 'name' | 'type'>): boolean {
  const mime = documentMimeType(file);
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime.endsWith('+json') ||
    mime === 'application/csv' ||
    TEXT_EXTENSIONS.has(extensionOf(file.name))
  );
}

/** A storage-safe copy of a file name: letters, digits, '.', '_' and '-', at most 100 characters. */
export function storageFileName(name: string): string {
  const extension = extensionOf(name);
  const stem = (extension ? name.slice(0, -(extension.length + 1)) : name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  const safeStem = stem === '' ? 'file' : stem;
  return extension ? `${safeStem}.${extension}` : safeStem;
}

async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') {
    return blob.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'));
    reader.readAsText(blob);
  });
}

/** The text of a text-like file, at most MAX_DOCUMENT_TEXT_CHARS (200 KiB) of it; null for anything else. */
export async function documentTextContent(file: File): Promise<string | null> {
  if (!isTextLike(file)) {
    return null;
  }
  // Postgres text cannot hold NUL characters.
  const text = (await blobText(file.slice(0, MAX_DOCUMENT_TEXT_CHARS))).replace(/\u0000/g, '');
  return text.slice(0, MAX_DOCUMENT_TEXT_CHARS);
}

/**
 * Uploads the file into the project's folder, then registers it with register_document. A refused
 * registration removes the uploaded file again, so a failed upload leaves nothing behind.
 */
export async function uploadDocument(client: DocumentsClient, input: UploadDocumentInput): Promise<ProjectDocumentRow> {
  const { projectId, taskId, kind, file } = input;
  if (kind === 'receipt') {
    throw new DocumentError('Payment receipts are filed automatically when PayPal confirms a payment.', '42501');
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new DocumentError(`${file.name} is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`, 'FILE_TOO_LARGE');
  }
  const name = file.name.trim() || 'Untitled';
  const mime = documentMimeType(file);
  if (!DOCUMENT_MIME_TYPES.includes(mime)) {
    throw new DocumentError(`${file.name} isn't a PDF, PNG, JPEG or plain text file, so it can't be added.`, 'FILE_TYPE');
  }
  const textContent = await documentTextContent(file);
  const path = `${projectId}/${crypto.randomUUID()}/${storageFileName(name)}`;

  const bucket = client.storage.from(DOCUMENTS_BUCKET);
  const uploaded = await bucket.upload(path, file, { contentType: mime, upsert: false, cacheControl: '3600' });
  if (uploaded.error) {
    throw new DocumentError(`Uploading ${name} failed: ${uploaded.error.message}`, 'STORAGE');
  }

  const { data, error } = await client.rpc('register_document', {
    p_project: projectId,
    p_task: taskId,
    p_kind: kind,
    p_name: name.slice(0, 200),
    p_mime: mime,
    p_size: file.size,
    p_storage_path: path,
    p_text_content: textContent,
  });
  if (error) {
    await Promise.resolve(bucket.remove([path])).catch(() => undefined);
    throw serverError('register_document', error);
  }
  return parse(ProjectDocumentRow, data, 'register_document');
}

// -----------------------------------------------------------------------------------------
// Delete
// -----------------------------------------------------------------------------------------

/**
 * Deletes a document (its uploader or the cost manager; never a payment receipt), then its file.
 * The document is gone once delete_document succeeds; a file that cannot be removed is only logged
 * (it is unreachable without its row, and `pnpm demo:reset` clears it).
 */
export async function deleteDocument(client: DocumentsClient, id: string): Promise<void> {
  const { data, error } = await client.rpc('delete_document', { p_id: id });
  if (error) {
    throw serverError('delete_document', error);
  }
  const row = parse(ProjectDocumentRow, data, 'delete_document');
  const removed = await Promise.resolve(client.storage.from(DOCUMENTS_BUCKET).remove([row.storage_path])).catch(
    (failure: unknown) => ({ data: null, error: { message: failure instanceof Error ? failure.message : String(failure) } }),
  );
  if (removed.error) {
    console.warn(`[documents] the file of deleted document ${id} was not removed: ${removed.error.message}`);
  }
}
