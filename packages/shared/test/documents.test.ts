import { describe, expect, it } from 'vitest';
import {
  COST_SENSITIVE_DOCUMENT_KINDS,
  DocumentCreatedVia,
  DocumentKind,
  MAX_DOCUMENT_TEXT_CHARS,
  ProjectDocumentRow,
  UPLOADABLE_DOCUMENT_KINDS,
  isCostSensitiveKind,
} from '../src/documents';
import * as shared from '../src/index';

/** A project_documents row as PostgREST returns it (the seeded supplier quote). */
const quote = {
  id: '00000000-0000-4000-8000-000000000201',
  project_id: '00000000-0000-4000-8000-000000000001',
  task_id: 15,
  kind: 'quote',
  name: 'Northgate Equipment Rental - Quotation Q-2611-0412.pdf',
  mime_type: 'application/pdf',
  size_bytes: 3172,
  storage_path: '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000201/northgate-quote.pdf',
  cost_sensitive: true,
  text_content: 'NORTHGATE EQUIPMENT RENTAL\nQuotation Q-2611-0412',
  summary: 'Crane re-booking: change fee $900.00, delivery $300.00 on request',
  payment_authorization_id: null,
  created_by: null,
  created_via: 'system',
  created_at: '2026-10-22T10:00:00.123456+00:00',
};

const receipt = {
  ...quote,
  id: '00000000-0000-4000-8000-0000000007aa',
  kind: 'receipt',
  name: 'Payment receipt - Northgate Equipment Rental - 2026-11-02.pdf',
  storage_path: '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000005bb/payment-receipt.pdf',
  payment_authorization_id: '00000000-0000-4000-8000-0000000005bb',
};

describe('document vocabularies', () => {
  it('lists the kinds and how documents are created', () => {
    expect(DocumentKind.options).toEqual(['quote', 'invoice', 'receipt', 'photo', 'drawing', 'report', 'other']);
    expect(DocumentCreatedVia.options).toEqual(['upload', 'system', 'agent']);
  });

  it('quotes, invoices and receipts show money; nothing else does', () => {
    expect([...COST_SENSITIVE_DOCUMENT_KINDS].sort()).toEqual(['invoice', 'quote', 'receipt']);
    expect(DocumentKind.options.filter(isCostSensitiveKind)).toEqual(['quote', 'invoice', 'receipt']);
  });

  it('members upload every kind except payment receipts', () => {
    expect(UPLOADABLE_DOCUMENT_KINDS).toEqual(['quote', 'invoice', 'photo', 'drawing', 'report', 'other']);
  });

  it('is exported from the package index', () => {
    expect(shared.ProjectDocumentRow).toBe(ProjectDocumentRow);
    expect(shared.MAX_DOCUMENT_TEXT_CHARS).toBe(MAX_DOCUMENT_TEXT_CHARS);
  });
});

describe('ProjectDocumentRow', () => {
  it('accepts a row as PostgREST returns it and strips unknown columns', () => {
    const parsed = ProjectDocumentRow.parse({ ...quote, added_later: true });
    expect(parsed).toEqual(quote);
    expect('added_later' in parsed).toBe(false);
  });

  it('accepts a project-wide document without a task, text or summary', () => {
    const photo = { ...quote, kind: 'photo', cost_sensitive: false, task_id: null, text_content: null, summary: null, created_via: 'upload' };
    expect(ProjectDocumentRow.parse(photo).task_id).toBeNull();
  });

  it('accepts a receipt linked to its payment', () => {
    expect(ProjectDocumentRow.parse(receipt).payment_authorization_id).toBe('00000000-0000-4000-8000-0000000005bb');
  });

  it('refuses a cost flag that does not follow the kind', () => {
    expect(ProjectDocumentRow.safeParse({ ...quote, cost_sensitive: false }).success).toBe(false);
    expect(ProjectDocumentRow.safeParse({ ...quote, kind: 'photo' }).success).toBe(false);
  });

  it('refuses a receipt without its payment', () => {
    expect(ProjectDocumentRow.safeParse({ ...receipt, payment_authorization_id: null }).success).toBe(false);
  });

  it('refuses unknown kinds, fractional sizes and phantom task ids', () => {
    expect(ProjectDocumentRow.safeParse({ ...quote, kind: 'spreadsheet' }).success).toBe(false);
    expect(ProjectDocumentRow.safeParse({ ...quote, size_bytes: 1.5 }).success).toBe(false);
    expect(ProjectDocumentRow.safeParse({ ...quote, task_id: '_generated_1' }).success).toBe(false);
    expect(ProjectDocumentRow.safeParse({ ...quote, created_via: 'human' }).success).toBe(false);
  });
});
