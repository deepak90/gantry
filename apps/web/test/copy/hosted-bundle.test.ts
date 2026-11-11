// @vitest-environment node
/**
 * What a hosted build (`VITE_GANTRY_HOSTED=1`) leaves out: the demo accounts' passwords (the sign-in screen is not
 * part of it) and the walkthrough scripts (not either). A real production build, as
 * the site's is made, then a search of every file it wrote.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const web = fileURLToPath(new URL('../..', import.meta.url));
const viteBin = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });
}

describe('the hosted build', () => {
  let out = '';
  let text = '';

  beforeAll(() => {
    // Inside the package, where a build may always write, and away from its own dist.
    const cache = join(web, 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    out = mkdtempSync(join(cache, 'hosted-bundle-'));
    const built = spawnSync(process.execPath, [viteBin, 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
      cwd: web,
      env: { ...process.env, NODE_ENV: 'production', VITE_GANTRY_HOSTED: '1' },
      encoding: 'utf8',
    });
    if (built.status !== 0) throw new Error(`The hosted build failed:\n${built.stderr || built.stdout}`);
    text = filesIn(out)
      .filter((path) => /\.(js|mjs|css|html|json|map)$/.test(path))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
  }, 300_000);

  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  it('is the hosted build: the copy’s way in and the site’s call routes are in it', () => {
    expect(text).toContain('claim_copy');
    expect(text).toContain('/api/call/token');
  });

  it('has no demo passwords and no sign-in screen', () => {
    expect(text).not.toMatch(/demo-(pm|cm)-2026/);
    expect(text).not.toMatch(/(pm|cm)@demo\.local/);
    expect(text).not.toContain('Sign in with your project account');
  });

  it('has none of the walkthrough scripts', () => {
    expect(text).not.toContain('I was out last week. What changed?');
  });
});
