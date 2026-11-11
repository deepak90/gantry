/**
 * Writes this package's own pnpm-lock.yaml, which the Docker build on LiveKit Cloud installs from: `lk agent deploy`
 * builds from this folder alone, and the worker imports nothing from the rest of the workspace. It is the workspace's
 * lockfile cut down to this package's dependencies, at the same versions. Run it after changing them:
 * `pnpm --filter @collab/remy-call lockfile`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const IMPORTER = 'apps/remy-call';
const workspaceLock = fileURLToPath(new URL('../../../pnpm-lock.yaml', import.meta.url));
const ownLock = fileURLToPath(new URL('../pnpm-lock.yaml', import.meta.url));

/** The lockfile's top-level sections, by name, as their lines. */
function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    const top = /^([a-zA-Z]+):/.exec(line);
    if (top) out.set(top[1]!, (current = [line]));
    else current?.push(line);
  }
  return out;
}

/** A section's entries (each starts at two spaces in), keyed as written: `name@version(peers)`. */
function entries(lines: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines.slice(1)) {
    const head = /^ {2}('?)(\S.*?)\1:( \{\})?$/.exec(line);
    if (head) out.set(head[2]!, (current = [line]));
    else if (current && line.trim()) current.push(line);
  }
  return out;
}

/** The dependencies an entry's lines list (`dependencies:` and `optionalDependencies:`), as name and version. */
function dependencies(lines: string[]): [string, string][] {
  const out: [string, string][] = [];
  let listing = false;
  for (const line of lines.slice(1)) {
    const block = /^ {4}(\w+):/.exec(line);
    if (block) {
      listing = block[1] === 'dependencies' || block[1] === 'optionalDependencies' || block[1] === 'devDependencies';
      continue;
    }
    if (!listing) continue;
    const pair = /^ {6}('?)(\S.*?)\1: ('?)(.+?)\3$/.exec(line);
    if (pair) out.push([pair[2]!, pair[4]!]);
  }
  return out;
}

/** An importer's dependency, read from its `specifier`/`version` pair. */
function importerDependencies(lines: string[]): [string, string][] {
  const out: [string, string][] = [];
  let name: string | null = null;
  for (const line of lines) {
    const head = /^ {6}('?)(\S.*?)\1:$/.exec(line);
    if (head) name = head[2]!;
    const version = /^ {8}version: ('?)(.+?)\1$/.exec(line);
    if (version && name) out.push([name, version[2]!]);
  }
  return out;
}

/** The snapshot a dependency resolves to: `name@version`, or the version itself when it names another package. */
function snapshotKey(name: string, version: string): string | null {
  if (version.startsWith('link:') || version.startsWith('file:')) return null;
  return /^\d/.test(version) ? `${name}@${version}` : version;
}

const lock = sections(readFileSync(workspaceLock, 'utf8'));
const importers = lock.get('importers') ?? [];
const start = importers.findIndex((line) => line === `  ${IMPORTER}:`);
if (start < 0) throw new Error(`${IMPORTER} is not in the workspace lockfile`);
const end = importers.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
const importer = importers.slice(start + 1, end < 0 ? undefined : end);

const packages = entries(lock.get('packages') ?? []);
const snapshots = entries(lock.get('snapshots') ?? []);
const needed = new Set<string>();
const queue = importerDependencies(importer).flatMap(([name, version]) => snapshotKey(name, version) ?? []);
while (queue.length) {
  const key = queue.pop()!;
  if (needed.has(key)) continue;
  const snapshot = snapshots.get(key);
  if (!snapshot) throw new Error(`no snapshot for ${key}`);
  needed.add(key);
  for (const [name, version] of dependencies(snapshot)) {
    const next = snapshotKey(name, version);
    if (next) queue.push(next);
  }
}
const packageOf = (key: string) => key.replace(/\(.*$/, '');
const keptPackages = [...packages].filter(([key]) => [...needed].some((snapshot) => packageOf(snapshot) === key));
const keptSnapshots = [...snapshots].filter(([key]) => needed.has(key));

const block = (list: [string, string[]][]) => list.map(([, lines]) => lines.join('\n')).join('\n\n');
const text = [
  ...(lock.get('lockfileVersion') ?? []),
  ...(lock.get('settings') ?? []),
  'importers:',
  '',
  '  .:',
  ...importer.filter((line) => line.trim()),
  '',
  'packages:',
  '',
  block(keptPackages),
  '',
  'snapshots:',
  '',
  block(keptSnapshots),
  '',
].join('\n');
writeFileSync(ownLock, text);
console.log(`apps/remy-call/pnpm-lock.yaml: ${keptPackages.length} packages from the workspace lockfile`);
