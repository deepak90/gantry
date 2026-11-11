/**
 * Reading untyped JSON (PayPal bodies, RPC results, request bodies) without trusting its shape:
 * every accessor answers null or an empty object instead of throwing on a missing branch.
 */

export type JsonObject = Readonly<Record<string, unknown>>;

const EMPTY: JsonObject = Object.freeze({});

export function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : EMPTY;
}

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A non-empty string, or null. */
export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
