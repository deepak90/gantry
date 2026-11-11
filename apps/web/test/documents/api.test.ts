/**
 * The documents API against a fake Supabase client: the reads it makes, the upload path and the
 * register_document call, text kept for the AI agent, refusals that leave no file behind, signed
 * links and deletion. The SQL rules themselves are pinned by supabase/tests/11_documents.sql.
 */
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_DOCUMENT_TEXT_CHARS, type ProjectDocumentRow } from '@collab/shared';
import {
  DOCUMENT_URL_SECONDS,
  DocumentError,
  deleteDocument,
  documentMimeType,
  documentTextContent,
  documentUrl,
  isTextLike,
  listDocuments,
  storageFileName,
  uploadDocument,
  type DocumentsClient,
} from '../../src/documents/api';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const UPLOAD_ID = '00000000-0000-4000-8000-00000000d001';
const AT = '2026-11-02T09:00:00+00:00';

function row(overrides: Partial<ProjectDocumentRow> = {}): ProjectDocumentRow {
  return {
    id: '00000000-0000-4000-8000-0000000007aa',
    project_id: PROJECT,
    task_id: 15,
    kind: 'photo',
    name: 'Crane pad.jpg',
    mime_type: 'image/jpeg',
    size_bytes: 5,
    storage_path: `${PROJECT}/${UPLOAD_ID}/Crane-pad.jpg`,
    cost_sensitive: false,
    text_content: null,
    summary: null,
    payment_authorization_id: null,
    created_by: '00000000-0000-4000-8000-000000000011',
    created_via: 'upload',
    created_at: AT,
    ...overrides,
  };
}

type Answer = { data: unknown; error: { message: string; code?: string } | null };

interface Fake {
  client: DocumentsClient;
  queries: { table: string; steps: [string, ...unknown[]][] }[];
  rpcs: { fn: string; args: Record<string, unknown> }[];
  storage: { op: string; bucket: string; args: unknown[] }[];
}

