import { defineConfig, devices } from '@playwright/test';

/**
 * Instructional clips of the real app (tests/clips, `pnpm clips [--grep link]`): each spec signs in,
 * sets up its scene in a write-free sandbox, records the gesture and writes apps/web/public/clips/
 * <id>.webm, <id>.png and clips.json. Needs the local stack and the dev server (docs/SETUP.md).
 */
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: 'tests/clips',
  testMatch: '**/*.clip.ts',
  outputDir: 'test-results/clips',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: BASE_URL,
        viewport: { width: 1600, height: 1000 },
        deviceScaleFactor: 2,
        // The clips show motion; the app's own reduced-motion rules would still apply on the viewer's side.
        reducedMotion: 'no-preference',
        // No welcome card, tour or story guide over what the clip shows (as in playwright.config.ts).
        storageState: {
          cookies: [],
          origins: [{ origin: BASE_URL, localStorage: [{ name: 'collab.first-run.skip', value: '1' }] }],
        },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @collab/web dev',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
