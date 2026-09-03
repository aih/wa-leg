import { expect, test } from '@playwright/test';
import { axeClean, loginAs } from './helpers';

/**
 * Publishing (docs/SIMPLIFY-0.2.md section 4, step 6): Rae publishes the seeded Approved note on HB 1019; Cam sees it
 * on /published with four export links and beside the bill; GET /api/v1/published lists it.
 */

test.describe('Publishing', () => {
  test.describe.configure({ mode: 'serial' });

  let revisionId: string;

  test('Rae publishes the approved note on HB 1019', async ({ page }) => {
    await loginAs(page, 'dev-reviewer', '/');
    const onBill = await (await page.request.get('/api/v1/bills/2025-26/HB1019/notes')).json();
    const approved = onBill.find((n: { state: string }) => n.state === 'approved');
    expect(approved, 'the seed leaves HB 1019 in Approved (pnpm wa-leg demo seed --reset)').toBeTruthy();
    revisionId = approved.noteRevisionId;
    await page.goto(`/notes/${revisionId}`);
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/v1/notes/${revisionId}/workflow`)).json()).state, { timeout: 10_000 }).toBe('published');
    await expect(page.getByLabel('Workflow', { exact: true })).toContainText('Published');
    const summary = await (await page.request.get(`/api/v1/notes/${revisionId}`)).json();
    expect(summary.publishedAt).toBeTruthy();
    expect(summary.publishedVersion).toBe(summary.approvedVersion);
  });

  test('Cam sees it on /published with four export links', async ({ page }) => {
    await loginAs(page, 'dev-committee', '/published');
    const row = page.getByRole('row').filter({ hasText: 'HB 1019' });
    await expect(row).toBeVisible();
    for (const format of ['PDF', 'DOCX', 'HTML', 'XML']) {
      await expect(row.getByRole('link', { name: format })).toHaveAttribute('href', new RegExp(`/api/v1/notes/${revisionId}/export\\?format=${format.toLowerCase()}$`));
    }
  });

  test('Cam sees it beside the bill', async ({ page }) => {
    await loginAs(page, 'dev-committee', '/bills/2025-26/HB1019');
    const panel = page.getByRole('region', { name: 'Fiscal note' });
    await expect(panel).toContainText('Published note for HB 1019');
    await expect(panel).toContainText('Published ');
    const links = panel.getByRole('group', { name: 'Export' });
    for (const format of ['PDF', 'DOCX', 'HTML', 'XML']) {
      await expect(links.getByRole('link', { name: format })).toHaveAttribute('href', new RegExp(`/api/v1/notes/${revisionId}/export\\?format=${format.toLowerCase()}$`));
    }
    await expect(panel.getByRole('region', { name: 'Note text' })).toBeVisible();
  });

  test('GET /api/v1/published lists it and its exports render', async ({ page }) => {
    await loginAs(page, 'dev-committee', '/');
    const feed = await page.request.get('/api/v1/published');
    expect(feed.status()).toBe(200);
    const body = await feed.json();
    const item = body.items.find((i: { revisionId: string }) => i.revisionId === revisionId);
    expect(item).toMatchObject({
      bill: { biennium: '2025-26', billId: 'HB1019', number: '1019' },
      versionCode: 'I',
      versionLabel: 'HB 1019',
      title: 'HB 1019 Fiscal Note',
      publishedBy: { userId: 'dev-reviewer', displayName: 'Rae Reviewer' },
    });
    expect(Object.keys(item.exports).sort()).toEqual(['docx', 'html', 'pdf', 'xml']);
    expect(body.items[0].revisionId).toBe(revisionId);
    const html = await page.request.get(item.exports.html);
    expect(html.status()).toBe(200);
    expect(html.headers()['content-disposition']).toBe('inline; filename="HB1019-fiscal-note.html"');
    expect(await html.text()).toContain('Published ');
    const pdf = await page.request.get(item.exports.pdf);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    const docx = await page.request.get(item.exports.docx);
    expect(docx.status()).toBe(200);
    expect((await docx.body()).subarray(0, 2).toString()).toBe('PK');
  });
});

test.describe('Published page', () => {
  test('Cam sees the published SHB 2402 note on /published with four export links', async ({ page }) => {
    await loginAs(page, 'dev-committee', '/published');
    await expect(page.getByRole('heading', { name: 'Published fiscal notes' })).toBeVisible();
    const row = page.locator('.published-table tbody tr').filter({ hasText: 'SHB 2402' }).first();
    await expect(row).toBeVisible();
    await expect(row.getByRole('link', { name: 'SHB 2402', exact: true })).toHaveAttribute('href', '/bills/2025-26/HB2402/S');
    const links = row.getByRole('group', { name: /^Export/ });
    for (const format of ['pdf', 'docx', 'html', 'xml']) {
      await expect(links.getByRole('link', { name: format.toUpperCase() })).toHaveAttribute('href', new RegExp(`format=${format}`));
    }
    const pdf = await page.request.get(await links.getByRole('link', { name: 'PDF' }).getAttribute('href') as string);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    await axeClean(page);
  });
});
