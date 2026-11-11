/**
 * Writes supabase/seed_snapshot.sql from the seed projects in packages/shared/src/seed and the starter
 * library in packages/shared/src/library-starter.ts.
 *
 *   pnpm seed:snapshot                                   # (re)write the file
 *   node scripts/gen-seed-snapshot.ts --check            # exit 1 when it is stale
 *
 * Runs on Node's built-in type stripping, hence the explicit .ts import specifiers.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SEED_PROJECTS } from '../packages/shared/src/seed/index.ts';
import { renderSeedSnapshotsSql } from '../packages/shared/src/seed/snapshot-sql.ts';
import { starterLibrarySeed } from '../packages/shared/src/library-starter.ts';

const target = fileURLToPath(new URL('../supabase/seed_snapshot.sql', import.meta.url));
const sql = renderSeedSnapshotsSql(SEED_PROJECTS.map(({ project, ids }) => ({ project, ids, library: project.library === 'none' ? [] : starterLibrarySeed() })));

if (process.argv.includes('--check')) {
  let current: string | null;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = null;
  }
  if (current !== sql) {
    console.error(`${target} is stale; run: pnpm seed:snapshot`);
    process.exit(1);
  }
  console.log(`${target} is up to date`);
} else {
  writeFileSync(target, sql);
  console.log(`wrote ${target} (${sql.length} bytes)`);
}
