/**
 * The public site around the app: the landing page and the plain pages (Privacy, Terms, Credits, 404). Each is a
 * Vite entry of its own with one small script and one stylesheet (src/site/), so none of them loads the app's
 * bundle.
 *
 * In the pages:
 *   <!-- @include name -->   src/site/partials/name.html (the head, the header, the footer)
 *   <!-- @structured-data -->  the JSON-LD for Gantry and its film
 *   {{NAME}}                 a setting from src/site/site-config.ts, or the page's own URL, title or description
 *   {{FILM_AT_97}}           the film on YouTube, starting at that second (a clip's caption links to its moment)
 *
 * The hosted build (VITE_GANTRY_HOSTED=1) lays the output out the way vercel.json serves it: the landing page
 * becomes index.html, the app moves to app/index.html (/app and everything under it), and the crowd page, a local
 * tool, is left out. Local dev and local builds keep the app at / and the landing page at /landing.html.
 * robots.txt and sitemap.xml are written with every build; `vite preview` serves a hosted build like Vercel does.
 * Vercel's build hands the analytics scripts' paths over in VERCEL_OBSERVABILITY_CLIENT_CONFIG, which is passed
 * through to src/analytics.ts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import {
  DEVPOST_URL,
  FILM_DURATION,
  FILM_UPLOAD_DATE,
  FILM_YOUTUBE_ID,
  JOIN_WITH_CODE_LABEL,
  placeholders,
  SITE_URL,
  START_SESSION_LABEL,
} from './src/site/site-config.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const partials = join(root, 'src/site/partials');

/** The site's pages: their file, and where they're served (null: not listed in the sitemap, not indexed). */
export const SITE_PAGES = {
  landing: { file: 'landing.html', path: '/' },
  privacy: { file: 'privacy.html', path: '/privacy' },
  terms: { file: 'terms.html', path: '/terms' },
  credits: { file: 'credits.html', path: '/credits' },
  '404': { file: '404.html', path: null },
} as const satisfies Record<string, { file: string; path: string | null }>;

type Page = (typeof SITE_PAGES)[keyof typeof SITE_PAGES];

/** The pages as build inputs. */
export function siteInputs(): Record<string, string> {
  return Object.fromEntries(Object.entries(SITE_PAGES).map(([name, page]) => [name, join(root, page.file)]));
}

const pageAt = (urlPath: string): Page | undefined => Object.values(SITE_PAGES).find((page) => `/${page.file}` === urlPath);

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeHtml = (text: string) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const filmEmbedUrl = `https://www.youtube-nocookie.com/embed/${FILM_YOUTUBE_ID}`;
const filmWatchUrl = `https://www.youtube.com/watch?v=${FILM_YOUTUBE_ID}`;

/** The film on YouTube from a given second, so a clip on the page can be checked against the whole take. */
export function filmAt(seconds: number): string {
  return `${filmWatchUrl}&t=${Math.max(0, Math.floor(seconds))}s`;
}

/** Gantry as a web application, and its film, for search engines. */
function structuredData(description: string): string {
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_URL}/#gantry`,
        name: 'Gantry',
        url: `${SITE_URL}/`,
        description,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web browser',
        image: `${SITE_URL}/og.png`,
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        subjectOf: { '@id': `${SITE_URL}/#film` },
      },
      {
        '@type': 'VideoObject',
        '@id': `${SITE_URL}/#film`,
        name: 'Gantry: the film',
        description:
          'A general contractor’s team on a call with Remy, an AI assistant, in Gantry: an idle crane, light fixtures for three floors, an invoice to the tenant, the odds of handing over on time, and two firms paid in one PayPal order, on the sandbox.',
        thumbnailUrl: [`${SITE_URL}/og.png`],
        uploadDate: FILM_UPLOAD_DATE,
        duration: FILM_DURATION,
        embedUrl: filmEmbedUrl,
        url: filmWatchUrl,
        inLanguage: 'en-US',
      },
    ],
  };
  // `<` escaped so nothing in the data can close the script element.
  return `<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, '\\u003c')}</script>`;
}

