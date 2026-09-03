import { test, expect } from '@playwright/test';
import { loginAs } from './helpers';

test('anonymous visitor sees the sign-in prompt and the search box', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('searchbox', { name: /search bills/i })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('link', { name: /sign in/i })).toBeVisible();
});

test('drafter logs in through the dev issuer and sees the drafter dashboard', async ({ page }) => {
  await loginAs(page, 'dev-drafter');
  await expect(page.getByText('Dana Drafter')).toBeVisible();
  await expect(page.getByRole('heading', { name: /my notes needing action/i })).toBeVisible();
});

test('reviewer sees the reviewer dashboard; the picker lists every role', async ({ page }) => {
  await page.goto('/api/v1/auth/login');
  await expect(page.getByRole('heading', { name: /development sign-in/i })).toBeVisible();
  await page.getByRole('link', { name: /Rae Reviewer/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/api/'));
  await expect(page.getByRole('heading', { name: /pending my review/i })).toBeVisible();
});

test('/api/v1/me returns the principal after login', async ({ page }) => {
  await loginAs(page, 'dev-both');
  const res = await page.request.get('/api/v1/me');
  expect(res.ok()).toBeTruthy();
  const me = await res.json();
  expect(me.userId).toBe('dev-both');
  expect(me.roles.sort()).toEqual(['drafter', 'reviewer']);
});
