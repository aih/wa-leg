import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Log in through the dev OIDC issuer as one of the test users (login_hint skips the picker). */
export async function loginAs(page: Page, sub: string, returnTo = '/'): Promise<void> {
  await page.goto(`/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}&login_hint=${encodeURIComponent(sub)}`);
  await page.waitForURL((u) => !u.pathname.startsWith('/api/'));
}

/** Fail on any WCAG 2.2 AA violation on the current page; the bill viewer is checked in its own spec. */
export async function axeClean(page: Page): Promise<void> {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('.bill-viewer').analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}
