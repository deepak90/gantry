/**
 * The payment receipt: facts read from receipt_facts and PayPal's stored answer, the plain text, the
 * one-page PDF (read back with pdf-lib and by decoding its content streams), the idempotent filer,
 * and the handlers filing it for succeeded payouts in mock and live mode.
 */
import * as pdfLib from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { createPayoutHandler } from '../_shared/handlers.ts';
import { winAnsiText, wrapText } from '../_shared/pdf.ts';
import {
  createReceiptFiler,
  createSupabaseReceiptStore,
  formatDay,
  formatInstant,
  paypalItemDetails,
  readReceiptFacts,
  receiptDocument,
  receiptFileName,
  receiptNumber,
  receiptSummary,
  receiptText,
  ReceiptError,
  type FileReceiptRequest,
  type ReceiptClient,
  type ReceiptFacts,
  type ReceiptStore,
} from '../_shared/receipt.ts';
import { renderDocumentPdf } from '../_shared/pdf.ts';
import type { PaymentAuthorization } from '../_shared/store.ts';
import {
  AUTH_ID,
  batchBody,
  envOf,
  FakePayPal,
  FakeStore,
  LIVE_ENV,
  payoutHandler,
  payoutRequest,
  PROJECT,
  readJson,
  TOKENS,
  webhookHandler,
  webhookRequest,
} from './fakes.ts';

const NOW = new Date('2026-11-02T09:00:30.000Z');
const PDF = { PDFDocument: pdfLib.PDFDocument, StandardFonts: pdfLib.StandardFonts, rgb: pdfLib.rgb };

/**
 * What receipt_facts answers for an operation (the shape of the SQL function's jsonb): the crane
 * rental moved to start on the day the work can use it, 6 billable days at $600 instead of 10.
 */
function factsRow(authorization: Partial<PaymentAuthorization> & Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    existing_receipt_id: null,
    authorization: {
      id: AUTH_ID,
      project_id: PROJECT,
      status: 'succeeded',
      amount_minor: 360000,
      currency: 'USD',
      recipient_email: 'supplier@test.local',
      paypal_batch_id: 'BATCH-1',
      paypal_item_id: 'ITEM-1',
      fee_minor: 25,
      raw: null,
      created_at: '2026-11-02T08:59:00+00:00',
      ...authorization,
    },
    authorized_by_name: 'Chris Morgan',
    project: { id: PROJECT, name: 'Riverside Clinic' },
    task: { id: 15, name: 'Erect structural steel frame' },
    supplier_name: 'Northgate Equipment Rental',
    rental_rate_minor: 60000,
    proposal: {
      id: '00000000-0000-4000-8000-0000000002bb',
      version_no: 2,
      inputs: { new_start: '2026-12-11', new_end: '2026-12-18' },
      cost_comparison: { currency: 'USD', booked_rental_minor: 600000, supplier_payment_minor: 360000, saving_minor: 240000 },
      booking_days: { published_billable_days: 10, revised_billable_days: 6, avoided_billable_days: 4, revised_idle_days: 0 },
    },
    schedule_approval: { approver_name: 'Priya Mehta', approved_at: '2026-11-02T08:40:00.123+00:00', status: 'active' },
    payment_approval: { approver_name: 'Chris Morgan', approved_at: '2026-11-02T08:55:00+00:00', status: 'active' },
    ...overrides,
  };
}

function facts(overrides: Partial<ReceiptFacts> = {}): ReceiptFacts {
  return { ...readReceiptFacts(factsRow(), 'mock', NOW).facts, ...overrides };
}

/** A ReceiptStore over memory: facts come from `answer`, uploads and rows are kept. */
class MemoryReceiptStore implements ReceiptStore {
  readonly uploads = new Map<string, Uint8Array>();
  readonly removed: string[] = [];
  readonly filed: FileReceiptRequest[] = [];
  receipt: { id: string; storagePath: string } | null = null;
  /** Runs inside file() before the row is written (simulates the other filer winning the race). */
  beforeFile: (() => void) | null = null;
  fileError: Error | null = null;

  constructor(private readonly answer: () => unknown) {}

