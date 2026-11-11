/**
 * A deterministic, stateless PayPal sandbox for PAYPAL_MODE=mock: a `fetch` that answers the four
 * endpoints the functions call, in PayPal's shapes, without touching the network.
 *
 * Function invocations can land in fresh isolates, so the mock remembers nothing. The outcome is
 * chosen from the recipient when the payout is created and encoded in the ids it returns:
 *
 *   batch id  MOCK-B-<S|F|U|P>-<currency>-<amount minor>-<sender_batch_id>
 *   item id   MOCK-I-<S|F|U|P>-<currency>-<amount minor>-<sender_batch_id>
 *
 * so `GET /v1/payments/payouts/{batch}` answers from the id alone, and the same request always gets
 * the same answer (PayPal-Request-Id idempotency for free).
 *
 * A progress payment's batch pays several firms, each item's sender_item_id being `<sender_batch_id>-<n>`
 * (n from 1, in order): its id lists each item's outcome and amount,
 * MOCK-M-<currency>-<S|F|U|P><amount minor>.<...>-<sender_batch_id>.
 *
 * Recipients: an address containing `+fail@` fails with RECEIVER_UNREGISTERED, `+unclaimed@` stays
 * UNCLAIMED, `+pending@` stays PENDING, and any other address succeeds. Every item that is not
 * failed reports a fee of MOCK_FEE_VALUE; a failed item reports 0.00. Webhook signatures verify,
 * except a `paypal-transmission-sig` of MOCK_INVALID_SIGNATURE.
 *
 * Invoices are stateless the same way: the id carries the request id, every invoice reads as sent
 * and unpaid, and its payer link stays on this mock's own host. A cancel is answered 204 as PayPal
 * does; with no memory, a later read still says unpaid, so the canceled row is what records it.
 */
import { asObject, text } from './json.ts';
import { PAYPAL_SANDBOX_API, type Fetch } from './paypal.ts';

export const MOCK_ACCESS_TOKEN = 'MOCK-ACCESS-TOKEN';
export const MOCK_FEE_VALUE = '0.25';
export const MOCK_INVALID_SIGNATURE = 'MOCK-INVALID';
export const MOCK_WEBHOOK_ID = 'MOCK-WEBHOOK';

type Outcome = 'S' | 'F' | 'U' | 'P';

const TRANSACTION_STATUS: Readonly<Record<Outcome, string>> = {
  S: 'SUCCESS',
  F: 'FAILED',
  U: 'UNCLAIMED',
  P: 'PENDING',
};

export function mockOutcomeFor(recipient: string): Outcome {
  if (recipient.includes('+fail@')) return 'F';
  if (recipient.includes('+unclaimed@')) return 'U';
  if (recipient.includes('+pending@')) return 'P';
  return 'S';
}

const BATCH_ID_RE = /^MOCK-B-([SFUP])-([A-Z]{3})-(\d+)-(.+)$/;
const DECIMAL_2_RE = /^\d+\.\d{2}$/;

