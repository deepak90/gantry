/**
 * Files the seed projects' documents: the supplier's quote for each rental that has one, a one-page
 * PDF for the rental as booked (day rate, days and dates), not invoiced yet: nothing is due until
 * the rental dates are confirmed, then the rental as confirmed is paid through PayPal; the dates are
 * free to move or shorten before delivery. Each is uploaded to the private `documents` bucket and
 * registered as a project_documents row (kind quote, cost-sensitive, linked to its task, its text kept
 * for the AI agent), with fixed ids, so reset_demo keeps it and a second run changes nothing (a quote
 * filed with another summary or text, an older wording or another addressee, is replaced). Uses the service role key from the
 * repo-root .env.local.
 *
 *   node --env-file-if-exists=.env.local scripts/seed-documents.ts
 *
 * `pnpm db:reset` and `pnpm demo:reset` run it after resetting. The layout is the one the payment
 * receipt uses (supabase/functions/_shared/pdf.ts), rendered here with the root pdf-lib.
 */
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { rentalDays } from '../packages/shared/src/rental-days.ts';
import { addDays, CEDAR_IDS, CEDAR_QUOTES, cedarParkClinic, HARBOR_COPIES, HARBOR_IDS, HARBOR_QUOTES, harborOffices, riversideClinic, SEED_IDS, type SeedEquipmentBooking, type SeedProject } from '../packages/shared/src/seed/index.ts';
import { formatMoney } from '../supabase/functions/_shared/amounts.ts';
import { renderDocumentPdf, type DocumentSpec } from '../supabase/functions/_shared/pdf.ts';
import { formatDay } from '../supabase/functions/_shared/receipt.ts';

const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local (values from `supabase status -o env`).');
  process.exit(1);
}

const BUCKET = 'documents';
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

// ---------------------------------------------------------------------------------------------
// The quotes
// ---------------------------------------------------------------------------------------------

interface Task {
  id: number | string;
  name?: string;
  children?: Task[];
}

function taskName(tasks: readonly Task[], id: number): string | null {
  for (const task of tasks) {
    if (task.id === id && task.name) return task.name;
    const found = taskName(task.children ?? [], id);
    if (found !== null) return found;
  }
  return null;
}

interface Quote {
  project: SeedProject;
  projectId: string;
  documentId: string;
  booking: SeedEquipmentBooking;
  number: string;
  equipment: string;
}

const QUOTES: Quote[] = [
  { project: riversideClinic, projectId: SEED_IDS.project, documentId: SEED_IDS.quoteDocument, booking: riversideClinic.booking, number: 'NER-Q-26-0412', equipment: 'Crane with operator, for the steel frame erection' },
  ...CEDAR_QUOTES.map((quote) => ({ project: cedarParkClinic, projectId: CEDAR_IDS.project, documentId: quote.documentId, booking: quote.booking, number: quote.number, equipment: quote.equipment })),
  ...HARBOR_QUOTES.map((quote) => ({ project: harborOffices, projectId: HARBOR_IDS.project, documentId: quote.documentId, booking: quote.booking, number: quote.number, equipment: quote.equipment })),
  // Each private copy of Harbor has the same quote, filed under ids of its own.
  ...HARBOR_COPIES.flatMap((copy) =>
    copy.quotes.map((quote) => ({ project: copy.project, projectId: copy.ids.project, documentId: quote.documentId, booking: quote.booking, number: quote.number, equipment: quote.equipment })),
  ),
];

/** Issued on the day the seed is filed. */
const issued = new Date();
const issuedDay = issued.toISOString().slice(0, 10);

