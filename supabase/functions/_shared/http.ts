/**
 * HTTP plumbing shared by the functions: JSON responses, and the one error shape every failure takes:
 * `{ error, code }` with an HTTP status, plus `request_id` on a failure nobody planned for (failures.ts), whose
 * detail goes to the log only. Which browser origins may call is cors.ts.
 */
import { asObject, isUuid } from './json.ts';

/** Where a function writes what went wrong; never what a browser sees. */
export type Log = (message: string, error?: unknown) => void;

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'METHOD_NOT_ALLOWED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PAYPAL_NOT_CONFIGURED'
  | 'PAYPAL_AUTH_FAILED'
  | 'PAYPAL_UNAVAILABLE'
  | 'WEBHOOK_NOT_CONFIGURED'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_UNAVAILABLE'
  | 'PAYPAL_REFUSED'
  | 'INVOICE_STATE_CONFLICT'
  | 'PAYOUT_REFUSED'
  | 'PAYEE_REFUSED'
  | 'PAYMENTS_OFF'
  | 'QUOTA_REACHED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** The id a failure's log line carries, for a person to quote (failures.ts); null for an expected refusal. */
  readonly requestId: string | null;

  constructor(status: number, code: ErrorCode, message: string, requestId: string | null = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function json(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

export function errorResponse(error: HttpError, headers: Readonly<Record<string, string>> = {}): Response {
  return json(error.status, { error: error.message, code: error.code, ...(error.requestId ? { request_id: error.requestId } : {}) }, headers);
}

/** The `{ "authorization_id": uuid }` body of the payout functions. */
export async function readAuthorizationId(request: Request): Promise<string> {
  let body: unknown;
  try {
    body = JSON.parse(await request.text()) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', 'The body must be JSON: { "authorization_id": "<uuid>" }.');
  }
  const id = asObject(body).authorization_id;
  if (!isUuid(id)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'authorization_id must be the uuid of a payment authorization.');
  }
  return id.toLowerCase();
}

/** The access token of `Authorization: Bearer <jwt>`, or null. */
export function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  return match?.[1] ?? null;
}