  async facts(): Promise<unknown> {
    const row = this.answer() as Record<string, unknown>;
    return { ...row, existing_receipt_id: this.receipt?.id ?? null };
  }

  async upload(path: string, bytes: Uint8Array): Promise<void> {
    if (this.uploads.has(path)) throw new Error('The resource already exists');
    this.uploads.set(path, bytes);
  }

  async file(request: FileReceiptRequest) {
    this.beforeFile?.();
    if (this.fileError !== null) throw this.fileError;
    if (this.receipt !== null) {
      return { created: false, documentId: this.receipt.id, storagePath: this.receipt.storagePath };
    }
    this.filed.push(request);
    this.receipt = { id: '00000000-0000-4000-8000-0000000007aa', storagePath: request.storagePath };
    return { created: true, documentId: this.receipt.id, storagePath: request.storagePath };
  }

  async remove(path: string): Promise<void> {
    this.removed.push(path);
    this.uploads.delete(path);
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the PDF back
// ---------------------------------------------------------------------------------------------

interface TextRun {
  font: string;
  size: number;
  x: number;
  y: number;
  text: string;
}

/** Bytes as a string of the same length, one character per byte (PDF syntax is ASCII). */
function byteString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

function hexBytes(hex: string): Uint8Array {
  return new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
}

/** Every drawn string of the PDF with its font, size and position (pdf-lib's BT … Tm <hex> Tj … ET). */
async function textRuns(bytes: Uint8Array): Promise<TextRun[]> {
  const raw = byteString(bytes);
  const decoder = new TextDecoder('windows-1252');
  const runs: TextRun[] = [];
  for (const stream of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const start = (stream.index ?? 0) + stream[0].indexOf('\n') + 1;
    const inflated = await inflate(bytes.subarray(start, start + stream[1]!.length));
    if (inflated === null) continue;
    const content = byteString(inflated);
    for (const block of content.matchAll(/BT([\s\S]*?)ET/g)) {
      const body = block[1]!;
      const font = /\/(\S+?)-\d+ ([\d.]+) Tf/.exec(body);
      const placed = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-F]*)> Tj/.exec(body);
      if (font === null || placed === null) continue;
      runs.push({
        font: font[1]!,
        size: Number(font[2]),
        x: Number(placed[1]),
        y: Number(placed[2]),
        text: decoder.decode(hexBytes(placed[3]!)),
      });
    }
  }
  return runs;
}

async function widthOf(run: TextRun): Promise<number> {
  const doc = await pdfLib.PDFDocument.create();
  const font = await doc.embedFont(run.font === 'Helvetica-Bold' ? pdfLib.StandardFonts.HelveticaBold : pdfLib.StandardFonts.Helvetica);
  return font.widthOfTextAtSize(run.text, run.size);
}

// ---------------------------------------------------------------------------------------------