function render({ project, booking, number, equipment }: Quote) {
  const task = taskName(project.inlineData.tasksData as Task[], booking.task_id) ?? `Task ${booking.task_id}`;
  const money = (minor: number) => formatMoney(minor, booking.currency);
  const supplier = booking.supplier_name;
  const days = rentalDays(booking.billable_start, booking.billable_end);
  const lastDay = addDays(booking.billable_end, -1);
  const lines = {
    booking: [
      { label: 'Equipment', value: equipment },
      { label: 'On rent', value: formatDay(booking.billable_start) },
      { label: 'Last day on rent', value: formatDay(lastDay) },
      { label: 'Off rent', value: formatDay(booking.billable_end) },
      { label: 'Days on rent', value: `${days}, weekends included` },
    ],
    rental: [
      { label: 'Day rate', detail: 'per day on rent, operator included', amount: money(booking.rental_rate_minor) },
      { label: 'Days booked', detail: 'weekends included', amount: String(days) },
      { label: 'Rental as booked', detail: `${days} days at ${money(booking.rental_rate_minor)}`, amount: money(booking.rental_rate_minor * days), strong: true, ruleAbove: true },
    ],
    rentalNote: 'You pay the day rate for every day of the rental as confirmed, weekends included: fewer days cost less, extra days are charged at the same rate. Delivery to the site and pickup are included.',
    payment: [
      'Not invoiced yet: nothing is due until the rental dates are confirmed. The rental as confirmed is then payable through PayPal, to the account on file.',
      'The rental dates can be moved or shortened free of charge until the equipment is delivered to site.',
      'Prices in USD. Quote this number when you confirm the dates.',
    ],
  };
  const summary = `${supplier} quotation: ${equipment.split(',')[0]!.toLowerCase()} at ${money(booking.rental_rate_minor)} a day, ${days} days from ${formatDay(booking.billable_start)}, nothing due until the dates are confirmed`;
  const spec: DocumentSpec = {
    title: `${supplier} — Quotation ${number}`,
    eyebrow: 'QUOTATION',
    heading: `${supplier} — Quotation`,
    subheading: `Rental for ${project.name} · ${task}`,
    references: [
      { label: 'Quote no.', value: number },
      { label: 'Date', value: formatDay(issuedDay) },
      { label: 'Status', value: 'Booked, not invoiced' },
    ],
    parties: [
      { label: 'From', lines: [supplier, 'Equipment rental'] },
      { label: 'To', lines: [`${project.name} project`, 'Attn: Deepak Jayaram'] },
    ],
    sections: [
      { kind: 'fields', title: 'Your booking', fields: lines.booking },
      { kind: 'amounts', title: 'Rental', lines: lines.rental, note: lines.rentalNote },
      { kind: 'text', title: 'Payment and changes', paragraphs: lines.payment },
    ],
    footer: [],
    author: supplier,
    createdAt: issued,
  };
  const textContent = [
    `${supplier.toUpperCase()} — QUOTATION`,
    `Quote number: ${number}`,
    `Date: ${formatDay(issuedDay)}`,
    'Status: booked, not invoiced',
    `To: ${project.name} project, attn: Deepak Jayaram`,
    `Subject: rental for ${task} (task ${booking.task_id})`,
    '',
    'Your booking',
    ...lines.booking.map((field) => `${field.label}: ${field.value}`),
    '',
    'Rental (USD)',
    ...lines.rental.map((line) => `${line.label}${line.detail ? ` (${line.detail})` : ''}: ${line.amount}`),
    lines.rentalNote,
    '',
    'Payment and changes',
    ...lines.payment,
  ].join('\n');
  return { spec, textContent, summary, objectName: `${booking.evidence_path?.split('/').pop() ?? 'quote.pdf'}` };
}

// ---------------------------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------------------------

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  // Right after `supabase db reset` the API containers can take a few seconds to answer again.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(`${url}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
      if (response.status < 500 || attempt >= 15) {
        return response;
      }
    } catch (error) {
      if (attempt >= 15) {
        console.error(`Cannot reach Supabase at ${url}: ${error instanceof Error ? error.message : String(error)} (is \`pnpm db:start\` running?)`);
        process.exit(1);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function ok(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    console.error(`${what} failed (HTTP ${response.status}): ${await response.text()}`);
    process.exit(1);
  }
  return response;
}

for (const quote of QUOTES) {
  const { spec, textContent, summary, objectName } = render(quote);
  const storagePath = `${quote.projectId}/${quote.documentId}/${objectName}`;
  const rowResponse = await ok(await request(`/rest/v1/project_documents?id=eq.${quote.documentId}&select=id,storage_path,summary,text_content`), 'Reading the seed documents');
  const rows = (await rowResponse.json()) as { id: string; storage_path: string; summary: string | null; text_content: string | null }[];
  const listed = await ok(
    await request(`/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: `${quote.projectId}/${quote.documentId}`, limit: 10 }),
    }),
    'Listing the documents bucket',
  );
  const objects = (await listed.json()) as { name: string }[];
  // Filed as it reads now (its summary and its text, the person it is addressed to included): nothing to do.
  if (rows.length > 0 && objects.some((object) => object.name === objectName) && rows[0]?.summary === summary && rows[0]?.text_content === textContent) {
    console.log(`Already filed: ${storagePath}.`);
    continue;
  }
  const bytes = await renderDocumentPdf({ PDFDocument, StandardFonts, rgb }, spec);
  await ok(
    await request(`/storage/v1/object/${BUCKET}/${storagePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'true', 'cache-control': 'max-age=60' },
      body: bytes,
    }),
    'Uploading the supplier quote',
  );
  // Upsert on the fixed id: a row whose file had gone missing is refreshed along with the new file.
  await ok(
    await request('/rest/v1/project_documents?on_conflict=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        id: quote.documentId,
        project_id: quote.projectId,
        task_id: quote.booking.task_id,
        kind: 'quote',
        name: `${quote.booking.supplier_name} - Quotation ${quote.number}.pdf`,
        mime_type: 'application/pdf',
        size_bytes: bytes.byteLength,
        storage_path: storagePath,
        cost_sensitive: true,
        text_content: textContent,
        summary,
        created_by: null,
        created_via: 'system',
      }),
    }),
    'Registering the supplier quote',
  );
  console.log(`Filed the quote for task ${quote.booking.task_id} at ${BUCKET}/${storagePath} (${bytes.byteLength} bytes).`);
}