export const mockPayPalFetch: Fetch = async (url, init) => {
  if (!url.startsWith(PAYPAL_SANDBOX_API)) {
    return reply(404, { name: 'RESOURCE_NOT_FOUND', message: `The mock PayPal only serves ${PAYPAL_SANDBOX_API}.` });
  }
  const path = url.slice(PAYPAL_SANDBOX_API.length);
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);

  if (method === 'POST' && path === '/v1/oauth2/token') {
    if (!(headers.get('authorization') ?? '').startsWith('Basic ')) {
      return reply(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
    }
    return reply(200, {
      scope: 'https://uri.paypal.com/services/payments/payouts',
      access_token: MOCK_ACCESS_TOKEN,
      token_type: 'Bearer',
      app_id: 'APP-MOCK',
      expires_in: 32400,
    });
  }
  if (headers.get('authorization') !== `Bearer ${MOCK_ACCESS_TOKEN}`) {
    return reply(401, {
      name: 'AUTHENTICATION_FAILURE',
      message: 'Authentication failed due to invalid authentication credentials or a missing Authorization header.',
    });
  }
  if (method === 'POST' && path === '/v1/payments/payouts') {
    return createPayout(headers, parse(init.body));
  }
  if (method === 'GET' && path.startsWith('/v1/payments/payouts/')) {
    const batchId = decodeURIComponent(path.slice('/v1/payments/payouts/'.length));
    return batchId.startsWith('MOCK-M-') ? getProgressBatch(batchId) : getBatch(batchId);
  }
  if (method === 'POST' && path === '/v1/notifications/verify-webhook-signature') {
    const body = asObject(parse(init.body));
    if (Object.keys(asObject(body.webhook_event)).length === 0) {
      return validationError('webhook_event', 'MISSING_REQUIRED_PARAMETER', 'The webhook event is missing.');
    }
    return reply(200, {
      verification_status: body.transmission_sig === MOCK_INVALID_SIGNATURE ? 'FAILURE' : 'SUCCESS',
    });
  }
  if (path.startsWith('/v2/invoicing/invoices')) {
    return invoiceReply(method, path.slice('/v2/invoicing/invoices'.length), headers);
  }
  return reply(404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.' });
};

function invoiceReply(method: string, rest: string, headers: Headers): Response {
  if (method === 'POST' && rest === '') {
    const id = `MOCK-INV-${headers.get('paypal-request-id') ?? 'none'}`;
    return reply(201, { id, status: 'DRAFT', detail: { invoice_number: id.slice(-8).toUpperCase(), metadata: {} } });
  }
  const match = /^\/([^/]+)(\/send|\/cancel)?$/.exec(rest);
  if (match === null) return reply(404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.' });
  const id = decodeURIComponent(match[1]!);
  if (method === 'POST' && match[2] === '/cancel') return new Response(null, { status: 204 });
  if (method === 'POST' && match[2] === '/send') return reply(200, { rel: 'payer-view', method: 'GET', href: `${PAYPAL_SANDBOX_API}/invoice/p/#${id}` });
  if (method === 'GET' && !match[2]) {
    return reply(200, { id, status: 'UNPAID', detail: { invoice_number: id.slice(-8).toUpperCase(), metadata: { recipient_view_url: `${PAYPAL_SANDBOX_API}/invoice/p/#${id}` } } });
  }
  return reply(404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.' });
}

function createPayout(headers: Headers, body: unknown): Response {
  if (!headers.get('paypal-request-id')) {
    return validationError('PayPal-Request-Id', 'MISSING_REQUIRED_PARAMETER', 'The mock expects an idempotency key.');
  }
  const header = asObject(asObject(body).sender_batch_header);
  const items = asObject(body).items;
  const firstItemId = Array.isArray(items) ? text(asObject(items[0]).sender_item_id) : null;
  // A progress payment's batch: several firms, or one whose item id is the batch's own with its number.
  if (Array.isArray(items) && (items.length > 1 || (firstItemId !== null && firstItemId !== text(header.sender_batch_id)))) {
    return createProgressBatch(header, items);
  }
  const item = asObject(Array.isArray(items) && items.length === 1 ? items[0] : null);
  const amount = asObject(item.amount);
  const senderBatchId = text(header.sender_batch_id);
  const receiver = text(item.receiver);
  const value = text(amount.value);
  const currency = text(amount.currency);
  if (senderBatchId === null) {
    return validationError('sender_batch_header.sender_batch_id', 'MISSING_REQUIRED_PARAMETER', 'Required.');
  }
  if (item.recipient_type !== 'EMAIL' || receiver === null || !receiver.includes('@')) {
    return validationError('items[0].receiver', 'INVALID_PARAMETER_VALUE', 'One EMAIL item with a receiver email.');
  }
  if (value === null || !DECIMAL_2_RE.test(value) || currency === null || !/^[A-Z]{3}$/.test(currency)) {
    return validationError('items[0].amount', 'INVALID_PARAMETER_VALUE', 'An amount with two decimals and a currency.');
  }
  if (text(item.sender_item_id) === null) {
    return validationError('items[0].sender_item_id', 'MISSING_REQUIRED_PARAMETER', 'Required.');
  }
  const minor = value.replace('.', '').replace(/^0+(?=\d)/, '');
  const batchId = `MOCK-B-${mockOutcomeFor(receiver)}-${currency}-${minor}-${senderBatchId}`;
  return reply(201, {
    batch_header: {
      payout_batch_id: batchId,
      batch_status: 'PENDING',
      sender_batch_header: {
        sender_batch_id: senderBatchId,
        email_subject: text(header.email_subject),
        email_message: text(header.email_message),
      },
    },
    links: [{ href: `${PAYPAL_SANDBOX_API}/v1/payments/payouts/${batchId}`, rel: 'self', method: 'GET' }],
  });
}

function getBatch(batchId: string): Response {
  const match = BATCH_ID_RE.exec(batchId);
  if (match === null) {
    return reply(404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.' });
  }
  const [, outcomeCode, currency, minor, senderBatchId] = match as unknown as [string, Outcome, string, string, string];
  const status = TRANSACTION_STATUS[outcomeCode];
  const failed = outcomeCode === 'F';
  const digits = minor.padStart(3, '0');
  const amount = { value: `${digits.slice(0, -2)}.${digits.slice(-2)}`, currency };
  const fee = { value: failed ? '0.00' : MOCK_FEE_VALUE, currency };
  return reply(200, {
    batch_header: {
      payout_batch_id: batchId,
      batch_status: outcomeCode === 'P' ? 'PROCESSING' : 'SUCCESS',
      sender_batch_header: { sender_batch_id: senderBatchId },
      amount,
      fees: fee,
    },
    items: [
      {
        payout_item_id: batchId.replace('MOCK-B-', 'MOCK-I-'),
        transaction_status: status,
        payout_item_fee: fee,
        payout_batch_id: batchId,
        payout_item: { recipient_type: 'EMAIL', amount, sender_item_id: senderBatchId },
        ...(failed
          ? { errors: { name: 'RECEIVER_UNREGISTERED', message: 'Receiver is unregistered', details: [] } }
          : {}),
      },
    ],
  });
}

const PROGRESS_ID_RE = /^MOCK-M-([A-Z]{3})-([SFUP]\d+(?:\.[SFUP]\d+)*)-(.+)$/;

/** A progress payment's batch: each item to its firm, its sender_item_id `<sender_batch_id>-<n>`, its outcome by its receiver. */
function createProgressBatch(header: Readonly<Record<string, unknown>>, items: unknown[]): Response {
  const senderBatchId = text(header.sender_batch_id);
  if (senderBatchId === null) {
    return validationError('sender_batch_header.sender_batch_id', 'MISSING_REQUIRED_PARAMETER', 'Required.');
  }
  if (items.length === 0 || items.length > 15) {
    return validationError('items', 'INVALID_PARAMETER_VALUE', 'The mock pays 1 to 15 items in a batch.');
  }
  let currency: string | null = null;
  const codes: string[] = [];
  for (const [index, raw] of items.entries()) {
    const item = asObject(raw);
    const amount = asObject(item.amount);
    const receiver = text(item.receiver);
    const value = text(amount.value);
    if (item.recipient_type !== 'EMAIL' || receiver === null || !receiver.includes('@')) {
      return validationError(`items[${index}].receiver`, 'INVALID_PARAMETER_VALUE', 'An EMAIL item with a receiver email.');
    }
    if (value === null || !DECIMAL_2_RE.test(value) || text(amount.currency) === null || (currency !== null && amount.currency !== currency)) {
      return validationError(`items[${index}].amount`, 'INVALID_PARAMETER_VALUE', 'An amount with two decimals, in the batch’s one currency.');
    }
    if (text(item.sender_item_id) !== `${senderBatchId}-${index + 1}`) {
      return validationError(`items[${index}].sender_item_id`, 'INVALID_PARAMETER_VALUE', 'The mock expects <sender_batch_id>-<n>, n from 1.');
    }
    currency = text(amount.currency);
    codes.push(`${mockOutcomeFor(receiver)}${value.replace('.', '').replace(/^0+(?=\d)/, '')}`);
  }
  const batchId = `MOCK-M-${currency}-${codes.join('.')}-${senderBatchId}`;
  return reply(201, {
    batch_header: {
      payout_batch_id: batchId,
      batch_status: 'PENDING',
      sender_batch_header: { sender_batch_id: senderBatchId, email_subject: text(header.email_subject), email_message: text(header.email_message) },
    },
    links: [{ href: `${PAYPAL_SANDBOX_API}/v1/payments/payouts/${batchId}`, rel: 'self', method: 'GET' }],
  });
}

function getProgressBatch(batchId: string): Response {
  const match = PROGRESS_ID_RE.exec(batchId);
  if (match === null) {
    return reply(404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.' });
  }
  const [, currency, codes, senderBatchId] = match as unknown as [string, string, string, string];
  const decimal = (minor: number) => {
    const digits = String(minor).padStart(3, '0');
    return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  };
  const items = codes.split('.').map((code, index) => {
    const outcome = code[0] as Outcome;
    const failed = outcome === 'F';
    const amount = { value: decimal(Number(code.slice(1))), currency };
    return {
      payout_item_id: `MOCK-I-${index + 1}-${senderBatchId}`,
      transaction_status: TRANSACTION_STATUS[outcome],
      ...(outcome === 'S' ? { transaction_id: `MOCKTX${index + 1}${senderBatchId.replace(/[^A-Z0-9]/gi, '').slice(-8).toUpperCase()}` } : {}),
      payout_item_fee: { value: failed ? '0.00' : MOCK_FEE_VALUE, currency },
      payout_batch_id: batchId,
      payout_item: { recipient_type: 'EMAIL', amount, sender_item_id: `${senderBatchId}-${index + 1}` },
      ...(failed ? { errors: { name: 'RECEIVER_UNREGISTERED', message: 'Receiver is unregistered', details: [] } } : {}),
    };
  });
  const feeMinor = items.reduce((sum, item) => sum + Math.round(Number(item.payout_item_fee.value) * 100), 0);
  const total = codes.split('.').reduce((sum, code) => sum + Number(code.slice(1)), 0);
  return reply(200, {
    batch_header: {
      payout_batch_id: batchId,
      batch_status: items.some((item) => item.transaction_status === 'PENDING') ? 'PROCESSING' : 'SUCCESS',
      sender_batch_header: { sender_batch_id: senderBatchId },
      amount: { value: decimal(total), currency },
      fees: { value: decimal(feeMinor), currency },
    },
    items,
  });
}

function validationError(field: string, issue: string, description: string): Response {
  return reply(400, {
    name: 'VALIDATION_ERROR',
    message: 'Invalid request - see details',
    details: [{ field, issue, description }],
  });
}

function parse(body: RequestInit['body']): unknown {
  if (typeof body !== 'string') {
    return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