describe('receipt facts', () => {
  it('reads receipt_facts into the facts a receipt states', () => {
    const { existingReceiptId, status, facts: read } = readReceiptFacts(factsRow(), 'live', NOW);
    expect(existingReceiptId).toBeNull();
    expect(status).toBe('succeeded');
    expect(read).toEqual({
      authorizationId: AUTH_ID,
      projectId: PROJECT,
      projectName: 'Riverside Clinic',
      taskId: 15,
      taskName: 'Erect structural steel frame',
      supplierName: 'Northgate Equipment Rental',
      recipientEmail: 'supplier@test.local',
      currency: 'USD',
      amountMinor: 360000,
      feeMinor: 25,
      batchId: 'BATCH-1',
      itemId: 'ITEM-1',
      transactionId: null,
      paidAt: NOW.toISOString(),
      versionNo: 2,
      rentalRateMinor: 60000,
      billableDays: 6,
      newStart: '2026-12-11',
      newEnd: '2026-12-18',
      datesApproval: { by: 'Priya Mehta', at: '2026-11-02T08:40:00.123Z' },
      paymentApproval: { by: 'Chris Morgan', at: '2026-11-02T08:55:00.000Z' },
      sentBy: { by: 'Chris Morgan', at: '2026-11-02T08:59:00.000Z' },
      mode: 'live',
    });
  });

  it('takes the paid time and transaction id from PayPal when it gave them', () => {
    const batch = batchBody();
    const item = { ...batch.items[0]!, transaction_id: 'TX-9', time_processed: '2026-11-02T08:59:41Z' };
    const read = readReceiptFacts(factsRow({ raw: { ...batch, items: [item] } }), 'live', NOW).facts;
    expect(read.transactionId).toBe('TX-9');
    expect(read.paidAt).toBe('2026-11-02T08:59:41.000Z');
  });

  it('finds our item in a batch read, an item delivered by a webhook, or nothing', () => {
    const other = { payout_item: { sender_item_id: 'someone-else' }, transaction_id: 'TX-OTHER' };
    const ours = { payout_item: { sender_item_id: AUTH_ID }, transaction_id: 'TX-OURS', time_processed: 'not a time' };
    expect(paypalItemDetails({ items: [other, ours] }, AUTH_ID)).toEqual({ transactionId: 'TX-OURS', processedAt: null });
    expect(paypalItemDetails({ transaction_id: 'TX-W', time_processed: '2026-11-02T09:00:00Z' }, AUTH_ID)).toEqual({
      transactionId: 'TX-W',
      processedAt: '2026-11-02T09:00:00.000Z',
    });
    expect(paypalItemDetails({ batch_header: { time_completed: '2026-11-02T09:01:00Z' }, items: [] }, AUTH_ID)).toEqual({
      transactionId: null,
      processedAt: '2026-11-02T09:01:00.000Z',
    });
    expect(paypalItemDetails(null, AUTH_ID)).toEqual({ transactionId: null, processedAt: null });
  });

  it('falls back to "Task {id}" and "Not recorded" when the plan or the history has no answer', () => {
    const read = readReceiptFacts(
      factsRow({ fee_minor: null }, { task: { id: 15, name: null }, schedule_approval: null, authorized_by_name: null }),
      'mock',
      NOW,
    ).facts;
    expect(read.taskName).toBe('Task 15');
    expect(read.datesApproval).toBeNull();
    expect(read.sentBy).toBeNull();
    expect(read.feeMinor).toBeNull();
    const text = receiptText(read);
    expect(text).toContain('Dates approved by: Not recorded');
    expect(text).toContain('PayPal fee (not reported by PayPal): -');
  });

  it('refuses an answer without the payment', () => {
    expect(() => readReceiptFacts({ project: { id: PROJECT } }, 'mock', NOW)).toThrow(ReceiptError);
  });

  it('derives the day rate or the days from the amount paid, and drops a breakdown that does not add up', () => {
    const read = (overrides: Record<string, unknown>, bookingDays?: unknown) => {
      const row = factsRow({}, overrides);
      if (bookingDays !== undefined) row.proposal = { ...row.proposal, booking_days: bookingDays as typeof row.proposal.booking_days };
      return readReceiptFacts(row, 'mock', NOW).facts;
    };
    expect(read({ rental_rate_minor: null })).toMatchObject({ rentalRateMinor: 60000, billableDays: 6 });
    expect(read({}, null)).toMatchObject({ rentalRateMinor: 60000, billableDays: 6 });
    // A longer rental is paid the same way: 12 billable days at $600.
    expect(read({ authorization: { ...factsRow().authorization, amount_minor: 720000 } }, { revised_billable_days: 12 })).toMatchObject({
      rentalRateMinor: 60000,
      billableDays: 12,
    });
    expect(read({ rental_rate_minor: 50000 })).toMatchObject({ rentalRateMinor: null, billableDays: null });
    const unknown = read({ rental_rate_minor: null }, null);
    expect(unknown).toMatchObject({ rentalRateMinor: null, billableDays: null });
    const text = receiptText(unknown);
    expect(text).toContain('Equipment rental for Erect structural steel frame, version 2 of the approved rental dates');
    expect(text).not.toContain('Day rate');
  });
});

