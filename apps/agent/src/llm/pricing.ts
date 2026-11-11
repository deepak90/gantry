/**
 * What the assistant's model calls cost, from the token counts the API returns: the one price table the service keeps.
 * The hosted site records each turn's cost (and each thread title's) in its daily spend ledger (hosted.ts), which
 * switches live AI off for the day once the day's budget is spent.
 *
 * Prices are Anthropic's list prices in dollars per million tokens (checked 2026-11-11). Cache writes cost 1.25 times
 * the input price for a 5-minute entry and twice it for a 1-hour one; cache reads cost 0.05 times on these models.
 * A model missing from the table is priced at the dearest list price there is, so the budget errs on the safe side.
 */
import type Anthropic from '@anthropic-ai/sdk';

/** Dollars per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
};

/** For a model the table doesn't list: the dearest list price there is ($10 in, $50 out). */
export const UNLISTED_PRICE: ModelPrice = { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 };

/** Tokens one call, or one turn, used. */
export interface TokenUsage {
  /** Input tokens not read from the cache (nor written to it). */
  input: number;
  /** Output tokens, thinking included. */
  output: number;
  cacheRead: number;
  /** Every token written to the cache, 5-minute and 1-hour entries together. */
  cacheWrite: number;
  /** The part of cacheWrite written to 1-hour entries. */
  cacheWrite1h: number;
}

export const NO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };

/** One response's usage. When the API leaves out how the cache writes split, they are counted as 1-hour (the dearer). */
export function usageOf(usage: Anthropic.Beta.Messages.BetaUsage): TokenUsage {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const split = usage.cache_creation;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite,
    cacheWrite1h: split ? Math.min(cacheWrite, split.ephemeral_1h_input_tokens ?? 0) : cacheWrite,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  };
}

export function priceOf(model: string): ModelPrice {
  return Object.hasOwn(PRICES, model) ? PRICES[model]! : UNLISTED_PRICE;
}

/**
 * What the usage cost, in millionths of a dollar, rounded up. Dollars per million tokens times tokens is exactly that.
 */
export function costMicroUsd(model: string, usage: TokenUsage): number {
  const price = priceOf(model);
  const write1h = Math.min(usage.cacheWrite1h, usage.cacheWrite);
  const micro =
    usage.input * price.input +
    usage.output * price.output +
    usage.cacheRead * price.cacheRead +
    (usage.cacheWrite - write1h) * price.cacheWrite5m +
    write1h * price.cacheWrite1h;
  return Math.ceil(micro);
}
