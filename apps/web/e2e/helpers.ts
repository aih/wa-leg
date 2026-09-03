import type { Page } from '@playwright/test';

/** Log in through the dev OIDC issuer as one of the test users (login_hint skips the picker). */
export async function loginAs(page: Page, sub: string, returnTo = '/'): Promise<void> {
  await page.goto(`/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}&login_hint=${encodeURIComponent(sub)}`);
  await page.waitForURL((u) => !u.pathname.startsWith('/api/'));
}