describe('receipt wording', () => {
  it('formats days and instants in UTC', () => {
    expect(formatDay('2026-12-11')).toBe('Fri, Dec 11, 2026');
    expect(formatInstant('2026-11-02T09:05:59.999Z')).toBe('Mon, Nov 2, 2026, 9:05 AM UTC');
    expect(['2026-11-02T00:30:00Z', '2026-11-02T12:00:00Z', '2026-11-02T23:59:00Z'].map(formatInstant)).toEqual(['Mon, Nov 2, 2026, 12:30 AM UTC', 'Mon, Nov 2, 2026, 12:00 PM UTC', 'Mon, Nov 2, 2026, 11:59 PM UTC']);
  });

  it('numbers, names and summarizes the receipt', () => {
    const f = facts();
    expect(receiptNumber(f)).toBe('PR-20261102-000005BB');
    expect(receiptSummary(f)).toBe('PayPal payment of $3,600.00 to Northgate Equipment Rental');
    expect(receiptFileName(f)).toBe('Payment receipt - Northgate Equipment Rental - 2026-11-02.pdf');
    expect(receiptFileName(facts({ supplierName: 'A/B: "Equipment" Rental' }))).toBe('Payment receipt - A B Equipment Rental - 2026-11-02.pdf');
  });

  it('states every fact in the plain text', () => {
    const text = receiptText(facts({ transactionId: 'TX-9' }));
    for (const line of [
      'PAYMENT RECEIPT',
      'PayPal sandbox — no real money moved.',
      'Processed by the built-in mock PayPal',
      'Receipt number: PR-20261102-000005BB',
      'Date paid: Mon, Nov 2, 2026, 9:00 AM UTC',
      'Project: Riverside Clinic',
      'Task: Erect structural steel frame (task 15)',
      'Paid to: Northgate Equipment Rental, PayPal account supplier@test.local',
      'Amounts (USD)',
      'Payment to the supplier: $3,600.00',
      'PayPal fee (paid by the project, on top of the payment): $0.25',
      'Total cost to the project: $3,600.25',
      'Net received by the supplier: $3,600.00',
      'The rental',
      'Equipment rental for Erect structural steel frame, version 2 of the approved rental dates: on rent Fri, Dec 11, 2026, off rent Fri, Dec 18, 2026.',
      'Day rate: $600.00',
      'Billable days: 6',
      'Rental paid (6 billable days at $600.00 a day): $3,600.00',
      'Dates approved by: Priya Mehta, project manager, Mon, Nov 2, 2026, 8:40 AM UTC',
      'Payment approved by: Chris Morgan, cost manager, Mon, Nov 2, 2026, 8:55 AM UTC',
      'Payout sent by: Chris Morgan, cost manager, Mon, Nov 2, 2026, 8:59 AM UTC',
      'PayPal payout batch ID: BATCH-1',
      'PayPal payout item ID: ITEM-1',
      'PayPal transaction ID: TX-9',
      `Our payment reference: ${AUTH_ID} (PayPal sender batch and item ID)`,
    ]) {
      expect(text).toContain(line);
    }
    expect(text).not.toMatch(/change fee|delivery|re-book/i);
    expect(receiptText(facts({ billableDays: 1, rentalRateMinor: 60000, amountMinor: 60000 }))).toContain(
      'Rental paid (1 billable day at $600.00 a day): $600.00',
    );
    expect(receiptText(facts({ mode: 'live' }))).toContain('Paid through the PayPal sandbox (api-m.sandbox.paypal.com)');
  });
});

