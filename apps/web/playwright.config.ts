import { defineConfig, devices } from '@playwright/test';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.PW_NO_SERVER
    ? undefined
    : [
        {
          command: 'pnpm --filter @wa-leg/dev-oidc start',
          url: 'http://localhost:4801/health',
          reuseExistingServer: true,
          timeout: 60_000,
        },
        {
          command: 'pnpm --filter @wa-leg/api start',
          url: 'http://localhost:4800/api/v1/health',
          reuseExistingServer: true,
          timeout: 120_000,
        },
        {
          command: 'pnpm --filter @wa-leg/web dev',
          url: WEB,
          reuseExistingServer: true,
          timeout: 60_000,
        },
      ],
});
