import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs } from './helpers';

/**
 * Editor: Dana drafts a note on SHB 2402 from the sales-use-tax-exemption template; slots highlight and Tab moves
 * between them; the estimate table auto-sums and formats currency; a citation from the viewer links to #sec-2, a
 * second Cite on the same section shows "Already cited", the citation's remove control deletes it and the document
 * saves without it; autosave uses If-Match and shows the saved-elsewhere banner on a 412; comments anchor to ranges
 * and survive edits.
 */

let noteUrl: string;
let revisionId: string;

const CITE_LABEL = 'Section 2 of SHB 2402';

async function waitSaved(page: Page) {
  await expect(page.locator('.save-state')).toHaveText(/Saved at/, { timeout: 15_000 });
}

/** Navigate the viewer to section 2 and press Cite in the section bar. */
async function citeSection2(page: Page) {
  const toggle = page.getByRole('button', { name: 'Toggle outline' });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await page.getByRole('navigation', { name: 'Bill outline' }).getByRole('link', { name: /Sec\. 2/ }).click();
  await expect(page.locator('#sec-2')).toBeFocused();
  await page.getByRole('navigation', { name: 'Section' }).getByRole('button', { name: 'Cite', exact: true }).click();
}

test.describe.serial('notes and editor', () => {
  test('Dana creates a draft note on SHB 2402 from the sales-use-tax-exemption template', async ({ page }) => {
    await loginAs(page, 'dev-drafter', '/');
    const res = await page.request.post('/api/v1/notes', { data: { billKey: 'WA:2025-26:HB2402', versionCode: 'S', templateId: 'sales-use-tax-exemption' } });
    expect(res.status()).toBe(201);
    const created = (await res.json()) as { noteRevisionId: string; state: string };
    expect(created.state).toBe('draft');
    revisionId = created.noteRevisionId;
    noteUrl = `/notes/${revisionId}`;
    await page.goto(noteUrl);
    await expect(page.locator('.workflow-bar h1')).toContainText('SHB 2402');
    await expect(page.locator('.save-state')).toHaveText('All changes saved');
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

  test('a citation inserted from the bill viewer links to #sec-2 and carries a remove control', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    const body = page.locator('.note-editor-body');
    // Put the caret into a block slot so the citation lands in prose.
    const target = body.locator('p[data-slot="narrative.proposal"]').first();
    await target.click();
    await page.keyboard.type('See ');
    await citeSection2(page);
    const cite = body.locator('a.bill-cite');
    await expect(cite).toHaveCount(1);
    await expect(cite).toHaveAttribute('href', /#sec-2$/);
    await expect(cite).toHaveAttribute('data-section', 'sec-2');
    await expect(cite).toHaveAttribute('data-cite-key', 'WA:2025-26:HB2402|S|sec-2||');
    await expect(body.getByRole('button', { name: `Remove citation ${CITE_LABEL}` })).toBeVisible();
    await waitSaved(page);
  });

  test('citing the same section twice keeps one citation and says Already cited', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    const body = page.locator('.note-editor-body');
    await expect(body.locator('a.bill-cite')).toHaveCount(1);
    await body.locator('p[data-slot="narrative.proposal"]').first().click();
    await page.keyboard.press('End');
    await citeSection2(page);
    await expect(body.locator('a.bill-cite')).toHaveCount(1);
    await expect(body.getByRole('button', { name: `Remove citation ${CITE_LABEL}` })).toHaveCount(1);
    // The existing citation is selected and the notice names it.
    await expect(body.locator('a.bill-cite.ProseMirror-selectednode')).toHaveCount(1);
    await expect(page.locator('.notice')).toContainText(`Already cited: ${CITE_LABEL}`);
    await expect(page.locator('.bill-viewer p[role="status"]')).toHaveText(`Already cited ${CITE_LABEL}.`);
    await expect(page.locator('.save-state')).toHaveText(/All changes saved|Saved at/);
  });

  test('a read-only view renders the citation without a remove control', async ({ page }) => {
    await loginAs(page, 'dev-reviewer', noteUrl);
    const body = page.locator('.note-editor-body');
    await expect(body).toBeVisible();
    await expect(page.locator('.save-state')).toHaveText('Read-only');
    await expect(body.locator('a.bill-cite')).toHaveCount(1);
    await expect(body.locator('.cite-remove')).toHaveCount(0);
  });

  test('the remove control deletes the citation and the document saves without it', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    const body = page.locator('.note-editor-body');
    await expect(body.locator('a.bill-cite')).toHaveCount(1);
    await body.getByRole('button', { name: `Remove citation ${CITE_LABEL}` }).click();
    await expect(body.locator('a.bill-cite')).toHaveCount(0);
    await expect(body.locator('.cite-remove')).toHaveCount(0);
    await expect(body.locator('p[data-slot="narrative.proposal"]').first()).toContainText('See');
    await waitSaved(page);
    await page.reload();
    await expect(page.locator('.note-editor-body')).toBeVisible();
    await expect(page.locator('.note-editor-body a.bill-cite')).toHaveCount(0);
    const saved = await (await page.request.get(`/api/v1/notes/${revisionId}/document`)).json();
    expect(JSON.stringify(saved.doc)).not.toContain('billCitation');
    // Citing the section again after removal inserts it again.
    await page.locator('.note-editor-body p[data-slot="narrative.proposal"]').first().click();
    await page.keyboard.press('End');
    await citeSection2(page);
    await expect(page.locator('.note-editor-body a.bill-cite')).toHaveCount(1);
    await waitSaved(page);
  });

  test('autosave uses If-Match and shows the saved-elsewhere banner on a 412', async ({ page }) => {
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
    await expect(banner).toContainText('saved elsewhere', { timeout: 15_000 });
    expect(requests.some((r) => r.ifMatch === `"${doc.version}"` && r.status === 412)).toBe(true);
    await banner.getByRole('button', { name: 'Reload' }).click();
    await expect(banner).toBeHidden();
    await expect(page.locator('.note-editor-body')).toBeVisible();
  });

  test('comments anchor to ranges and survive edits', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    const body = page.locator('.note-editor-body');
    await expect(body).toBeVisible();
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
    await page.getByRole('tab', { name: 'Note', exact: true }).click();
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

  test('the workspace is axe clean with a citation in the document', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    await expect(page.locator('.note-editor-body')).toBeVisible();
    await expect(page.locator('.note-editor-body .cite-remove')).toHaveCount(1);
    const ws = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('.bill-viewer').analyze();
    expect(ws.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});
