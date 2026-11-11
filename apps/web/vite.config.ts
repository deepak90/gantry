import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { callRoutes } from './call-dev';
import { paypalRoutes } from './paypal-dev';
import { siteInputs, sitePages } from './site-pages.ts';

export default defineConfig({
  // paypalRoutes: progress payments as one PayPal payout batch (dev only; the REST app's secret stays here).
  // callRoutes: tokens for the call with Remy, and who is on it (dev only; the LiveKit secret stays here).
  // sitePages: the public site's pages around the app, and the hosted build's layout (site-pages.ts).
  plugins: [react(), paypalRoutes(), callRoutes(), sitePages()],
  // .env files live at the repo root (.env.local is the single local secrets file).
  envDir: '../..',
  server: { port: 5173, strictPort: true },
  // Pre-bundle Bryntum once so the dev server never loads two copies of the engine.
  optimizeDeps: { include: ['@bryntum/gantt', '@bryntum/gantt-react'] },
  // The app; the crowd page `pnpm crowd` opens (simulated people for the busy-workplace demo; left out of the
  // hosted build); and the public site's pages: landing, privacy, terms, credits and 404 (site-pages.ts).
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        crowd: fileURLToPath(new URL('./crowd.html', import.meta.url)),
        ...siteInputs(),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});
