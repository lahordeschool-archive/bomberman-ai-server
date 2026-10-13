import { defineConfig, devices } from '@playwright/test';

const SERVER_PORT = 8180;
const RUNNER_PORT = 8190;
const TOKEN = 'e2e-runner-token-0123456789';
const ORIGIN = `http://localhost:${SERVER_PORT}`;

/**
 * Runs the real stack: the QuickJS bot-runner and the game server serving the built
 * client (`npm run build` first) on an in-memory database. Matches are paced faster
 * and shorter than production so a ranked game finishes in seconds.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node apps/bot-runner/src/index.ts',
      url: `http://127.0.0.1:${RUNNER_PORT}/healthz`,
      reuseExistingServer: false,
      env: { PORT: String(RUNNER_PORT), HOST: '127.0.0.1', RUNNER_TOKEN: TOKEN, LOG_LEVEL: 'warn' },
    },
    {
      command: 'node apps/server/src/index.ts',
      url: `http://127.0.0.1:${SERVER_PORT}/readyz`,
      reuseExistingServer: false,
      env: {
        PORT: String(SERVER_PORT),
        HOST: '127.0.0.1',
        DATABASE_URL: 'pglite:memory',
        PUBLIC_ORIGIN: ORIGIN,
        RUNNER_URL: `http://127.0.0.1:${RUNNER_PORT}`,
        RUNNER_TOKEN: TOKEN,
        MATCH_TICK_MS: '5',
        RANKED_MAX_TICKS: '400',
        MATCHMAKER_INTERVAL_MS: '500',
        REGISTRATIONS_PER_HOUR: '1000',
        LOG_LEVEL: 'warn',
      },
    },
  ],
});
