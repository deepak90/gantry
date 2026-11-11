/**
 * Waiting, for the walkthrough: a pause that Previous cuts short, and a wait for something to show up on
 * screen (an answer from the assistant, a card, a row) that gives up with a plain message.
 */

/** Thrown when a step is stopped part way, by Previous or by leaving the page. It isn't a failure. */
export class RailStopped extends Error {
  constructor() {
    super('The step was stopped');
    this.name = 'RailStopped';
  }
}

export const isStopped = (error: unknown): boolean => error instanceof RailStopped;

export function throwIfStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RailStopped();
}

/** Waits `ms`, or less if the step is stopped. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfStopped(signal);
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(new RailStopped());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', stop, { once: true });
  });
}

export interface WaitOptions {
  /** What is being waited for, in plain words, for the message if it never comes. */
  what: string;
  /** How long to wait, in milliseconds. */
  timeout?: number;
  signal?: AbortSignal;
  /** How often to look, in milliseconds. */
  every?: number;
}

/** Looks until `probe` returns something, and returns it. */
export async function waitFor<T>(probe: () => T | null | undefined | false, { what, timeout = 20_000, signal, every = 80 }: WaitOptions): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    throwIfStopped(signal);
    const found = probe();
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`Waited ${Math.round(timeout / 1000)} s for ${what}`);
    await sleep(every, signal);
  }
}

/** Whether an element is drawn and at least partly inside the window. */
export function onScreen(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

export interface FindOptions {
  within?: ParentNode;
  /** Only an element that is drawn and on screen (the default). */
  visible?: boolean;
  /** Only an element whose text includes this. */
  text?: string | RegExp;
}

function passes(element: Element, { visible = true, text }: FindOptions): boolean {
  if (visible && !onScreen(element)) return false;
  if (text === undefined) return true;
  const content = element.textContent ?? '';
  return typeof text === 'string' ? content.includes(text) : text.test(content);
}

/** The first element matching `selector` that passes the options. */
export function find<E extends Element = HTMLElement>(selector: string, options: FindOptions = {}): E | null {
  for (const element of (options.within ?? document).querySelectorAll<E>(selector)) {
    if (passes(element, options)) return element;
  }
  return null;
}

/** The last element matching `selector` that passes the options: the newest card in a thread, say. */
export function findLast<E extends Element = HTMLElement>(selector: string, options: FindOptions = {}): E | null {
  const all = [...(options.within ?? document).querySelectorAll<E>(selector)];
  for (let index = all.length - 1; index >= 0; index -= 1) {
    if (passes(all[index]!, options)) return all[index]!;
  }
  return null;
}
