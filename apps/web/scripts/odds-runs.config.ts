// The config for scripts/odds-runs.ts alone: pnpm --filter @collab/web exec vitest run -c scripts/odds-runs.config.ts
import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../vite.config';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['scripts/odds-runs.ts'],
      // The plan's today, as the hosted site has it (src/plan-clock.ts): the odds are asked on Tue, Nov 10, 2026.
      env: { VITE_PLAN_DATE: '2026-11-10' },
      testTimeout: 600_000,
      // It prints what it wrote: the on-time counts and dates.
      silent: false,
    },
  }),
);
