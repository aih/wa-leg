import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs } from './helpers';

/**
 * The path from draft to Committee (docs/SIMPLIFY-0.2.md section 4): Rae creates a note for Dana, Dana submits, Rae
 * requests changes, Dana resolves the threads and resubmits with a reply, Rae approves, Rae publishes. Along the way:
 * exactly one button labelled Cancel is on screen while a workflow dialog is open, and none of them is in the
 * workflow bar.
 */

let noteUrl: string;

const state = (page: Page) => page.locator('.workflow-bar .status').first();
const bar = (page: Page) => page.locator('.workflow-bar');
const cancelButtons = (page: Page) => page.getByRole('button', { name: 'Cancel' });

async function axeClean(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('.bill-viewer').analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function waitSaved(page: Page) {
  await expect(page.locator('.save-state')).toHaveText(/Saved at/, { timeout: 15_000 });
}

/** Select a whole paragraph of the note that contains `text` and open the New comment form on it. */
async function commentOn(page: Page, text: string, body: string) {
  const body$ = page.locator('.note-editor-body');
  await body$.locator('p', { hasText: text }).first().click({ clickCount: 3 });
  await page.getByRole('button', { name: 'Comment on the selection' }).click();
  const form = page.getByRole('form', { name: 'New comment' });
  await expect(cancelButtons(page)).toHaveCount(1);
  await form.getByRole('textbox', { name: 'Comment' }).fill(body);
  await form.getByRole('button', { name: 'Add comment' }).click();
  await expect(form).toHaveCount(0);
}

test.describe.serial('workflow', () => {
  test('Rae creates a note on SHB 2402 for Dana; both see it as Draft', async ({ page }) => {
    await loginAs(page, 'dev-reviewer', '/bills/2025-26/HB2402/S');
    await page.getByText('New fiscal note').click();
    const form = page.getByRole('form', { name: 'New note' });
    await form.getByRole('combobox', { name: 'Template' }).selectOption('sales-use-tax-exemption');
    await form.getByRole('combobox', { name: 'Drafter' }).selectOption('dev-drafter');
    await form.getByRole('button', { name: 'Create and open' }).click();
    await page.waitForURL(/\/notes\/[0-9a-f-]{36}$/);
    noteUrl = new URL(page.url()).pathname;
    await expect(bar(page).locator('h1')).toContainText('SHB 2402');
    await expect(state(page)).toHaveText('Draft');
    await expect(bar(page)).toContainText('Drafter: Dana Drafter');
    await expect(bar(page)).toContainText('Reviewer: not yet');
    // Rae is not the drafter: read-only, no workflow action.
    await expect(page.locator('.save-state')).toHaveText('Read-only');
    await expect(page.getByRole('group', { name: 'Workflow actions' }).getByRole('button', { name: /Submit|Approve|Publish|Request/ })).toHaveCount(0);
    await expect(cancelButtons(page)).toHaveCount(0);
    await axeClean(page);
  });

  test('Dana edits and submits for review with a message', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    await expect(state(page)).toHaveText('Draft');
    await expect(page.locator('.save-state')).toHaveText('All changes saved');
    // The toolbar has no Formula or Template tool.
    const toolbar = page.getByRole('toolbar', { name: 'Editing' });
    await expect(toolbar.getByRole('button', { name: /Formula|Template/ })).toHaveCount(0);
    await expect(toolbar.getByRole('button', { name: 'Cite the bill section shown in the viewer' })).toBeVisible();
    await page.locator('.note-editor-body p.block-slot-empty').first().click();
    await page.keyboard.type('First draft text');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Second draft text');
    await expect(page.locator('.note-editor-body p', { hasText: 'Second draft text' })).toHaveCount(1);
    await waitSaved(page);
    await page.getByRole('button', { name: 'Submit for review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Submit for review' });
    await expect(dialog.getByLabel(/Message \(optional\)/)).toBeVisible();
    await expect(cancelButtons(page)).toHaveCount(1);
    await expect(bar(page).getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await dialog.getByLabel(/Message/).fill('First draft ready');
    await dialog.getByRole('button', { name: 'Submit for review' }).click();
    await expect(state(page)).toHaveText('In review');
    await expect(page.locator('.save-state')).toHaveText('Read-only');
    await expect(cancelButtons(page)).toHaveCount(0);
  });

  test('Rae comments on two sentences and requests changes', async ({ page }) => {
    await loginAs(page, 'dev-reviewer', noteUrl);
    await expect(state(page)).toHaveText('In review');
    await expect(bar(page)).toContainText('Reviewer: not yet');
    await expect(page.locator('.save-state')).toHaveText('Read-only');
    await commentOn(page, 'First draft text', 'Say which fiscal years this covers.');
    await page.getByRole('tab', { name: 'Note' }).click();
    await commentOn(page, 'Second draft text', 'Name the section of the bill.');
    await expect(page.getByRole('tab', { name: /Comments \(2\)/ })).toBeVisible();
    await page.getByRole('button', { name: 'Request changes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Request changes' });
    await expect(cancelButtons(page)).toHaveCount(1);
    await expect(bar(page).getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await expect(bar(page).getByRole('button', { name: 'Approve' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Request changes' }).click();
    await expect(dialog.getByRole('alert')).toContainText('message is required');
    await dialog.getByLabel(/Message \(required\)/).fill('Please fill Part II and answer the two comments.');
    await dialog.getByRole('button', { name: 'Request changes' }).click();
    await expect(state(page)).toHaveText('Changes requested');
    await expect(bar(page)).toContainText('Reviewer: Rae Reviewer');
    await expect(cancelButtons(page)).toHaveCount(0);
    await axeClean(page);
  });

  test('Dana sees the request, resolves the threads, edits and resubmits with a reply', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    await expect(state(page)).toHaveText('Changes requested');
    await expect(page.locator('.save-state')).toHaveText('All changes saved');
    const banner = page.locator('.workflow-bar .banner.changes');
    await expect(banner).toContainText('Rae Reviewer requested changes');
    await expect(banner).toContainText('Please fill Part II and answer the two comments.');
    await banner.getByRole('button', { name: '2 open comment threads' }).click();
    await expect(page.getByRole('tab', { name: /Comments/ })).toHaveAttribute('aria-selected', 'true');
    const threads = page.locator('.threads .thread');
    await expect(threads).toHaveCount(2);
    await threads.first().getByRole('button', { name: 'Resolve' }).click();
    await expect(threads).toHaveCount(1);
    await threads.first().getByRole('button', { name: 'Resolve' }).click();
    await expect(threads).toHaveCount(0);
    await expect(banner).toContainText('0 open comment threads');
    await page.getByRole('tab', { name: 'Note' }).click();
    await page.locator('.note-editor-body p', { hasText: 'First draft text' }).first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' for FY 2026 and FY 2027');
    await waitSaved(page);
    await page.getByRole('button', { name: 'Submit for review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Submit for review' });
    await expect(cancelButtons(page)).toHaveCount(1);
    await dialog.getByLabel(/Reply to the change request/).fill('Both comments answered; Part II filled.');
    await dialog.getByRole('button', { name: 'Submit for review' }).click();
    await expect(state(page)).toHaveText('In review');
    await expect(banner).toHaveCount(0);
    // History shows the request and the reply.
    await page.getByRole('button', { name: 'History' }).click();
    const log = page.locator('.transitions li');
    await expect(log).toHaveCount(3);
    await expect(log.nth(0)).toContainText('Submit for review');
    await expect(log.nth(0)).toContainText('Both comments answered; Part II filled.');
    await expect(log.nth(1)).toContainText('Request changes');
    await expect(log.nth(1)).toContainText('Please fill Part II and answer the two comments.');
    await expect(log.nth(1)).toContainText('Rae Reviewer');
    await expect(log.nth(2)).toContainText('First draft ready');
  });

  test('Rae approves, exports, then publishes', async ({ page }) => {
    await loginAs(page, 'dev-reviewer', noteUrl);
    await expect(state(page)).toHaveText('In review');
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(state(page)).toHaveText('Approved');
    await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();
    // The export menu offers the four formats and each responds.
    await page.locator('.export-menu summary').click();
    const menu = page.getByRole('group', { name: 'Export formats' });
    await expect(menu.getByRole('link')).toHaveText(['PDF', 'DOCX', 'HTML', 'XML']);
    for (const format of ['pdf', 'docx', 'html', 'xml']) {
      const href = await menu.getByRole('link', { name: format.toUpperCase() }).getAttribute('href');
      expect(href).toContain(`format=${format}`);
      const res = await page.request.get(href!);
      expect(res.status(), format).toBe(200);
    }
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(state(page)).toHaveText('Published');
    await expect(page.getByRole('group', { name: 'Workflow actions' }).getByRole('button', { name: /Submit|Approve|Publish|Request/ })).toHaveCount(0);
    await expect(cancelButtons(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'History' }).click();
    const log = page.locator('.transitions li');
    await expect(log).toHaveCount(5);
    await expect(log.first()).toContainText('Publish');
    await expect(log.last()).toContainText('Submit for review');
    await axeClean(page);
  });

  test('Cam opens the published note read-only', async ({ page }) => {
    await loginAs(page, 'dev-committee', noteUrl);
    await expect(state(page)).toHaveText('Published');
    await expect(page.locator('.save-state')).toHaveText('Read-only');
    await expect(page.getByRole('group', { name: 'Workflow actions' }).getByRole('button', { name: /Submit|Approve|Publish|Request/ })).toHaveCount(0);
    await expect(page.getByRole('toolbar', { name: 'Editing' })).toHaveCount(0);
  });
});
