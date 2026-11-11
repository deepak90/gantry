// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderPage, SITE_PAGES } from '../../site-pages';
import { JOIN_WITH_CODE_LABEL, SITE_URL, START_SESSION_LABEL } from '../../src/site/site-config';

const web = fileURLToPath(new URL('../..', import.meta.url));
const rendered = (page: (typeof SITE_PAGES)[keyof typeof SITE_PAGES]) => renderPage(readFileSync(join(web, page.file), 'utf8'), page);

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('the public site pages', () => {
  it.each(Object.values(SITE_PAGES))('$file renders whole, with its own title and heading, and never loads the app', (page) => {
    const html = rendered(page);
    expect(html).not.toMatch(/\{\{|@include|@structured-data/);
    expect(/<title>([^<]+)<\/title>/.exec(html)?.[1]).toContain('Gantry');
    expect(/<meta name="description" content="([^"]+)"/.exec(html)?.[1]?.length).toBeGreaterThan(20);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain('<main id="main"');
    expect(html).toContain('/src/site/site.ts');
    expect(html).not.toContain('/src/main.tsx');
  });

  it('gives the listed pages a canonical address and share cards, and keeps the 404 page out of search', () => {
    for (const page of Object.values(SITE_PAGES)) {
      const html = rendered(page);
      if (page.path) {
        expect(html).toContain(`<link rel="canonical" href="${SITE_URL}${page.path}" />`);
        expect(html).toContain(`<meta property="og:image" content="${SITE_URL}/og.png" />`);
        expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
      } else {
        expect(html).toContain('<meta name="robots" content="noindex" />');
        expect(html).not.toContain('rel="canonical"');
      }
    }
  });

  it('describes Gantry and its film for search engines on the landing page', () => {
    const html = rendered(SITE_PAGES.landing);
    const data = JSON.parse(/<script type="application\/ld\+json">(.+?)<\/script>/.exec(html)![1]!) as { '@graph': { '@type': string }[] };
    expect(data['@graph'].map((node) => node['@type'])).toEqual(['SoftwareApplication', 'VideoObject']);
  });

  it('names the way in the way the app does, on every page that has it', () => {
    for (const page of Object.values(SITE_PAGES)) {
      const html = rendered(page);
      expect(html).not.toMatch(/>\s*Get your own copy\s*<|data-track="Get your own copy"/);
      for (const link of html.match(/<a [^>]*href="\/app"[^>]*>[^<]*<\/a>/g) ?? []) {
        expect(link).toContain(`>${START_SESSION_LABEL}</a>`);
        expect(link).toContain(`data-track="${START_SESSION_LABEL}"`);
      }
    }
    expect(rendered(SITE_PAGES.landing)).toContain(JOIN_WITH_CODE_LABEL);
  });

  it('sends a typed code to the app, even without scripts', () => {
    const html = rendered(SITE_PAGES.landing);
    const forms = html.match(/<form [^>]*data-join-code[^>]*>/g) ?? [];
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) expect(form).toMatch(/action="\/app" method="get"/);
    expect(html.match(/<input [^>]*name="code"[^>]*>/g)?.every((input) => input.includes('inputmode="numeric"'))).toBe(true);
  });

  it('links to the film’s moments, and plays nothing by itself', () => {
    const html = rendered(SITE_PAGES.landing);
    const moments = html.match(/https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}&amp;t=\d+s/g) ?? [];
    expect(moments.length).toBeGreaterThanOrEqual(5);
    expect(html).not.toMatch(/\bautoplay\b/);
  });

  it('keeps the film’s own note beside the film', () => {
    const html = rendered(SITE_PAGES.landing);
    expect(html).toMatch(/Remy’s replies are live\. Deepak and Chris are scripted, all three voices are AI, and pauses are shortened\s+and parts sped up\./);
  });

  it('credits every 3D model the app ships', () => {
    const credits = rendered(SITE_PAGES.credits);
    const models = filesUnder(join(web, 'public/models')).filter((path) => path.endsWith('.glb'));
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) expect(credits).toContain(`<code>${model.split('/').pop()}</code>`);
  });
});
