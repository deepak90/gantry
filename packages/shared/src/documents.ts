/**
 * Project documents (supabase/migrations/*_project_documents.sql): files in the private Storage
 * bucket `documents`, each described by a `project_documents` row and optionally linked to a
 * Bryntum task. Rows are validated at the boundary like the workflow rows (workflow.ts): timestamps
 * keep Postgres's offset form, bigint columns arrive as JSON numbers, unknown columns are stripped.
 */
import { z } from 'zod';
import { timestamp, uuid } from './schemas';

/** What a document is. Mirrors the `kind` check constraint (packages/shared/test keeps them equal). */
export const DocumentKind = z.enum(['quote', 'invoice', 'receipt', 'photo', 'drawing', 'report', 'other']);
export type DocumentKind = z.infer<typeof DocumentKind>;

/** How a document came to be: a member's upload, the app itself (seed, payment receipts) or the AI agent. */
export const DocumentCreatedVia = z.enum(['upload', 'system', 'agent']);
export type DocumentCreatedVia = z.infer<typeof DocumentCreatedVia>;

/** Kinds that show money: only members who can view costs see them (the database enforces it). */
export const COST_SENSITIVE_DOCUMENT_KINDS: ReadonlySet<DocumentKind> = new Set<DocumentKind>(['quote', 'invoice', 'receipt']);

export function isCostSensitiveKind(kind: DocumentKind): boolean {
  return COST_SENSITIVE_DOCUMENT_KINDS.has(kind);
}

/** Kinds a member can upload; payment receipts are filed by the payment service when PayPal confirms a payout. */
export const UPLOADABLE_DOCUMENT_KINDS: readonly DocumentKind[] = DocumentKind.options.filter((kind) => kind !== 'receipt');

/** The bucket every document file lives in, at `{project_id}/{uuid}/{file name}`. */
export const DOCUMENTS_BUCKET = 'documents';

/** Largest file the bucket accepts (its file_size_limit). */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** The kinds of file the bucket accepts (its allowed_mime_types): PDF, PNG, JPEG and plain text. */
export const DOCUMENT_MIME_TYPES: readonly string[] = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'];

/** Most text kept for the AI agent per document (the `text_content` check constraint). */
export const MAX_DOCUMENT_TEXT_CHARS = 200 * 1024;

export const ProjectDocumentRow = z
  .object({
    id: uuid,
    project_id: uuid,
    /** The Bryntum task the document belongs to, or null for the project as a whole. */
    task_id: z.int().positive().nullable(),
    kind: DocumentKind,
    /** The original file name. */
    name: z.string().min(1).max(200),
    mime_type: z.string().min(1),
    size_bytes: z.int().nonnegative(),
    /** Object path in the `documents` bucket. */
    storage_path: z.string().min(1),
    /** True for quotes, invoices and receipts. */
    cost_sensitive: z.boolean(),
    /** Plain text for the AI agent: generated documents and text-like uploads. */
    text_content: z.string().nullable(),
    /** One line, for generated documents ("PayPal payment of $1,200.00 to Northgate Equipment Rental"). */
    summary: z.string().nullable(),
    /** The payment a receipt confirms. */
    payment_authorization_id: uuid.nullable(),
    created_by: uuid.nullable(),
    created_via: DocumentCreatedVia,
    created_at: timestamp,
  })
  .refine((row) => row.cost_sensitive === isCostSensitiveKind(row.kind), {
    message: 'cost_sensitive must follow the kind (quote, invoice and receipt are cost-sensitive)',
    path: ['cost_sensitive'],
  })
  .refine((row) => row.kind !== 'receipt' || row.payment_authorization_id !== null, {
    message: 'a receipt names the payment it confirms',
    path: ['payment_authorization_id'],
  });
export type ProjectDocumentRow = z.infer<typeof ProjectDocumentRow>;
