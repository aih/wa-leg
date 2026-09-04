import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs, setTheme } from './helpers';

const URL = '/bills/2025-26/HB2402/S#sec-2';

async function open(page: Page, url = URL, scheme?: 'light' | 'dark') {
  await loginAs(page, 'dev-drafter', url);
  if (scheme) await setTheme(page, scheme);
  await expect(page.getByRole('region', { name: 'Reading column' })).toBeVisible();
}

test.describe('bill viewer', () => {
  test('opens the substitute at section 2 with outline, sticky bar, switcher, RCW list and marks', async ({ page }) => {
    await open(page);
    const viewer = page.getByRole('region', { name: 'Bill text' });
    await expect(viewer).toBeVisible();
    // Version switcher shows the substitute selected.
    const switcher = page.getByRole('combobox', { name: 'Version' });
    await expect(switcher).toHaveValue('S');
    await expect(switcher.locator('option')).toHaveCount(2);
    // Outline lists sections with glosses and the RCW-affected list.
    const outline = page.getByRole('navigation', { name: 'Bill outline' });
    await expect(outline.getByRole('link', { name: /Sec\. 2/ })).toBeVisible();
    await expect(outline.getByRole('heading', { name: 'RCW affected' })).toBeVisible();
    await expect(outline.locator('.rcw-affected').getByRole('link', { name: /70A/ })).toBeVisible();
    // Deep link landed on section 2: it is the active section in the sticky bar.
    const bar = page.getByRole('navigation', { name: 'Section' });
    await expect(bar).toContainText('Sec. 2');
    await expect(outline.locator('[aria-current="true"]')).toContainText('Sec. 2');
    await expect(page.locator('#sec-2')).toBeFocused();
    // Reading column has blocks with hanging labels.
    await expect(page.locator('#sec-2\\.1 .num')).toHaveText('(1)');
  });

  test('renders the printed-bill marks with accessible prefixes', async ({ page }) => {
    await open(page, '/bills/2025-26/SB6137/I#sec-2');
    const sec = page.locator('#sec-2');
    await expect(sec.locator('del').first()).toContainText('((');
    await expect(sec.locator('ins').first()).toBeVisible();
    await expect(sec.locator('del .visually-hidden').first()).toHaveText('struck: ');
    // The amendatory section names its RCW target.
    await expect(sec.getByRole('link', { name: /RCW 9\.46\.038/ })).toBeVisible();
  });

  test('keyboard map moves between sections and opens help', async ({ page }) => {
    await open(page);
    await page.locator('#sec-2').focus();
    await page.keyboard.press('j');
    await expect(page.getByRole('navigation', { name: 'Section' })).toContainText('Sec. 3');
    await page.keyboard.press('k');
    await expect(page.getByRole('navigation', { name: 'Section' })).toContainText('Sec. 2');
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
    // Keys do nothing in a text field.
    await page.getByRole('searchbox', { name: 'Find in bill' }).fill('j');
    await expect(page.getByRole('navigation', { name: 'Section' })).toContainText('Sec. 2');
  });

  test('Cite emits a citation for the section and for a selection', async ({ page }) => {
    await open(page);
    await page.locator('#sec-2').focus();
    await page.getByRole('navigation', { name: 'Section' }).getByRole('button', { name: 'Cite', exact: true }).click();
    const list = page.getByRole('region', { name: /Citations emitted/ }).or(page.locator('.cite-list'));
    await expect(list.getByRole('link', { name: 'Section 2 of SHB 2402' })).toBeVisible();
    await expect(list.getByRole('link', { name: 'Section 2 of SHB 2402' })).toHaveAttribute('href', '/bills/2025-26/HB2402/S#sec-2');
    // Select words inside (1) and cite with the floating control.
    const block = page.locator('#sec-2\\.1 > .text');
    await block.evaluate((el) => {
      const range = document.createRange();
      const textNode = Array.from(el.querySelectorAll('span')).find((s) => s.textContent?.includes('DEHP'))!.firstChild!;
      range.setStart(textNode, 0);
      range.setEnd(textNode, 6);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.getByRole('group', { name: 'Selection actions' }).getByRole('button', { name: 'Cite' }).click();
    await expect(list.getByRole('link', { name: 'Section 2(1) of SHB 2402' })).toHaveAttribute('href', '/bills/2025-26/HB2402/S#sec-2.1');
  });

  test('version switcher navigates and the compare view renders the redline', async ({ page }) => {
    await open(page);
    await page.getByRole('combobox', { name: 'Version' }).selectOption('I');
    await expect(page).toHaveURL(/\/bills\/2025-26\/HB2402\/I$/);
    await expect(page.getByRole('combobox', { name: 'Version' })).toHaveValue('I');
    // Back to S and compare with Introduced.
    await page.goto('/bills/2025-26/HB2402/S');
    await page.getByText('Compare with…').click();
    await page.getByRole('link', { name: /What changed since/ }).click();
    await expect(page).toHaveURL(/\/compare\?from=I&to=S/);
    const cmp = page.getByRole('region', { name: 'Version comparison' });
    await expect(cmp).toBeVisible();
    await expect(cmp.getByText(/lines? changed|added|removed/).first()).toBeVisible();
    await expect(cmp.locator('.diff-line--changed, .diff-line--insert, .diff-line--delete').first()).toBeVisible();
    await expect(cmp.locator('[data-diff-status="changed"]').first()).toBeVisible();
    // Legend is text, gutter glyphs are present.
    await expect(cmp.getByText('changed line', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close comparison' }).click();
    await expect(page).toHaveURL(/\/bills\/2025-26\/HB2402\/S/);
  });

  test('bill page without a version code redirects to the current version', async ({ page }) => {
    await loginAs(page, 'dev-committee', '/bills/2025-26/HB2402');
    await expect(page).toHaveURL(/\/bills\/2025-26\/HB2402\/S$/);
  });

  test('the pane collapses to a rail and the splitter is keyboard operable', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);
    const sep = page.getByRole('separator', { name: /Resize panes/ });
    await sep.focus();
    const before = Number(await sep.getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowLeft');
    expect(Number(await sep.getAttribute('aria-valuenow'))).toBeLessThan(before);
    await page.keyboard.press('Home');
    await expect(page.getByRole('button', { name: /Expand the HB2402 pane/ })).toBeVisible();
    await page.getByRole('button', { name: /Expand the HB2402 pane/ }).click();
    await expect(page.getByRole('region', { name: 'Reading column' })).toBeVisible();
  });
});

const widths = [320, 375, 768, 1280];
const schemes = ['light', 'dark'] as const;
for (const scheme of schemes) {
  for (const width of widths) {
    test(`axe: bill page at ${width}px ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, URL, scheme);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      expect(results.violations, JSON.stringify(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), null, 1)).toEqual([]);
    });
  }
}

test('axe: compare view light and dark at 1280px', async ({ page }) => {
  for (const scheme of schemes) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, 'dev-drafter', '/bills/2025-26/HB2402/compare?from=I&to=S&at=sec-3');
    await setTheme(page, scheme);
    await expect(page.getByRole('region', { name: 'Version comparison' })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(results.violations, JSON.stringify(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), null, 1)).toEqual([]);
  }
});
