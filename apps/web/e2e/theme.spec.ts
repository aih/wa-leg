import { test, expect } from '@playwright/test';

const root = 'html';

test('the app opens in light mode even when the OS prefers dark', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator(root)).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Dark mode' })).toHaveAttribute('aria-pressed', 'false');
});

test('the reader can switch to dark mode and the choice survives a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Dark mode' }).click();
  await expect(page.locator(root)).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Dark mode' })).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await expect(page.locator(root)).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Dark mode' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Dark mode' }).click();
  await expect(page.locator(root)).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator(root)).toHaveAttribute('data-theme', 'light');
});
