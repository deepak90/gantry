/**
 * Puts the Riverside Clinic demo project, the one every spec works in, back to its seed state: what
 * `pnpm demo:reset:force` does, for that project only, so the other demo projects (and anyone working
 * in them while the suite runs) are left alone. Forced because a spec's payout can still be
 * processing at PayPal when the next run starts (nothing asks PayPal again once the spec ends), and a
 * payment still processing holds the payment lock that stops a plain reset. Uses the service role key
 * from the repo-root .env.local.
 */
import { execFileSync } from 'node:child_process';
import { SEED_IDS } from '../../packages/shared/src/seed/index.ts';

export function resetDemoProject(project: string = SEED_IDS.project): void {
  // The script files the seed documents (the crane supplier's quote) afterwards.
  execFileSync(process.execPath, ['--env-file-if-exists=.env.local', 'scripts/demo-reset.ts', '--force', '--project', project], { stdio: 'inherit' });
}
