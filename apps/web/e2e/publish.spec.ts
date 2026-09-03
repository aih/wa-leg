import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs } from './helpers';

/**
 * Milestone 7 acceptance: a viewer opens the bill page and sees the approved note beside the bill; DOCX, PDF and
 * HTML exports render the note; the FNS XML placeholder emits fields; the audit log lists exports.
 */

let revisionId: string;

async function axeClean(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('.bill-viewer').analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.describe.serial('publish and export', () => {
  test('a note is drafted and approved through the API', async ({ page }) => {
    await loginAs(page, 'dev-reviewer', '/');
    const created = await page.request.post('/api/v1/notes', { data: { billKey: 'WA:2025-26:HB2402', versionCode: 'S', templateId: 'sales-use-tax-exemption', drafterId: 'dev-drafter', request: { requestId: 'pub-e2e', legContact: { name: 'Pat Publisher', phone: '360-000-0000' } } } });
    expect(created.status()).toBe(201);
    revisionId = (await created.json()).noteRevisionId;
    // The drafter fills two cells (recomputed on save) and submits.
    await loginAs(page, 'dev-drafter', '/');
    const head = await (await page.request.get(`/api/v1/notes/${revisionId}/document`)).json();
    const doc = head.doc;
    const walk = (n: any, fn: (x: any) => void) => {
      fn(n);
      (n.content ?? []).forEach((c: any) => walk(c, fn));
    };
    walk(doc, (n) => {
      if (n.type === 'noteCell' && n.attrs?.slot === 'receipts.gf.fy1') n.content = [{ type: 'text', text: '-4310000' }];
      if (n.type === 'noteCell' && n.attrs?.slot === 'receipts.gf.fy2') n.content = [{ type: 'text', text: '-10800000' }];
      if (n.type === 'paragraph' && n.attrs?.slot === 'narrative.proposal') n.content = [{ type: 'text', text: 'Exempts the sale with rate ' }, { type: 'inlineMath', attrs: { latex: '\\frac{1}{2}' } }];
    });
    const saved = await page.request.put(`/api/v1/notes/${revisionId}/document`, { headers: { 'if-match': `"${head.version}"` }, data: { doc, mode: head.mode, clientId: 'e2e' } });
    expect(saved.status()).toBe(200);
    // The first save starts the task through the event bus; wait for it.
    await expect.poll(async () => (await (await page.request.get(`/api/v1/notes/${revisionId}/workflow`)).json()).state, { timeout: 10_000 }).toBe('in_progress');
    const submit = await page.request.post(`/api/v1/notes/${revisionId}/transitions`, { data: { event: 'SUBMIT_FOR_REVIEW' } });
    expect(submit.status()).toBe(201);
    await loginAs(page, 'dev-reviewer', '/');
    expect((await page.request.post(`/api/v1/notes/${revisionId}/transitions`, { data: { event: 'CLAIM_REVIEW' } })).status()).toBe(201);
    const approve = await page.request.post(`/api/v1/notes/${revisionId}/transitions`, { data: { event: 'APPROVE', comment: 'Publish' } });
    expect((await approve.json()).state).toBe('approved');
    // Approval freezes the head asynchronously through the event bus.
    await expect.poll(async () => (await (await page.request.get(`/api/v1/notes/${revisionId}`)).json()).approvedVersion, { timeout: 10_000 }).not.toBeNull();
  });

  test('a viewer sees the approved note beside the bill with export links', async ({ page }) => {
    await loginAs(page, 'dev-viewer', '/bills/2025-26/HB2402/S');
    const panel = page.locator('.approved-note');
    await expect(panel.getByRole('heading', { name: 'Fiscal note' })).toBeVisible();
    await expect(panel).toContainText('Approved note for SHB 2402');
    await expect(panel.locator('.approved-html')).toContainText('(15,110,000)');
    await expect(panel.locator('.approved-html .katex').first()).toBeVisible();
    await expect(panel.locator('.approved-html')).toContainText('Pat Publisher');
    const links = panel.getByRole('group', { name: 'Export' });
    await expect(links.getByRole('link', { name: 'PDF' })).toHaveAttribute('href', new RegExp(`/api/v1/notes/${revisionId}/export\\?format=pdf`));
    // The bill viewer still shows the text on the left.
    await expect(page.locator('#sec-1, #sec-2').first()).toBeVisible();
    await axeClean(page);
    // Narrow screen: the panes stack behind tabs and the note tab shows the panel.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.getByRole('tab', { name: 'Fiscal note' }).click();
    await expect(panel).toBeVisible();
    await axeClean(page);
  });

  test('DOCX, PDF, HTML and FNS XML exports render the approved version', async ({ page }) => {
    await loginAs(page, 'dev-viewer', '/');
    const html = await page.request.get(`/api/v1/notes/${revisionId}/export?format=html`);
    expect(html.status()).toBe(200);
    expect(html.headers()['content-type']).toContain('text/html');
    const htmlText = await html.text();
    expect(htmlText).toContain('<table class="note-table"');
    expect(htmlText).toContain('(15,110,000)');
    expect(htmlText).toContain('class="katex"');
    const pdf = await page.request.get(`/api/v1/notes/${revisionId}/export?format=pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    const docx = await page.request.get(`/api/v1/notes/${revisionId}/export?format=docx`);
    expect(docx.status()).toBe(200);
    expect(docx.headers()['content-type']).toContain('wordprocessingml');
    expect((await docx.body()).subarray(0, 2).toString()).toBe('PK');
    // The FNS placeholder needs every required slot; the reviewer sees the list of empty ones.
    await loginAs(page, 'dev-reviewer', '/');
    const xml = await page.request.get(`/api/v1/notes/${revisionId}/export?format=xml`);
    expect([200, 422]).toContain(xml.status());
    if (xml.status() === 422) expect((await xml.json()).details.unfilledSlots.length).toBeGreaterThan(0);
    else expect(await xml.text()).toContain('<Field path="receipts.gf.fy1"');
  });

  test('the audit log lists exports, saves and transitions; the workspace export menu is present', async ({ page }) => {
    await loginAs(page, 'dev-admin', '/admin/audit');
    await page.getByLabel('Object id').fill(revisionId);
    await page.getByRole('button', { name: 'Filter' }).click();
    const rows = page.locator('table.audit tbody tr');
    await expect(rows.first()).toBeVisible();
    for (const action of ['note.export', 'note.document_save', 'workflow.approve', 'note.publish']) {
      await expect(rows.filter({ hasText: action }).first()).toBeVisible();
    }
    await axeClean(page);
    await loginAs(page, 'dev-reviewer', `/notes/${revisionId}`);
    await page.locator('.export-menu summary').click();
    await expect(page.getByRole('group', { name: 'Export formats' }).getByRole('link', { name: 'DOCX with comments' })).toBeVisible();
  });
});
