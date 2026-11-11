import { defineConfig } from '@playwright/test';

/**
 * Two-browser collaboration checks against the local Supabase stack (docs/SETUP.md). The web app
 * reads the repo-root .env.local; the spec reads the demo credentials from E2E_PM_EMAIL /
 * E2E_PM_PASSWORD / E2E_CM_EMAIL / E2E_CM_PASSWORD, defaulting to the seeded accounts.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    viewport: { width: 1600, height: 1000 },
    // The checks work on the Riverside Clinic fixture unless a link says otherwise (it is not in the project menu),
    // with no steps or coach in the way.
    storageState: {
      cookies: [],
      origins: [{ origin: process.env.E2E_BASE_URL ?? 'http://localhost:5173', localStorage: [{ name: 'collab.last-project', value: '00000000-0000-4000-8000-000000000001' }, { name: 'collab.first-run.skip', value: '1' }] }],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // E2E_BASE_URL points the checks at a server you started (say a `vite preview` of a build); otherwise
  // the dev server on :5173 is used, started if it is not running.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm --filter @collab/web dev',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