/** A site page's HTML with its partials, structured data and settings filled in. */
export function renderPage(html: string, page: Page): string {
  let out = html.replace(/<!-- @include ([\w-]+) -->/g, (_, name: string) => readFileSync(join(partials, `${name}.html`), 'utf8').trim());
  const title = unescapeHtml(/<title>([^<]*)<\/title>/.exec(out)?.[1] ?? 'Gantry');
  const description = unescapeHtml(/<meta name="description" content="([^"]*)"/.exec(out)?.[1] ?? '');
  out = out.replace('<!-- @structured-data -->', () => structuredData(description));
  const values: Record<string, string> = {
    SITE_URL,
    PAGE_URL: page.path ? `${SITE_URL}${page.path}` : SITE_URL,
    PAGE_TITLE: title,
    PAGE_DESCRIPTION: description,
    ROUTE: page.path ?? '/404',
    OG_IMAGE_URL: `${SITE_URL}/og.png`,
    FILM_EMBED_URL: filmEmbedUrl,
    FILM_WATCH_URL: filmWatchUrl,
    DEVPOST_URL,
    START_SESSION: START_SESSION_LABEL,
    JOIN_WITH_CODE: JOIN_WITH_CODE_LABEL,
  };
  return out.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const moment = /^FILM_AT_(\d+)$/.exec(name);
    const value = moment ? filmAt(Number(moment[1])) : values[name];
    if (value === undefined) throw new Error(`site-pages: ${page.file} names an unknown setting {{${name}}}`);
    return escapeHtml(value);
  });
}

function robotsTxt(): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;
}

function sitemapXml(): string {
  const day = new Date().toISOString().slice(0, 10);
  const urls = Object.values(SITE_PAGES)
    .flatMap((page) => (page.path ? [`  <url>\n    <loc>${escapeHtml(SITE_URL + page.path)}</loc>\n    <lastmod>${day}</lastmod>\n  </url>`] : []))
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function sitePages(): Plugin {
  let hosted = false;
  let outDir = '';
  return {
    name: 'gantry-site-pages',
    config() {
      return { define: { 'import.meta.env.VERCEL_OBSERVABILITY_CLIENT_CONFIG': JSON.stringify(process.env.VERCEL_OBSERVABILITY_CLIENT_CONFIG ?? '') } };
    },
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      if (config.command !== 'build') return;
      hosted = config.env.VITE_GANTRY_HOSTED === '1';
      const left = placeholders();
      if (left.length > 0) config.logger.warn(`Site settings still holding a placeholder (src/site/site-config.ts): ${left.join(', ')}`);
    },
    options(options) {
      const { input } = options;
      if (!hosted || !input || typeof input !== 'object' || Array.isArray(input) || !('crowd' in input)) return null;
      const { crowd: _localTool, ...rest } = input;
      return { ...options, input: rest };
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const page = pageAt(ctx.path);
        return page ? renderPage(html, page) : html;
      },
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robotsTxt() });
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemapXml() });
    },
    writeBundle() {
      if (!hosted) return;
      mkdirSync(join(outDir, 'app'), { recursive: true });
      renameSync(join(outDir, 'index.html'), join(outDir, 'app/index.html'));
      renameSync(join(outDir, SITE_PAGES.landing.file), join(outDir, 'index.html'));
    },
    configurePreviewServer(server) {
      // What vercel.json does: the app answers /app and everything under it; the pages answer without .html.
      server.middlewares.use((req, _res, next) => {
        const url = new URL(req.url ?? '/', 'http://preview');
        const app = existsSync(join(outDir, 'app/index.html'));
        if (app && (url.pathname === '/app' || (url.pathname.startsWith('/app/') && !/\.\w+$/.test(url.pathname)))) {
          req.url = `/app/index.html${url.search}`;
        } else {
          const page = Object.values(SITE_PAGES).find((each) => each.path === url.pathname && each.path !== '/');
          if (page) req.url = `/${page.file}${url.search}`;
        }
        next();
      });
    },
  };
}
