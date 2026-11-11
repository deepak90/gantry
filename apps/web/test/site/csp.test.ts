// @vitest-environment node
/**
 * The site's Content-Security-Policy (vercel.json) is enforced, and stays strict: no inline script and no eval, so
 * markup that slips into a page can't run. The pages keep working under it: none has an inline script or handler,
 * and the app tells zod not to try `Function` before any of its modules load.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderPage, SITE_PAGES } from '../../site-pages';

const web = fileURLToPath(new URL('../..', import.meta.url));
const vercel = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../vercel.json', import.meta.url)), 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};

const everyPage = vercel.headers.find((rule) => rule.source === '/(.*)')!.headers;
const policy = everyPage.find((header) => header.key === 'Content-Security-Policy')?.value ?? '';
const directive = (name: string): string[] =>
  policy
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([key]) => key === name)
    ?.slice(1) ?? [];

describe('the Content-Security-Policy', () => {
  it('is enforced on every page, not only reported', () => {
    expect(policy).not.toBe('');
    expect(everyPage.some((header) => header.key === 'Content-Security-Policy-Report-Only')).toBe(false);
  });

  it('runs no inline script and no eval; WebAssembly only (the physics and the 3D models’ decoder)', () => {
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
    expect(directive('script-src')).not.toContain("'unsafe-eval'");
    expect(directive('script-src')).toContain("'wasm-unsafe-eval'");
    for (const loose of ['data:', 'blob:', '*', 'https:', "'strict-dynamic'"]) expect(directive('script-src')).not.toContain(loose);
    expect(policy).not.toMatch(/(^|[\s;])'unsafe-eval'/);
  });

  it('keeps the page out of frames and plugins, its base fixed, and every request on https', () => {
    expect(directive('frame-ancestors')).toEqual(["'none'"]);
    expect(directive('object-src')).toEqual(["'none'"]);
    expect(directive('base-uri')).toEqual(["'self'"]);
    expect(directive('form-action')).toEqual(["'self'"]);
    expect(policy.split(';').map((part) => part.trim())).toContain('upgrade-insecure-requests');
  });
});

describe('the pages under it', () => {
  const pages: [string, string][] = [
    ['index.html (the app)', readFileSync(`${web}/index.html`, 'utf8')],
    ...Object.values(SITE_PAGES).map((page): [string, string] => [page.file, renderPage(readFileSync(`${web}/${page.file}`, 'utf8'), page)]),
  ];

  it.each(pages)('%s has no inline script or event handler for the policy to refuse', (_, html) => {
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].filter(([, attributes]) => !/type="application\/ld\+json"/.test(attributes ?? ''));
    expect(inline).toEqual([]);
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it('the app sets zod to jitless in a plain script, before its modules', () => {
    const html = readFileSync(`${web}/index.html`, 'utf8');
    const jitless = html.indexOf('<script src="/zod-jitless.js"></script>');
    expect(jitless).toBeGreaterThan(-1);
    expect(jitless).toBeLessThan(html.indexOf('<script type="module"'));
    const script = readFileSync(`${web}/public/zod-jitless.js`, 'utf8');
    const scope: { __zod_globalConfig?: { jitless?: boolean; other?: number } } = { __zod_globalConfig: { other: 1 } };
    new Function('globalThis', script)(scope);
    expect(scope.__zod_globalConfig).toEqual({ other: 1, jitless: true });
  });
});