describe('receipt PDF', () => {
  it('is one page that carries the facts, with the amounts right-aligned', async () => {
    const bytes = await renderDocumentPdf(PDF, receiptDocument(facts({ transactionId: 'TX-9' }), NOW));
    const loaded = await pdfLib.PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
    expect(loaded.getTitle()).toBe('Payment receipt PR-20261102-000005BB: $3,600.00 to Northgate Equipment Rental');
    expect(loaded.getCreationDate()?.toISOString()).toBe('2026-11-02T09:00:30.000Z');

    const runs = await textRuns(bytes);
    const all = runs.map((run) => run.text).join('\n');
    for (const expected of [
      'PAYMENT RECEIPT',
      '$3,600.00 paid to Northgate Equipment Rental',
      'PayPal sandbox — no real money moved.',
      'Riverside Clinic · Erect structural steel frame',
      'PR-20261102-000005BB',
      'Payment to the supplier',
      'Total cost to the project',
      '$3,600.25',
      '$0.25',
      'Day rate',
      '$600.00',
      'Billable days',
      'Rental paid',
      '6 billable days at $600.00 a day',
      'Priya Mehta, project manager',
      'Chris Morgan, cost manager',
      'BATCH-1',
      'ITEM-1',
      'TX-9',
      'Page 1 of 1',
    ]) {
      expect(all).toContain(expected);
    }
    const amounts = runs.filter((run) => /^\$[\d,]+\.\d{2}$/.test(run.text) && run.size === 10);
    expect(amounts.length).toBeGreaterThanOrEqual(6);
    for (const run of amounts) {
      expect(run.x + (await widthOf(run))).toBeCloseTo(558, 1);
    }
  });

  it('draws names outside the standard fonts instead of failing', async () => {
    const f = facts({ supplierName: 'Żuraw Dźwigi Sp. z o.o. 起重机', taskName: 'Montaż → stal' });
    const runs = await textRuns(await renderDocumentPdf(PDF, receiptDocument(f, NOW)));
    const all = runs.map((run) => run.text).join('\n');
    expect(all).toContain('Zuraw Dzwigi Sp. z o.o. ???');
    expect(all).toContain('Montaz -> stal');
  });

  it('wraps long text and breaks words longer than a line', async () => {
    const doc = await pdfLib.PDFDocument.create();
    const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
    const lines = wrapText(`short ${'x'.repeat(80)} end`, font, 10, 100);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(100);
    }
    expect(lines.join('')).toBe(`short${'x'.repeat(80)}end`);
    expect(winAnsiText('a\u202fb ≤ c — é', new Set(font.getCharacterSet()))).toBe('a b <= c — é');
  });
});

describe('createReceiptFiler', () => {
  function filer(store: MemoryReceiptStore) {
    let id = 0;
    return createReceiptFiler({
      store,
      pdf: PDF,
      now: () => NOW,
      newId: () => `00000000-0000-4000-8000-00000000e00${++id}`,
    });
  }

  it('renders, uploads into the project folder and files the receipt once', async () => {
    const store = new MemoryReceiptStore(() => factsRow());
    const receipts = filer(store);
    const first = await receipts.file(AUTH_ID, 'mock');
    const path = `${PROJECT}/00000000-0000-4000-8000-00000000e001/payment-receipt.pdf`;
    expect(first).toEqual({ documentId: '00000000-0000-4000-8000-0000000007aa', storagePath: path, created: true });
    expect([...store.uploads.keys()]).toEqual([path]);
    const [request] = store.filed;
    expect(request).toMatchObject({
      authorizationId: AUTH_ID,
      storagePath: path,
      name: 'Payment receipt - Northgate Equipment Rental - 2026-11-02.pdf',
      summary: 'PayPal payment of $3,600.00 to Northgate Equipment Rental',
      sizeBytes: store.uploads.get(path)?.byteLength,
    });
    expect(request?.textContent).toContain('PayPal sandbox — no real money moved.');
    expect(byteString(store.uploads.get(path)!.subarray(0, 5))).toBe('%PDF-');

    const again = await receipts.file(AUTH_ID, 'mock');
    expect(again).toEqual({ documentId: '00000000-0000-4000-8000-0000000007aa', storagePath: null, created: false });
    expect(store.uploads.size).toBe(1);
  });

  it('files nothing for a payout that has not succeeded', async () => {
    const store = new MemoryReceiptStore(() => factsRow({ status: 'pending' }));
    expect(await filer(store).file(AUTH_ID, 'mock')).toBeNull();
    expect(store.uploads.size).toBe(0);
  });

  it('a filer that loses the race removes its own upload and reports the winner', async () => {
    const store = new MemoryReceiptStore(() => factsRow());
    store.beforeFile = () => {
      store.receipt = { id: '00000000-0000-4000-8000-0000000007bb', storagePath: `${PROJECT}/winner/payment-receipt.pdf` };
    };
    const result = await filer(store).file(AUTH_ID, 'live');
    expect(result).toEqual({
      documentId: '00000000-0000-4000-8000-0000000007bb',
      storagePath: `${PROJECT}/winner/payment-receipt.pdf`,
      created: false,
    });
    expect(store.removed).toEqual([`${PROJECT}/00000000-0000-4000-8000-00000000e001/payment-receipt.pdf`]);
    expect(store.uploads.size).toBe(0);
  });

  it('a failed registration removes the upload and reports the failure', async () => {
    const store = new MemoryReceiptStore(() => factsRow());
    store.fileError = new ReceiptError('file_receipt failed: boom');
    await expect(filer(store).file(AUTH_ID, 'mock')).rejects.toThrow('boom');
    expect(store.uploads.size).toBe(0);
  });
});