function fakeClient(
  options: {
    tables?: Record<string, Answer>;
    rpc?: Record<string, (args: Record<string, unknown>) => Answer>;
    upload?: Answer;
    signed?: Answer;
    remove?: Answer;
  } = {},
): Fake {
  const queries: Fake['queries'] = [];
  const rpcs: Fake['rpcs'] = [];
  const storage: Fake['storage'] = [];
  const from = (table: string) => {
    const query = { table, steps: [] as [string, ...unknown[]][] };
    queries.push(query);
    const result = options.tables?.[table] ?? { data: [], error: null };
    const chain = {
      select: (...args: unknown[]) => (query.steps.push(['select', ...args]), chain),
      eq: (...args: unknown[]) => (query.steps.push(['eq', ...args]), chain),
      order: (...args: unknown[]) => (query.steps.push(['order', ...args]), chain),
      then: (resolve: (value: Answer) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  };
  const client: DocumentsClient = {
    rpc: (fn: string, args: object = {}) => {
      rpcs.push({ fn, args: args as Record<string, unknown> });
      const handler = options.rpc?.[fn];
      return Promise.resolve(handler ? handler(args as Record<string, unknown>) : { data: null, error: { message: `${fn}: not faked`, code: 'XX000' } });
    },
    from: from as unknown as DocumentsClient['from'],
    storage: {
      from: (bucket: string) => ({
        upload: async (...args: unknown[]) => (storage.push({ op: 'upload', bucket, args }), options.upload ?? { data: {}, error: null }),
        createSignedUrl: async (...args: unknown[]) => (
          storage.push({ op: 'createSignedUrl', bucket, args }),
          (options.signed ?? { data: { signedUrl: 'http://127.0.0.1:54321/storage/v1/object/sign/documents/x?token=t' }, error: null }) as {
            data: { signedUrl: string } | null;
            error: { message: string } | null;
          }
        ),
        remove: async (...args: unknown[]) => (storage.push({ op: 'remove', bucket, args }), options.remove ?? { data: [], error: null }),
      }),
    },
  };
  return { client, queries, rpcs, storage };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DocumentsClient', () => {
  it('the real SupabaseClient satisfies DocumentsClient', () => {
    const real = createClient('http://127.0.0.1:54321', 'anon-key');
    const client: DocumentsClient = real;
    expect(client).toBe(real);
  });
});

describe('listDocuments', () => {
  it('reads the project documents newest first and validates them', async () => {
    const receipt = row({
      id: '00000000-0000-4000-8000-0000000007bb',
      kind: 'receipt',
      cost_sensitive: true,
      payment_authorization_id: '00000000-0000-4000-8000-0000000005bb',
      created_via: 'system',
      created_by: null,
    });
    const fake = fakeClient({ tables: { project_documents: { data: [receipt, row()], error: null } } });
    expect(await listDocuments(fake.client, PROJECT)).toEqual([receipt, row()]);
    expect(fake.queries).toEqual([
      {
        table: 'project_documents',
        steps: [['select', '*'], ['eq', 'project_id', PROJECT], ['order', 'created_at', { ascending: false }]],
      },
    ]);
  });

  it('refuses rows of an unexpected shape and reports read errors with their code', async () => {
    const bad = fakeClient({ tables: { project_documents: { data: [{ ...row(), kind: 'spreadsheet' }], error: null } } });
    await expect(listDocuments(bad.client, PROJECT)).rejects.toMatchObject({ name: 'DocumentError', code: 'INVALID_RESPONSE' });
    const failing = fakeClient({ tables: { project_documents: { data: null, error: { message: 'JWT expired', code: 'PGRST301' } } } });
    await expect(listDocuments(failing.client, PROJECT)).rejects.toMatchObject({ message: 'Cannot read the documents: JWT expired', code: 'PGRST301' });
  });
});

describe('uploadDocument', () => {
  it('uploads into the project folder under a new id, then registers the file', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(UPLOAD_ID);
    const registered = row({ name: 'Crane pad (north) — day 1.jpg', storage_path: `${PROJECT}/${UPLOAD_ID}/Crane-pad-north-day-1.jpg` });
    const fake = fakeClient({ rpc: { register_document: () => ({ data: registered, error: null }) } });
    const file = new File(['12345'], 'Crane pad (north) — day 1.jpg', { type: 'image/jpeg' });

    expect(await uploadDocument(fake.client, { projectId: PROJECT, taskId: 15, kind: 'photo', file })).toEqual(registered);
    expect(fake.storage).toEqual([
      {
        op: 'upload',
        bucket: 'documents',
        args: [`${PROJECT}/${UPLOAD_ID}/Crane-pad-north-day-1.jpg`, file, { contentType: 'image/jpeg', upsert: false, cacheControl: '3600' }],
      },
    ]);
    expect(fake.rpcs).toEqual([
      {
        fn: 'register_document',
        args: {
          p_project: PROJECT,
          p_task: 15,
          p_kind: 'photo',
          p_name: 'Crane pad (north) — day 1.jpg',
          p_mime: 'image/jpeg',
          p_size: 5,
          p_storage_path: `${PROJECT}/${UPLOAD_ID}/Crane-pad-north-day-1.jpg`,
          p_text_content: null,
        },
      },
    ]);
  });

  it('keeps the text of a text-like file for the AI agent (type guessed from the extension)', async () => {
    const fake = fakeClient({ rpc: { register_document: (args) => ({ data: row({ kind: 'report', name: String(args.p_name) }), error: null }) } });
    const file = new File(['Daily log\n\nCrane pad poured.\u0000'], 'diary.txt', { type: '' });
    await uploadDocument(fake.client, { projectId: PROJECT, taskId: null, kind: 'report', file });
    expect(fake.rpcs[0]?.args).toMatchObject({
      p_task: null,
      p_mime: 'text/plain',
      p_text_content: 'Daily log\n\nCrane pad poured.',
    });
    expect((fake.storage[0]?.args[2] as { contentType: string }).contentType).toBe('text/plain');
  });

  it('keeps at most 200 KiB of text', async () => {
    const file = new File(['a'.repeat(MAX_DOCUMENT_TEXT_CHARS + 10)], 'big.csv', { type: 'text/csv' });
    expect((await documentTextContent(file))?.length).toBe(MAX_DOCUMENT_TEXT_CHARS);
    expect(await documentTextContent(new File(['%PDF-1.7'], 'quote.pdf', { type: 'application/pdf' }))).toBeNull();
  });

  it('a refused registration removes the uploaded file and explains why', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(UPLOAD_ID);
    const fake = fakeClient({
      rpc: { register_document: () => ({ data: null, error: { message: 'register_document: task 999 is not in the project', code: '22023' } }) },
    });
    const file = new File(['x'], 'note.txt', { type: 'text/plain' });
    const failure = uploadDocument(fake.client, { projectId: PROJECT, taskId: 999, kind: 'other', file });
    await expect(failure).rejects.toThrow(DocumentError);
    await expect(failure).rejects.toMatchObject({ message: 'task 999 is not in the project', code: '22023' });
    expect(fake.storage.map((call) => call.op)).toEqual(['upload', 'remove']);
    expect(fake.storage[1]?.args).toEqual([[`${PROJECT}/${UPLOAD_ID}/note.txt`]]);
  });

  it('a failed upload registers nothing', async () => {
    const fake = fakeClient({ upload: { data: null, error: { message: 'new row violates row-level security policy' } } });
    const file = new File(['x'], 'note.txt', { type: 'text/plain' });
    await expect(uploadDocument(fake.client, { projectId: PROJECT, taskId: null, kind: 'other', file })).rejects.toMatchObject({
      message: 'Uploading note.txt failed: new row violates row-level security policy',
      code: 'STORAGE',
    });
    expect(fake.rpcs).toEqual([]);
  });

  it('refuses receipts and files over 5 MB before uploading anything', async () => {
    const fake = fakeClient();
    const small = new File(['x'], 'r.pdf', { type: 'application/pdf' });
    await expect(uploadDocument(fake.client, { projectId: PROJECT, taskId: null, kind: 'receipt', file: small })).rejects.toMatchObject({
      code: '42501',
    });
    const big = new File(['x'], 'scan.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 + 1 });
    await expect(uploadDocument(fake.client, { projectId: PROJECT, taskId: null, kind: 'invoice', file: big })).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
    expect(fake.storage).toEqual([]);
  });

  it('takes only what the bucket takes, PDF, PNG, JPEG and plain text, and says so before uploading', async () => {
    const fake = fakeClient();
    for (const file of [new File(['x'], 'diary.md', { type: '' }), new File(['x'], 'site.heic', { type: 'image/heic' }), new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })]) {
      await expect(uploadDocument(fake.client, { projectId: PROJECT, taskId: null, kind: 'other', file })).rejects.toMatchObject({
        code: 'FILE_TYPE',
        message: `${file.name} isn't a PDF, PNG, JPEG or plain text file, so it can't be added.`,
      });
    }
    expect(fake.storage).toEqual([]);
  });
});

