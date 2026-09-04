import { test, expect } from '@playwright/test';
import { loginAs } from './helpers';

test('anonymous visitor sees the sign-in prompt, the search box and the test users', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('combobox', { name: /search bills/i })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('link', { name: /sign in/i })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('img', { name: 'WA$ Fiscal Note Workbench' })).toBeVisible();
  for (const name of ['Dana Drafter', 'Rae Reviewer', 'Cam Committee', 'Jordan Both']) {
    await expect(page.getByRole('link', { name })).toBeVisible();
  }
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Guide' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Notes' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Published' })).toHaveCount(0);
});

test('drafter signs in through the dev issuer and lands on Notes', async ({ page }) => {
  await loginAs(page, 'dev-drafter');
  await expect(page).toHaveURL(/\/notes$/);
  await expect(page.getByRole('banner').getByText('Dana Drafter')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link', { name: 'Notes' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Published' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Guide' })).toBeVisible();
});

test('reviewer picks Rae from the picker and lands on Notes; the picker lists the four users', async ({ page }) => {
  await page.goto('/api/v1/auth/login');
  await expect(page.getByRole('heading', { name: /development sign-in/i })).toBeVisible();
  for (const name of ['Dana Drafter', 'Rae Reviewer', 'Cam Committee', 'Jordan Both']) {
    await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible();
  }
  await page.getByRole('link', { name: /Rae Reviewer/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/api/'));
  await expect(page).toHaveURL(/\/notes$/);
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
});

test('viewer lands on Published and has no Notes link', async ({ page }) => {
  await loginAs(page, 'dev-committee');
  await expect(page).toHaveURL(/\/published$/);
  await expect(page.getByRole('heading', { name: 'Published fiscal notes' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link', { name: 'Notes' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Published' })).toBeVisible();
  await loginAs(page, 'dev-committee', '/notes');
  await expect(page.getByRole('alert')).toContainText('drafter or reviewer');
});

test('Jordan Both lands on Notes; /api/v1/me returns both roles', async ({ page }) => {
  await loginAs(page, 'dev-both');
  await expect(page).toHaveURL(/\/notes$/);
  const res = await page.request.get('/api/v1/me');
  expect(res.ok()).toBeTruthy();
  const me = await res.json();
  expect(me.userId).toBe('dev-both');
  expect(me.roles.sort()).toEqual(['drafter', 'reviewer']);
});
