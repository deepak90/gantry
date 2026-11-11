/**
 * Plan fields that end up in markup, checked as the plan loads and as every revision applies (Bryntum runs a field's
 * `convert` for both): a color goes into style attributes (Bryntum's own `--b-primary:<color>` and ours), an image
 * address into an <img>, and a row's `href` would turn the task's name in the tree column into a link. Anyone in a
 * session can write the plan, so none of them is taken as it comes. What doesn't pass reads as not set (null); a
 * field the data leaves out stays left out (undefined), so loading a plan adds nothing to it.
 */

/** Bryntum's named event colors (its TimelineEventRendering.eventColors), which it draws as `b-color-<name>` classes. */
export const NAMED_EVENT_COLORS: ReadonlySet<string> = new Set([
  'red',
  'pink',
  'magenta',
  'purple',
  'violet',
  'deep-purple',
  'indigo',
  'blue',
  'light-blue',
  'cyan',
  'teal',
  'green',
  'light-green',
  'lime',
  'yellow',
  'amber',
  'orange',
  'deep-orange',
  'light-gray',
  'gray',
  'black',
]);

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A color as `#rgb`, `#rrggbb` or one of Bryntum's named colors; null for anything else. */
export function safeColor(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const color = value.trim();
  return HEX_COLOR.test(color) || NAMED_EVENT_COLORS.has(color) ? color : null;
}

/** A path on this site, from its root, in plain characters: `/crews/logos/granite-concrete.png`. */
const SITE_PATH = /^\/[A-Za-z0-9._~-][A-Za-z0-9._~/-]*$/;

/**
 * An image this site serves (`/crews/…`, `/assets/…`); null for anything else: another site's address (which would
 * see who looks at the plan), `//host/…`, `data:`, `javascript:` and the like.
 */
export function safeImageUrl(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const path = value.trim();
  return path.length <= 300 && SITE_PATH.test(path) && !path.includes('//') ? path : null;
}

/** A field never taken from the plan's data: whatever it says, it stays unset. */
export const ignored = (): undefined => undefined;