describe('createSupabaseReceiptStore', () => {
  function client(answers: Record<string, { data: unknown; error: { message: string } | null }>) {
    const calls: { fn: string; args: unknown }[] = [];
    const storageCalls: { op: string; args: unknown[] }[] = [];
    const fake: ReceiptClient = {
      rpc: async (fn, args) => {
        calls.push({ fn, args });
        return answers[fn] ?? { data: null, error: { message: 'not faked' } };
      },
      storage: {
        from: (bucket) => ({
          upload: async (...args) => {
            storageCalls.push({ op: `upload:${bucket}`, args });
            return { error: null };
          },
          remove: async (...args) => {
            storageCalls.push({ op: `remove:${bucket}`, args });
            return { error: null };
          },
        }),
      },
    };
    return { fake, calls, storageCalls };
  }

  it('calls the service-role RPCs and the documents bucket', async () => {
    const document = { id: '00000000-0000-4000-8000-0000000007aa', storage_path: 'p/x/payment-receipt.pdf' };
    const { fake, calls, storageCalls } = client({
      receipt_facts: { data: { ok: true }, error: null },
      file_receipt: { data: { created: true, document }, error: null },
    });
    const store = createSupabaseReceiptStore(fake);
    expect(await store.facts(AUTH_ID)).toEqual({ ok: true });
    await store.upload('p/x/payment-receipt.pdf', new Uint8Array([1]));
    expect(
      await store.file({ authorizationId: AUTH_ID, storagePath: 'p/x/payment-receipt.pdf', name: 'n.pdf', sizeBytes: 1, textContent: 't', summary: 's' }),
    ).toEqual({ created: true, documentId: document.id, storagePath: document.storage_path });
    await store.remove('p/x/payment-receipt.pdf');
    expect(calls).toEqual([
      { fn: 'receipt_facts', args: { p_authorization: AUTH_ID } },
      {
        fn: 'file_receipt',
        args: {
          p_authorization: AUTH_ID, p_storage_path: 'p/x/payment-receipt.pdf', p_name: 'n.pdf', p_size: 1, p_text_content: 't', p_summary: 's',
        },
      },
    ]);
    expect(storageCalls).toEqual([
      { op: 'upload:documents', args: ['p/x/payment-receipt.pdf', new Uint8Array([1]), { contentType: 'application/pdf', upsert: false }] },
      { op: 'remove:documents', args: [['p/x/payment-receipt.pdf']] },
    ]);
  });

  it('turns RPC errors into ReceiptError', async () => {
    const { fake } = client({ receipt_facts: { data: null, error: { message: 'permission denied' } } });
    await expect(createSupabaseReceiptStore(fake).facts(AUTH_ID)).rejects.toThrow(ReceiptError);
  });
});

