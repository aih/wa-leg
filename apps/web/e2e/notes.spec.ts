import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs } from './helpers';

/**
 * Milestone 5 acceptance: create a note on SHB 2402 from the sales-use-tax-exemption template; slots highlight and Tab
 * moves between them; the estimate table auto-sums and formats currency; a citation from the viewer links to #sec-2;
 * a formula renders with KaTeX; autosave uses If-Match and shows the conflict banner on a 412; the version list shows
 * a redline; comments anchor to ranges and survive edits.
 */

let noteUrl: string;
let revisionId: string;

async function waitSaved(page: Page) {
  await expect(page.locator('.save-state')).toHaveText(/Saved at/, { timeout: 15_000 });
}

test.describe.serial('notes and editor', () => {
  test('a reviewer creates a note on SHB 2402 from the sales-use-tax-exemption template', async ({ page }) => {
    await loginAs(page, 'dev-reviewer', '/bills/2025-26/HB2402/S');
    await page.getByRole('heading', { name: /HB 2402/ }).first().waitFor();
    await page.getByText('New fiscal note').click();
    const form = page.getByRole('form', { name: 'New note' });
    await form.getByRole('combobox', { name: 'Template' }).selectOption('sales-use-tax-exemption');
    await form.getByRole('combobox', { name: 'Drafter' }).selectOption('dev-drafter');
    await form.getByRole('textbox', { name: 'Request id' }).fill('2402-1-1');
    await form.getByRole('textbox', { name: 'Legislative contact' }).fill('Jane Legislative');
    await form.getByRole('textbox', { name: 'Phone' }).fill('360-786-7100');
    await form.getByRole('button', { name: 'Create and open' }).click();
    await page.waitForURL(/\/notes\/[0-9a-f-]{36}$/);
    noteUrl = new URL(page.url()).pathname;
    revisionId = noteUrl.split('/').pop()!;
    await expect(page.locator('.workflow-bar h1')).toContainText('SHB 2402');
    // The reviewer is not the drafter: read-only.
    await expect(page.locator('.save-state')).toHaveText('Read-only');
    await expect(page.locator('.note-editor-body')).toContainText('Department of Revenue');
  });

  test('slots are highlighted until filled and Tab moves between them', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    const body = page.locator('.note-editor-body');
    await expect(body).toBeVisible();
    await expect(page.locator('.save-state')).toHaveText('All changes saved');
    const empties = body.locator('.slot-empty');
    const before = await empties.count();
    expect(before).toBeGreaterThan(3);
    await expect(page.locator('.slot-count')).toHaveText(/\d+ of \d+ required slots filled/);
    // Fill the first empty block slot, Tab to the next slot and type there.
    const blocks = body.locator('p.block-slot-empty');
    const first = blocks.first();
    const firstId = await first.getAttribute('data-slot');
    await first.click();
    await page.keyboard.type('First slot text');
    await expect(body.locator(`p[data-slot="${firstId}"]`)).not.toHaveClass(/slot-empty/);
    await page.keyboard.press('Tab');
    await page.keyboard.type('Second slot text');
    const second = body.locator('[data-slot]', { hasText: 'Second slot text' }).first();
    await expect(second).toBeVisible();
    expect(await second.getAttribute('data-slot')).not.toBe(firstId);
    await expect(body.locator('.slot-empty')).toHaveCount(before - 2);
    await waitSaved(page);
  });

  test('the estimate table auto-sums and formats currency', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    const body = page.locator('.note-editor-body');
    const fy1 = body.locator('td[data-slot="receipts.gf.fy1"]');
    await fy1.click();
    await page.keyboard.type('-4310000');
    await page.keyboard.press('Tab');
    await expect(fy1).toHaveText('(4,310,000)');
    await page.keyboard.type('-10800000');
    await page.keyboard.press('Tab');
    await expect(body.locator('td[data-slot="receipts.gf.fy2"]')).toHaveText('(10,800,000)');
    await expect(body.locator('td[data-computed="sum(receipts.gf.fy1,receipts.gf.fy2)"]')).toHaveText('(15,110,000)');
    // The total row follows.
    await expect(body.locator('table[data-role="cash-receipts"] tr[data-row="total"] td.computed').first()).toContainText('(4,310,000)');
    await waitSaved(page);
    // Reload: the server recomputed and stored the same figures.
    await page.reload();
    await expect(page.locator('.note-editor-body td[data-computed="sum(receipts.gf.fy1,receipts.gf.fy2)"]')).toHaveText('(15,110,000)');
  });

  test('a citation inserted from the bill viewer links to #sec-2', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    const body = page.locator('.note-editor-body');
    // Put the caret into a block slot so the citation lands in prose.
    const target = body.locator('p[data-slot="narrative.proposal"]').first();
    await target.click();
    await page.keyboard.type('See ');
    // Navigate the viewer to section 2 and press Cite in the section bar.
    const toggle = page.getByRole('button', { name: 'Toggle outline' });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
    await page.getByRole('navigation', { name: 'Bill outline' }).getByRole('link', { name: /Sec\. 2/ }).click();
    await expect(page.locator('#sec-2')).toBeFocused();
    await page.getByRole('navigation', { name: 'Section' }).getByRole('button', { name: 'Cite', exact: true }).click();
    const cite = body.locator('a.bill-cite');
    await expect(cite).toHaveCount(1);
    await expect(cite).toHaveAttribute('href', /#sec-2$/);
    await expect(cite).toHaveAttribute('data-section', 'sec-2');
    await waitSaved(page);
  });

  test('a formula is entered and rendered with KaTeX', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    const body = page.locator('.note-editor-body');
    await body.locator('p[data-slot="narrative.proposal"]').first().click();
    await page.keyboard.press('End');
    await page.getByRole('button', { name: 'Insert formula' }).click();
    const dialog = page.getByRole('dialog', { name: 'Formula' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('checkbox', { name: 'Edit as LaTeX' }).check();
    await dialog.getByRole('textbox', { name: 'LaTeX source' }).fill('\\frac{a}{b}');
    await dialog.getByRole('button', { name: 'Insert' }).click();
    await expect(dialog).toBeHidden();
    await expect(body.locator('.katex .mfrac')).toHaveCount(1);
    await expect(body.locator('[data-type="inline-math"]')).toHaveAttribute('data-latex', '\\frac{a}{b}');
    await waitSaved(page);
  });

  test('autosave uses If-Match and shows the conflict banner on a 412', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    const body = page.locator('.note-editor-body');
    await expect(body).toBeVisible();
    // Another client saves first: bump the server version through the API with the drafter's cookies.
    const head = await page.request.get(`/api/v1/notes/${revisionId}/document`);
    const doc = await head.json();
    const put = await page.request.put(`/api/v1/notes/${revisionId}/document`, { headers: { 'if-match': `"${doc.version}"` }, data: { doc: doc.doc, mode: doc.mode, clientId: 'other-client' } });
    expect(put.status()).toBe(200);
    // Now the page's next autosave carries the stale version.
    const requests: { ifMatch: string | undefined; status: number }[] = [];
    page.on('response', (res) => {
      if (res.request().method() === 'PUT' && res.url().includes('/document')) requests.push({ ifMatch: res.request().headers()['if-match'], status: res.status() });
    });
    await body.locator('p[data-slot="narrative.currentLaw"]').first().click();
    await page.keyboard.type('Edited after another save. ');
    const banner = page.getByRole('alert');
    await expect(banner).toContainText('Saved by', { timeout: 15_000 });
    expect(requests.some((r) => r.ifMatch === `"${doc.version}"` && r.status === 412)).toBe(true);
    await banner.getByRole('button', { name: 'Keep mine' }).click();
    await waitSaved(page);
    await expect(banner).toBeHidden();
    const after = await (await page.request.get(`/api/v1/notes/${revisionId}/document`)).json();
    expect(after.version).toBe(doc.version + 2);
  });

  test('the version list shows a redline between two saves', async ({ page }) => {
    await loginAs(page, 'dev-drafter', `${noteUrl}/versions`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('versions');
    const rows = page.locator('.version-list tbody tr');
    expect(await rows.count()).toBeGreaterThan(2);
    await rows.nth(1).getByRole('button', { name: 'Compare with current' }).click();
    const detail = page.locator('.version-detail');
    await expect(detail.getByRole('heading', { level: 2 })).toContainText('Changes from version');
    await expect(detail.locator('.redline')).toBeVisible();
    // A cell diff or a text insertion appears.
    await expect(detail.locator('.redline ins, .cell-diff tbody tr').first()).toBeVisible();
    await expect(page.locator('.version-list tbody tr').first()).toContainText('(head)');
    // Named snapshot.
    await page.getByLabel('Label').fill('Before review');
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.version-list tbody tr').first()).toContainText('Before review');
  });

  test('comments anchor to ranges and survive edits', async ({ page }) => {
    await loginAs(page, 'dev-reviewer', noteUrl);
    const body = page.locator('.note-editor-body');
    await expect(body).toBeVisible();
    // The reviewer is read-only here, so the drafter makes the comment in this build.
    await loginAs(page, 'dev-drafter', noteUrl);
    const word = body.locator('p[data-slot]', { hasText: 'Second slot text' }).first();
    await word.click({ clickCount: 3 });
    await page.getByRole('button', { name: 'Comment on the selection' }).click();
    const form = page.getByRole('form', { name: 'New comment' });
    await form.getByRole('textbox', { name: 'Comment' }).fill('Check this wording');
    await form.getByRole('button', { name: 'Add comment' }).click();
    await expect(page.locator('.threads .thread')).toHaveCount(1);
    await expect(page.locator('.threads .thread').first()).not.toContainText('detached');
    await waitSaved(page);
    // Edit before the mark; the thread stays attached after reload.
    await page.getByRole('tab', { name: /Editor/ }).click();
    await expect(body.locator('mark.comment')).toHaveCount(1);
    await body.locator('p[data-slot]', { hasText: 'First slot text' }).first().click();
    await page.keyboard.press('Home');
    await page.keyboard.type('Prefix ');
    await waitSaved(page);
    await page.reload();
    await expect(page.locator('.note-editor-body mark.comment')).toHaveCount(1);
    await page.getByRole('tab', { name: /Comments/ }).click();
    const thread = page.locator('.threads .thread').first();
    await expect(thread).toContainText('Check this wording');
    await expect(thread).not.toContainText('detached');
    // Reply and resolve.
    await thread.getByRole('button', { name: 'Reply' }).click();
    await thread.getByRole('textbox', { name: 'Reply' }).fill('Reworded');
    await thread.getByRole('button', { name: 'Post reply' }).click();
    await expect(thread.locator('.messages li')).toHaveCount(2);
    await thread.getByRole('button', { name: 'Resolve' }).click();
    await expect(page.locator('.threads .thread')).toHaveCount(0);
    await page.locator('.comments-panel').getByRole('combobox', { name: /Show/ }).selectOption('resolved');
    await expect(page.locator('.threads .thread').first()).toContainText('resolved');
  });

  test('workspace and versions pages are axe clean', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    await expect(page.locator('.note-editor-body')).toBeVisible();
    const ws = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('.bill-viewer').analyze();
    expect(ws.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    await page.goto(`${noteUrl}/versions`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('versions');
    const vs = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    expect(vs.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});
