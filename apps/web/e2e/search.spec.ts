import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs } from './helpers';

test.describe('search', () => {
  test('typing "shb 2402" in the search box redirects to the substitute', async ({ page }) => {
    await loginAs(page, 'dev-drafter', '/');
    const box = page.getByRole('combobox', { name: /Search bills/ });
    await box.fill('shb 2402');
    await box.press('Enter');
    await expect(page).toHaveURL(/\/bills\/2025-26\/HB2402\/S$/);
    await expect(page.getByRole('combobox', { name: 'Version' })).toHaveValue('S');
  });

  test('"phthalates" returns section hits with highlights and facets', async ({ page }) => {
    await loginAs(page, 'dev-drafter', '/search?q=phthalates');
    await expect(page.getByRole('heading', { name: /\d+ results?\b/ })).toBeVisible();
    const hits = page.locator('.hits > li');
    await expect(hits.first()).toBeVisible();
    await expect(page.locator('.hits mark').first()).toBeVisible();
    await expect(hits.filter({ hasText: /HB 2402|SHB 2402/ }).first()).toBeVisible();
    // Facets
    const filters = page.getByRole('complementary', { name: 'Filters' });
    await expect(filters.getByText('Document type')).toBeVisible();
    await filters.getByRole('button', { name: /Bill section/ }).click();
    await expect(page).toHaveURL(/doc_type=section/);
    await expect(page.locator('.hits > li.hit-section').first()).toBeVisible();
  });

  test('a reference with words keeps the direct card and filters results to the bill', async ({ page }) => {
    await loginAs(page, 'dev-viewer', '/search?q=HB%202402%20intravenous');
    await expect(page.locator('.direct-card').getByRole('link', { name: /SHB 2402/ }).first()).toBeVisible();
    await expect(page.locator('.hits > li').first()).toBeVisible();
  });

  test('suggestions appear while typing', async ({ page }) => {
    await loginAs(page, 'dev-drafter', '/');
    const box = page.getByRole('combobox', { name: /Search bills/ });
    await box.fill('sports');
    const list = page.getByRole('listbox', { name: 'Suggestions' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('option').filter({ hasText: /6137/ }).first()).toBeVisible();
    await box.press('ArrowDown');
    await box.press('Enter');
    await expect(page).toHaveURL(/\/bills\/2025-26\/SB6137/);
  });

  test('axe: search results light and dark', async ({ page }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await loginAs(page, 'dev-drafter', '/search?q=phthalates');
      await expect(page.locator('.hits > li').first()).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      expect(results.violations, JSON.stringify(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), null, 1)).toEqual([]);
    }
  });
});
