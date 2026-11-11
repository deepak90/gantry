/**
 * The public site's settings: the landing page, Privacy, Terms, Credits and the 404 page (site-pages.ts writes
 * them into the pages at build time, and into robots.txt, sitemap.xml and the structured data).
 *
 * `vite build` and `pnpm deploy:site` name any setting still left as a placeholder (`placeholders()` below).
 */
import { JOIN_WITH_CODE, START_SESSION } from '../copy/words.ts';

/** The main button on every page ({{START_SESSION}}), in the app's own words, so the site and the welcome screen match. */
export const START_SESSION_LABEL = START_SESSION;

/** The way in for someone with a teammate's 6-digit code ({{JOIN_WITH_CODE}}). */
export const JOIN_WITH_CODE_LABEL = JOIN_WITH_CODE;

/** Where the site lives, with no trailing slash: canonical links, Open Graph, the sitemap. */
export const SITE_URL = 'https://gantry-pearl.vercel.app';

/** The film on YouTube: the 11 characters after `v=` in its link. */
export const FILM_YOUTUBE_ID = 'dtjWu35chMo';

/** The day the film went up on YouTube (the film's structured data needs it). */
export const FILM_UPLOAD_DATE = '2026-11-11';

/** Gantry's entry on Devpost: the page every Devpost link on the site opens. */
export const DEVPOST_URL = 'https://devpost.com/software/gantry-talk-build-pay';

/** The film's length (ISO 8601): 2 min 59 s. */
export const FILM_DURATION = 'PT2M59S';

/** Settings still holding a placeholder, by name. */
export function placeholders(): string[] {
  const left: string[] = [];
  if (new URL(SITE_URL).hostname.endsWith('example.com')) left.push('SITE_URL');
  if (!/^[\w-]{11}$/.test(FILM_YOUTUBE_ID)) left.push('FILM_YOUTUBE_ID');
  return left;
}
