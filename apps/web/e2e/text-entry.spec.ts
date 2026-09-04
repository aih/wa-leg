import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './helpers';

/**
 * Every field the app takes text in: characters land in the order they are typed, and Backspace removes them.
 * Fields are driven one key at a time (`pressSequentially`, `keyboard.type`) because a field that remounts on
 * each keystroke puts the caret back at the start and reverses the text; `fill()` sets the value in one shot
 * and never sees it. The note editor's system-filled header fields take no text at all.
 */

let noteUrl = '';

async function waitSaved(page: Page) {
  await expect(page.locator('.save-state')).toHaveText(/Saved at|All changes saved/, { timeout: 15_000 });
}

test.describe.serial('text entry and deletion', () => {
  test('the global search box types forwards and deletes', async ({ page }) => {
    await loginAs(page, 'dev-drafter', '/');
    const box = page.getByRole('combobox', { name: 'Search bills, notes, and RCW' });
    await box.click();
    await box.pressSequentially('phthalates', { delay: 20 });
    await expect(box).toHaveValue('phthalates');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
    await expect(box).toHaveValue('phth');
  });

  test('Find in bill types forwards and deletes', async ({ page }) => {
    await loginAs(page, 'dev-drafter', '/bills/2025-26/HB2402/S');
    const toggle = page.getByRole('button', { name: 'Toggle outline' });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
    const find = page.getByRole('searchbox', { name: 'Find in bill' });
    await find.click();
    await find.pressSequentially('exemption', { delay: 20 });
    await expect(find).toHaveValue('exemption');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await expect(find).toHaveValue('exempti');
  });

  test('a note opens for editing', async ({ page }) => {
    await loginAs(page, 'dev-drafter', '/');
    const res = await page.request.post('/api/v1/notes', { data: { billKey: 'WA:2025-26:HB2402', versionCode: 'S', templateId: 'sales-use-tax-exemption' } });
    expect(res.status()).toBe(201);
    noteUrl = `/notes/${((await res.json()) as { noteRevisionId: string }).noteRevisionId}`;
    await page.goto(noteUrl);
    await expect(page.locator('.note-editor-body')).toContainText('Department of Revenue');
  });

  test('a block slot takes text, Backspace, and a selection delete', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    const body = page.locator('.note-editor-body');
    const slot = body.locator('p.block-slot-empty').first();
    const slotId = await slot.getAttribute('data-slot');
    const target = body.locator(`p[data-slot="${slotId}"]`);
    await slot.click();
    await page.keyboard.type('Repeals the exemption in section 2.');
    await expect(target).toHaveText('Repeals the exemption in section 2.');
    for (let i = 0; i < ' in section 2.'.length; i++) await page.keyboard.press('Backspace');
    await expect(target).toHaveText('Repeals the exemption');
    // Select the whole slot and delete it: the paragraph goes back to its empty state.
    await target.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await expect(target).toHaveText('');
    await expect(target).toHaveClass(/block-slot-empty/);
    await page.keyboard.type('Repeals the exemption in section 2.');
    await waitSaved(page);
  });

  test('a table input cell takes text and deletes it; the computed cell takes none', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    const body = page.locator('.note-editor-body');
    const fy1 = body.locator('td[data-slot="receipts.gf.fy1"]');
    await fy1.click();
    await page.keyboard.type('-4310000');
    await expect(fy1).toHaveText('-4310000');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await expect(fy1).toHaveText('-43100');
    await page.keyboard.press('Tab');
    await expect(fy1).toHaveText('(43,100)');
    // A computed cell is not editable: its text stays whatever the formula produced.
    const computed = body.locator('td.computed').first();
    const before = await computed.textContent();
    await computed.click();
    await page.keyboard.type('999');
    await page.keyboard.press('Backspace');
    await expect(computed).toHaveText(before ?? '');
    await waitSaved(page);
  });

  test('the system-filled header fields take neither text nor Backspace', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    const body = page.locator('.note-editor-body');
    for (const id of ['bill.number', 'bill.title', 'agency.display']) {
      const field = body.locator(`[data-slot="${id}"]`);
      const before = await field.textContent();
      expect(before?.trim()).toBeTruthy();
      await field.click();
      await page.keyboard.type('ZZZ');
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Delete');
      await expect(field).toHaveText(before ?? '');
      await expect(field).toHaveAttribute('contenteditable', 'false');
    }
  });

  test('the New comment and Reply boxes type forwards and delete', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    const body = page.locator('.note-editor-body');
    await expect(body).toBeVisible();
    await body.locator('p[data-slot]', { hasText: 'Repeals the exemption' }).first().click({ clickCount: 3 });
    await page.getByRole('button', { name: 'Comment on the selection' }).click();

    const form = page.getByRole('form', { name: 'New comment' });
    const comment = form.getByRole('textbox', { name: 'Comment' });
    await comment.click();
    await comment.pressSequentially('Name the section.', { delay: 20 });
    await expect(comment).toHaveValue('Name the section.');
    await page.keyboard.press('Backspace');
    await expect(comment).toHaveValue('Name the section');
    await form.getByRole('button', { name: 'Add comment' }).click();

    const thread = page.locator('.threads .thread').first();
    await expect(thread).toContainText('Name the section');
    await thread.getByRole('button', { name: 'Reply' }).click();
    const reply = thread.getByRole('textbox', { name: 'Reply' });
    await reply.click();
    await reply.pressSequentially('Section 2, added.', { delay: 20 });
    await expect(reply).toHaveValue('Section 2, added.');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await expect(reply).toHaveValue('Section 2, adde');
    await reply.pressSequentially('d.', { delay: 20 });
    await thread.getByRole('button', { name: 'Post reply' }).click();
    await expect(thread.locator('.messages li')).toHaveCount(2);
    await expect(thread.locator('.messages li').nth(1)).toContainText('Section 2, added.');
  });

  test('the workflow dialog message types forwards and deletes', async ({ page }) => {
    await loginAs(page, 'dev-drafter', noteUrl);
    await expect(page.locator('.note-editor-body')).toBeVisible();
    await page.getByRole('group', { name: 'Workflow actions' }).getByRole('button', { name: /Submit/ }).click();
    const message = page.getByRole('dialog').getByRole('textbox');
    await message.click();
    await message.pressSequentially('Ready for review.', { delay: 20 });
    await expect(message).toHaveValue('Ready for review.');
    await page.keyboard.press('Backspace');
    await expect(message).toHaveValue('Ready for review');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
