/**
 * What keeps the assistant's PayPal access read-only. The key it holds (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, the
 * sandbox REST app the Edge Functions pay and bill with) can do at PayPal whatever that app can: PayPal has no read-only
 * key. So every request the assistant's PayPal code makes is checked against an allowlist, `readOnlyRequest`, before it
 * leaves the process:
 *
 *   - PayPal's Agent Toolkit sends its requests with its own copy of axios. `guardToolkitAxios` adds the check to that
 *     copy as a request interceptor, allowing it to read one invoice and nothing else. The toolkit's action settings
 *     only choose which tools it lists: its handler runs any tool it is asked for, a send or a delete included, so they
 *     are not what keeps it read-only. This is.
 *   - The payout and order reads go through `readOnlyFetch`, the fetch the shared PayPal client is given, allowing it
 *     to read one payout batch or one order.
 *
 * Allowed: signing in (POST /v1/oauth2/token with the client-credentials grant) and a GET of one object by its id, on
 * PayPal's sandbox hosts. Nothing else: no other method, path, host or query, so no listing or searching the account
 * either. A refused request throws `ReadOnlyRefusal` and is never sent.
 */
import { createRequire } from 'node:module';

/** PayPal's sandbox API hosts: the toolkit uses the first, the shared client the second. Production is never allowed. */
export const PAYPAL_SANDBOX_HOSTS: ReadonlySet<string> = new Set(['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com']);

/** The reads there are, each one object by its id. */
export type PayPalRead = 'invoice' | 'payout' | 'order';
const READS: Record<PayPalRead, RegExp> = {
  invoice: /^\/v2\/invoicing\/invoices\/([^/]+)$/,
  payout: /^\/v1\/payments\/payouts\/([^/]+)$/,
  order: /^\/v2\/checkout\/orders\/([^/]+)$/,
};

/** What the toolkit may read, and what the shared client may read. */
export const TOOLKIT_READS: readonly PayPalRead[] = ['invoice'];
export const CLIENT_READS: readonly PayPalRead[] = ['payout', 'order'];

/** An id as PayPal writes them (an invoice's INV2-…, a payout batch's, an order's): capitals, digits and dashes. */
const PAYPAL_ID = /^[A-Z0-9][A-Z0-9-]{5,59}$/;

/** Whether a stored id is one PayPal gave (ids made while PayPal was mocked start with MOCK-, and PayPal never saw them). */
export function isPayPalId(id: string | null | undefined): id is string {
  return typeof id === 'string' && PAYPAL_ID.test(id) && !id.startsWith('MOCK-');
}

const SIGN_IN = '/v1/oauth2/token';
const SIGN_IN_BODY = 'grant_type=client_credentials';

export class ReadOnlyRefusal extends Error {
  constructor(reason: string) {
    super(`Refused by the read-only PayPal guard: ${reason}. Nothing was sent.`);
    this.name = 'ReadOnlyRefusal';
  }
}

export type Verdict = { ok: true } | { ok: false; reason: string };

const no = (reason: string): Verdict => ({ ok: false, reason });

/** The allowlist: whether this request may go to PayPal, for a client allowed these reads. */
export function readOnlyRequest(request: { method?: string | undefined; url: string; body?: unknown }, reads: readonly PayPalRead[]): Verdict {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return no('not a full URL');
  }
  const method = (request.method ?? 'GET').toUpperCase();
  if (url.protocol !== 'https:' || !PAYPAL_SANDBOX_HOSTS.has(url.hostname) || url.port !== '' || url.username || url.password) {
    return no(`${url.origin} is not PayPal's sandbox`);
  }
  if (url.search || url.hash) return no('a query is not one of the reads');
  if (url.pathname === SIGN_IN) {
    return method === 'POST' && request.body === SIGN_IN_BODY ? { ok: true } : no('signing in takes the client-credentials grant only');
  }
  if (method !== 'GET') return no(`${method} ${url.pathname} is not a read`);
  const id = reads.map((read) => READS[read].exec(url.pathname)?.[1]).find((match) => match !== undefined);
  if (id === undefined) return no(`GET ${url.pathname} is not one of the reads allowed here (${reads.join(', ')}, one by its id)`);
  if (!isPayPalId(id)) return no('that is not a PayPal id');
  return { ok: true };
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** A fetch that sends only what `readOnlyRequest` allows these reads, for the shared PayPal client. */
export function readOnlyFetch(fetch: Fetch, reads: readonly PayPalRead[] = CLIENT_READS): Fetch {
  return (url, init) => {
    const verdict = readOnlyRequest({ method: init.method, url, body: init.body }, reads);
    return verdict.ok ? fetch(url, init) : Promise.reject(new ReadOnlyRefusal(verdict.reason));
  };
}

/** The parts of an axios request this check reads (axios's own config type is the toolkit's dependency, not ours). */
export interface AxiosRequestLike {
  method?: string | undefined;
  url?: string | undefined;
  baseURL?: string | undefined;
  params?: unknown;
  data?: unknown;
}

export interface AxiosLike {
  interceptors: { request: { use(onFulfilled: (config: AxiosRequestLike) => AxiosRequestLike): number } };
}

const hasParams = (params: unknown) =>
  params instanceof URLSearchParams ? [...params.keys()].length > 0 : params !== null && typeof params === 'object' && Object.keys(params).length > 0;

/** The check as an axios request interceptor: a refused request throws before axios sends it. */
export function readOnlyInterceptor(reads: readonly PayPalRead[]): (config: AxiosRequestLike) => AxiosRequestLike {
  return (config) => {
    let url: string;
    try {
      url = config.baseURL ? new URL(config.url ?? '', config.baseURL).href : String(config.url ?? '');
    } catch {
      throw new ReadOnlyRefusal('not a full URL');
    }
    const verdict = hasParams(config.params) ? no('a query is not one of the reads') : readOnlyRequest({ method: config.method, url, body: config.data }, reads);
    if (!verdict.ok) throw new ReadOnlyRefusal(verdict.reason);
    return config;
  };
}

const guarded = new WeakSet<object>();

/** Adds the check to an axios instance, once. */
export function guardAxios(axios: AxiosLike, reads: readonly PayPalRead[]): void {
  if (guarded.has(axios)) return;
  axios.interceptors.request.use(readOnlyInterceptor(reads));
  guarded.add(axios);
}

/** The axios the toolkit sends with: its own dependency, resolved from where the toolkit is installed. */
export function toolkitAxios(): AxiosLike {
  const toolkit = createRequire(import.meta.url).resolve('@paypal/agent-toolkit/openai');
  return createRequire(toolkit)('axios') as AxiosLike;
}

/** Guards the toolkit's axios to reading one invoice; call before the toolkit is used. Throws if it can't, so it is never used unguarded. */
export function guardToolkitAxios(): void {
  const axios = toolkitAxios();
  if (typeof axios?.interceptors?.request?.use !== 'function') throw new Error('The PayPal toolkit’s HTTP client could not be guarded, so it is not used.');
  guardAxios(axios, TOOLKIT_READS);
}
