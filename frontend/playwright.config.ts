import { defineConfig } from '@playwright/test';

/**
 * E2E stack:
 *   postgres (docker, :55432) → alembic upgrade head → scripts/e2e_seed.py
 *   backend  :8901 (uvicorn, spawned by e2e/start-backend.mjs)
 *   frontend :3000 (vite dev, VITE_API_URL pinned at the E2E API)
 *
 * Locally: `npm run e2e` after starting the fixture database
 * (see docs/engineering-audit/MODERNIZATION_ROADMAP.md Phase 4).
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // shared fixture DB — serial only
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node e2e/start-backend.mjs',
      url: 'http://localhost:8901/ready',
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:3000/login',
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        VITE_API_URL: 'http://localhost:8901/api/v1',
        DISABLE_HMR: 'true',
      },
    },
  ],
});
