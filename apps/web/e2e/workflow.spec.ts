import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs } from './helpers';

/**
 * Milestone 6 acceptance: the drafter submits, the reviewer claims, requests changes, the drafter resubmits, the
 * reviewer approves; dashboards show the right rows in the role vocabulary; the transition log is complete; the
 * inbox carries the notifications.
 */

let noteUrl: string;
let revisionId: string;

const state = (page: Page) => page.locator('.workflow-bar .status').first();

async function axeClean(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('.bill-viewer').analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.describe.serial('workflow', () => {
  test('a reviewer creates a note on SHB 2402 and the drafter sees it as To do', async ({ page }) => {
    await loginAs(page, 'dev-reviewer', '/bills/2025-26/HB2402/S');
    await page.getByText('New fiscal note').click();
    const form = page.getByRole('form', { name: 'New note' });
    await form.getByRole('combobox', { name: 'Template' }).selectOption('no-fiscal-impact');
    await form.getByRole('combobox', { name: 'Drafter' }).selectOption('dev-drafter');
    await form.getByRole('textbox', { name: 'Request id' }).fill('wf-e2e');
    await form.getByRole('button', { name: 'Create and open' }).click();
    await page.waitForURL(/\/notes\/[0-9a-f-]{36}$/);
    noteUrl = new URL(page.url()).pathname;
    revisionId = noteUrl.split('/').pop()!;
    await expect(state(page)).toHaveText('To do');
    await expect(page.locator('.workflow-bar .due')).toContainText(/Due in|Overdue/);
    // Drafter dashboard: the note is in "needing action" as To do, with the reviewer vocabulary absent.
    await loginAs(page, 'dev-drafter', '/dashboard/drafter');
    const row = page.locator(`section:has(#need-action) tr:has(a[href="/notes/${revisionId}"])`).filter({ hasText: 'To do' }).first();
    await expect(row).toBeVisible();
    await expect(row.locator('.band-label')).toHaveText(/Due later|Due within|Overdue/);
    // Inbox: the assignment notification arrived.
    await page.goto('/inbox');
    await expect(page.locator('.inbox-item', { hasText: 'assigned to you' }).first()).toBeVisible();
    await axeClean(page);
  });

  test('the drafter starts by saving, then submits for review', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    await expect(state(page)).toHaveText('To do');
    await expect(page.getByRole('button', { name: 'Start drafting' })).toBeVisible();
    await page.getByRole('button', { name: 'Start drafting' }).click();
    await expect(state(page)).toHaveText('In progress');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    const dialog = page.getByRole('form', { name: 'Submit for review' });
    await dialog.getByLabel(/Comment/).fill('First draft ready');
    await dialog.getByRole('button', { name: 'Submit for review' }).click();
    await expect(state(page)).toHaveText('Ready for review');
    await expect(page.locator('.save-state')).toHaveText('Read-only');
    // Drafter vocabulary on the dashboard.
    await page.goto('/dashboard/drafter');
    await expect(page.locator(`section:has(#waiting) tr:has(a[href="/notes/${revisionId}"])`).first()).toContainText('Ready for review');
  });

  test('the reviewer claims, requests changes; the drafter resubmits; the reviewer approves', async ({ page }) => {
    await loginAs(page, 'dev-reviewer', '/dashboard/reviewer');
    const pending = page.locator(`section:has(#pending) tr:has(a[href="/notes/${revisionId}"])`).first();
    await expect(pending).toContainText('Ready for review');
    await expect(pending).toContainText('unclaimed');
    await pending.getByRole('link', { name: 'SHB 2402' }).click();
    await page.waitForURL(new RegExp(revisionId));
    await page.getByRole('button', { name: 'Claim review' }).click();
    await expect(state(page)).toHaveText('In review');
    await page.getByRole('button', { name: 'Request changes' }).click();
    const dialog = page.getByRole('form', { name: 'Request changes' });
    await dialog.getByRole('button', { name: 'Request changes' }).click();
    await expect(page.getByRole('alert')).toContainText('comment is required');
    await dialog.getByLabel(/Comment/).fill('Please fill Part II\n- Add the effective date sentence\n- Fill the cash receipts table');
    await dialog.getByRole('button', { name: 'Request changes' }).click();
    await expect(state(page)).toHaveText('Changes requested');
    // Reviewer dashboard shows it under changes requested, in the same words the drafter will see.
    await page.goto('/dashboard/reviewer');
    await expect(page.locator(`section:has(#changes) tr:has(a[href="/notes/${revisionId}"])`).first()).toContainText('Changes requested');
    // Drafter sees the same status, the comment in the inbox, and the itemised request in the workspace.
    await loginAs(page, 'dev-drafter', '/inbox');
    await expect(page.locator('.inbox-item', { hasText: 'Please fill Part II' }).first()).toBeVisible();
    await page.goto('/dashboard/drafter');
    await expect(page.locator(`section:has(#need-action) tr:has(a[href="/notes/${revisionId}"])`).first()).toContainText('Changes requested');
    await page.goto(noteUrl);
    await expect(state(page)).toHaveText('Changes requested');
    await expect(page.locator('.save-state')).toHaveText('All changes saved');
    const banner = page.locator('.banner.changes');
    await expect(banner).toContainText('Rae Reviewer requested changes');
    await expect(banner).toContainText('2 of 2 still open');
    // Submitting is blocked while items are open; the bar points at the Changes tab.
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByRole('alert')).toContainText('2 change request items are still open');
    await expect(page.getByRole('tab', { name: /Changes/ })).toHaveAttribute('aria-selected', 'true');
    const request = page.locator('.change-request.open');
    await expect(request.locator('.cr-summary')).toHaveText('Please fill Part II');
    await expect(request.locator('.cr-item')).toHaveCount(2);
    await expect(request.locator('.cr-item').first()).toContainText('Add the effective date sentence');
    // Address each item with a note on how; then close the request with a message to the reviewer.
    for (const [i, how] of ['Added the sentence to Part II.A', 'Filled FY 2026 and FY 2027'].entries()) {
      const item = request.locator('.cr-item').nth(i);
      await item.getByRole('button', { name: 'Mark addressed' }).click();
      await item.getByRole('textbox', { name: 'How this item was addressed' }).fill(how);
      await item.getByRole('button', { name: 'Save' }).click();
      await expect(item).toHaveClass(/addressed/);
      await expect(item).toContainText(how);
    }
    await expect(page.getByRole('tab', { name: /Changes/ })).toContainText('0 open');
    await request.getByRole('textbox', { name: /How the request was addressed/ }).fill('Both points done; see v2.');
    await request.getByRole('button', { name: 'Close request' }).click();
    await expect(page.locator('.change-request.closed')).toContainText('Closed by Dana Drafter');
    await expect(page.locator('.change-request.closed')).toContainText('Both points done; see v2.');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await page.getByRole('form', { name: 'Submit for review' }).getByRole('button', { name: 'Submit for review' }).click();
    await expect(state(page)).toHaveText('Ready for review');
    // The assigned reviewer approves.
    await loginAs(page, 'dev-reviewer', noteUrl);
    await page.getByRole('button', { name: 'Claim review' }).click();
    await expect(state(page)).toHaveText('In review');
    // The reviewer reads how each item was addressed before approving.
    await page.getByRole('tab', { name: /Changes/ }).click();
    await expect(page.locator('.change-request.closed .cr-item.addressed')).toHaveCount(2);
    await expect(page.locator('.change-request.closed')).toContainText('Addressed by Dana Drafter');
    await page.getByRole('tab', { name: /^(Editor|Note)$/ }).click();
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('form', { name: 'Approve' }).getByRole('button', { name: 'Approve' }).click();
    await expect(state(page)).toHaveText('Approved');
    await expect(page.getByRole('button', { name: 'Claim review' })).toHaveCount(0);
    // The transition log is complete.
    await page.getByRole('button', { name: 'History' }).click();
    const log = page.locator('.transitions li');
    await expect(log).toHaveCount(7);
    await expect(log.first()).toContainText('approve');
    await expect(log.last()).toContainText('start');
    await expect(page.locator('.transitions li', { hasText: 'request changes' })).toContainText('Please fill Part II');
    await axeClean(page);
  });

  test('dashboards and the inbox after approval are consistent and axe clean', async ({ page }) => {
    await loginAs(page, 'dev-drafter', '/dashboard/drafter');
    await expect(page.locator(`section:has(#approved) tr:has(a[href="/notes/${revisionId}"])`).first()).toContainText('Approved');
    await expect(page.locator(`section:has(#need-action) tr:has(a[href="/notes/${revisionId}"])`)).toHaveCount(0);
    await axeClean(page);
    await page.goto('/inbox');
    await expect(page.locator('.inbox-item', { hasText: 'approved' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Mark all read' }).click();
    await expect(page.locator('.inbox-item.unread')).toHaveCount(0);
    await loginAs(page, 'dev-reviewer', '/dashboard/reviewer');
    await expect(page.locator(`section:has(#approved-h) tr:has(a[href="/notes/${revisionId}"])`).first()).toBeVisible();
    await axeClean(page);
  });
});
