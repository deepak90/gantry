/**
 * The hosted site: the real app on the web, where every visitor gets a private copy of the Harbor Street Offices
 * project for their visit (copy/). It is on only when the build has `VITE_GANTRY_HOSTED=1`. Vite writes the value
 * into the bundle, so a hosted build leaves out what belongs to this machine alone (the demo sign-in, the film's
 * walkthroughs), and local development works as it always has.
 */

/** Whether this is the hosted build. A constant in the bundle, so whatever it switches off is left out. */
export const HOSTED: boolean = import.meta.env.VITE_GANTRY_HOSTED === '1';

/** What the hosted page knows about its services: public values only, never a secret. */
export interface HostedConfig {
  /** Cloudflare Turnstile's site key, for the human check before an anonymous sign-in; null when not set. */
  turnstileSiteKey: string | null;
  /** The LiveKit server the call connects to, when the token route doesn't name one. */
  livekitUrl: string | null;
}

type Env = Readonly<Record<string, string | boolean | undefined>>;

const text = (value: string | boolean | undefined): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** The public configuration, from `import.meta.env` or a test's stand-in. */
export function readHostedConfig(env: Env = import.meta.env): HostedConfig {
  return { turnstileSiteKey: text(env.VITE_TURNSTILE_SITE_KEY), livekitUrl: text(env.VITE_LIVEKIT_URL) };
}

/** The film, on the landing page: where a visitor goes while every copy is in use. */
export const FILM_URL = '/#film';