describe('file names and types', () => {
  it.each([
    ['Crane pad (north) — day 1.jpg', 'Crane-pad-north-day-1.jpg'],
    ['Façade drawing.PDF', 'Facade-drawing.pdf'],
    ['../../etc/passwd', 'etc-passwd'],
    ['起重机.png', 'file.png'],
    ['README', 'README'],
    [`${'x'.repeat(150)}.txt`, `${'x'.repeat(80)}.txt`],
  ])('%s is stored as %s', (name, stored) => {
    expect(storageFileName(name)).toBe(stored);
  });

  it('takes the browser type without parameters, or guesses it from the extension', () => {
    expect(documentMimeType({ name: 'a.txt', type: 'text/plain;charset=utf-8' })).toBe('text/plain');
    expect(documentMimeType({ name: 'plan.DWG', type: '' })).toBe('image/vnd.dwg');
    expect(documentMimeType({ name: 'mystery', type: '' })).toBe('application/octet-stream');
  });

  it('treats text, JSON, CSV and Markdown as text', () => {
    expect(isTextLike({ name: 'a.txt', type: 'text/plain' })).toBe(true);
    expect(isTextLike({ name: 'a.json', type: 'application/json' })).toBe(true);
    expect(isTextLike({ name: 'data.geo', type: 'application/geo+json' })).toBe(true);
    expect(isTextLike({ name: 'a.csv', type: 'application/vnd.ms-excel' })).toBe(true);
    expect(isTextLike({ name: 'a.pdf', type: 'application/pdf' })).toBe(false);
    expect(isTextLike({ name: 'a.jpg', type: 'image/jpeg' })).toBe(false);
  });
});

describe('documentUrl', () => {
  it('signs a 10-minute link to the file', async () => {
    const fake = fakeClient();
    expect(await documentUrl(fake.client, row())).toBe('http://127.0.0.1:54321/storage/v1/object/sign/documents/x?token=t');
    expect(DOCUMENT_URL_SECONDS).toBe(600);
    expect(fake.storage).toEqual([{ op: 'createSignedUrl', bucket: 'documents', args: [row().storage_path, 600] }]);
  });

  it('reports a file the viewer may not open', async () => {
    const fake = fakeClient({ signed: { data: null, error: { message: 'Object not found' } } });
    await expect(documentUrl(fake.client, row())).rejects.toMatchObject({ message: 'Cannot open the file: Object not found' });
  });
});

describe('deleteDocument', () => {
  it('deletes the document, then its file', async () => {
    const fake = fakeClient({ rpc: { delete_document: () => ({ data: row(), error: null }) } });
    await deleteDocument(fake.client, row().id);
    expect(fake.rpcs).toEqual([{ fn: 'delete_document', args: { p_id: row().id } }]);
    expect(fake.storage).toEqual([{ op: 'remove', bucket: 'documents', args: [[row().storage_path]] }]);
  });

  it('a refusal deletes nothing', async () => {
    const fake = fakeClient({
      rpc: { delete_document: () => ({ data: null, error: { message: 'delete_document: a payment receipt is part of the payment record and cannot be deleted', code: '42501' } }) },
    });
    await expect(deleteDocument(fake.client, row().id)).rejects.toMatchObject({
      message: 'a payment receipt is part of the payment record and cannot be deleted',
      code: '42501',
    });
    expect(fake.storage).toEqual([]);
  });

  it('a file that cannot be removed is only logged: the document is already gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeClient({ rpc: { delete_document: () => ({ data: row(), error: null }) }, remove: { data: null, error: { message: 'offline' } } });
    await expect(deleteDocument(fake.client, row().id)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });
});