describe('the handlers file the receipt of a succeeded payout', () => {
  it('execute in mock mode pays and files a real receipt PDF', async () => {
    const store = new FakeStore();
    store.add({ amount_minor: 360000 });
    const receiptStore = new MemoryReceiptStore(() => factsRow(store.row()));
    const execute = createPayoutHandler({
      kind: 'execute',
      env: envOf({ PAYPAL_MODE: 'mock' }),
      fetch: new FakePayPal().fetch,
      store,
      receipts: createReceiptFiler({ store: receiptStore, pdf: PDF, now: () => NOW }),
      resolveUser: async (token) => TOKENS[token] ?? null,
      access: (id, actor, kind) => store.access(id, actor, kind),
    });
    const result = await readJson(await execute(payoutRequest({ authorization_id: AUTH_ID })));
    expect(result).toMatchObject({ mode: 'mock', authorization: { status: 'succeeded' } });
    expect(receiptStore.filed).toHaveLength(1);
    expect(receiptStore.filed[0]?.textContent).toContain(`PayPal payout batch ID: MOCK-B-S-USD-360000-${AUTH_ID}`);
    expect(receiptStore.filed[0]?.textContent).toContain('PayPal fee (paid by the project, on top of the payment): $0.25');
    expect(receiptStore.filed[0]?.textContent).toContain('Rental paid (6 billable days at $600.00 a day): $3,600.00');
    const [bytes] = [...receiptStore.uploads.values()];
    expect((await pdfLib.PDFDocument.load(bytes!)).getPageCount()).toBe(1);
  });

  it('execute and reconcile ask for the receipt only once the payout succeeded', async () => {
    const store = new FakeStore();
    store.add();
    const paypal = new FakePayPal();
    paypal.batch = () => new Response(JSON.stringify(batchBody({ transactionStatus: 'PENDING' })), { status: 200 });
    await payoutHandler('execute', store, paypal)(payoutRequest({ authorization_id: AUTH_ID }));
    expect(store.row().status).toBe('pending');
    expect(store.receipts.calls).toEqual([]);

    paypal.batch = () => new Response(JSON.stringify(batchBody()), { status: 200 });
    await payoutHandler('reconcile', store, paypal)(payoutRequest({ authorization_id: AUTH_ID }, 'pm-token'));
    expect(store.row().status).toBe('succeeded');
    expect(store.receipts.calls).toEqual([{ authorizationId: AUTH_ID, mode: 'live' }]);

    // A refresh of a settled payout asks again; the filer makes that a no-op (or files a missing receipt).
    await payoutHandler('reconcile', store, paypal)(payoutRequest({ authorization_id: AUTH_ID }, 'pm-token'));
    expect(store.receipts.calls).toHaveLength(2);
    expect(store.receipts.filed.size).toBe(1);
  });

  it('a receipt that cannot be filed is logged and never fails the payout response', async () => {
    const store = new FakeStore();
    store.add();
    store.receipts.failure = new Error('storage down');
    const logged: string[] = [];
    const execute = createPayoutHandler({
      kind: 'execute',
      env: envOf(LIVE_ENV),
      fetch: new FakePayPal().fetch,
      store,
      receipts: store.receipts,
      log: (message) => logged.push(message),
      resolveUser: async (token) => TOKENS[token] ?? null,
      access: (id, actor, kind) => store.access(id, actor, kind),
    });
    const response = await execute(payoutRequest({ authorization_id: AUTH_ID }));
    expect(response.status).toBe(200);
    expect((await readJson(response)).authorization).toMatchObject({ status: 'succeeded' });
    expect(logged).toEqual([`filing the payment receipt of ${AUTH_ID} failed; the next status check retries`]);
  });

  it('a success webhook files the receipt; a replayed delivery does not ask again', async () => {
    const store = new FakeStore();
    store.add({ status: 'pending', paypal_batch_id: 'BATCH-1', attempts: 1 });
    const webhook = webhookHandler(store, new FakePayPal());
    const event = JSON.stringify({
      id: 'WH-R-1',
      event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
      resource: { ...batchBody().items[0], transaction_id: 'TX-1' },
    });
    expect(await readJson(await webhook(webhookRequest(event)))).toMatchObject({ recorded: true, status: 'succeeded' });
    expect(await readJson(await webhook(webhookRequest(event)))).toMatchObject({ duplicate: true });
    expect(store.receipts.calls).toEqual([{ authorizationId: AUTH_ID, mode: 'live' }]);
  });

  it('a failure webhook files nothing', async () => {
    const store = new FakeStore();
    store.add({ status: 'pending', paypal_batch_id: 'BATCH-1', attempts: 1 });
    const event = JSON.stringify({
      id: 'WH-R-2',
      event_type: 'PAYMENT.PAYOUTS-ITEM.FAILED',
      resource: { ...batchBody({ transactionStatus: 'FAILED' }).items[0] },
    });
    await webhookHandler(store, new FakePayPal())(webhookRequest(event));
    expect(store.row().status).toBe('failed');
    expect(store.receipts.calls).toEqual([]);
  });
});
