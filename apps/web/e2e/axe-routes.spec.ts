import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs } from './helpers';

/**
 * Milestone 8: axe clean on every route, at four widths and two themes. The bill viewer routes have their own sweep
 * in bill-viewer.spec.ts; the editor is checked in notes.spec.ts. This sweep covers the remaining routes per persona.
 */

const WIDTHS = [320, 375, 768, 1280];
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function analyze(page: Page, exclude?: string) {
  let builder = new AxeBuilder({ page }).withTags(TAGS);
  if (exclude) builder = builder.exclude(exclude);
  const r = await builder.analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

let revisionId: string;

test.beforeAll(async ({ browser }) => {
  // A note the sweep can open in the workspace and versions page.
  const page = await browser.newPage();
  await loginAs(page, 'dev-reviewer', '/');
  const created = await page.request.post('/api/v1/notes', { data: { billKey: 'WA:2025-26:HB2402', versionCode: 'S', templateId: 'no-fiscal-impact', drafterId: 'dev-drafter', request: { requestId: 'axe-sweep' } } });
  revisionId = (await created.json()).noteRevisionId;
  await page.close();
});

const ROUTES: { path: string; user: string | null; ready: string; exclude?: string; name: string }[] = [
  { name: 'home (anonymous)', path: '/', user: null, ready: 'text=How to try it' },
  { name: 'guide', path: '/guide', user: null, ready: 'text=Walkthrough' },
  { name: 'home (viewer)', path: '/', user: 'dev-viewer', ready: 'h1' },
  { name: 'drafter dashboard', path: '/dashboard/drafter', user: 'dev-drafter', ready: 'h1' },
  { name: 'reviewer dashboard', path: '/dashboard/reviewer', user: 'dev-reviewer', ready: 'h1' },
  { name: 'inbox', path: '/inbox', user: 'dev-drafter', ready: 'h1' },
  { name: 'search results', path: '/search?q=phthalates', user: 'dev-viewer', ready: '.hits' },
  { name: 'bill page (viewer)', path: '/bills/2025-26/HB2402/S', user: 'dev-viewer', ready: '.approved-note', exclude: '.bill-viewer' },
  { name: 'workspace (drafter)', path: '/notes/__note__', user: 'dev-drafter', ready: '.note-editor-body', exclude: '.bill-viewer' },
  { name: 'workspace (reviewer, read-only)', path: '/notes/__note__', user: 'dev-reviewer', ready: '.note-editor-body', exclude: '.bill-viewer' },
  { name: 'versions', path: '/notes/__note__/versions', user: 'dev-drafter', ready: '.version-list' },
  { name: 'admin audit', path: '/admin/audit', user: 'dev-admin', ready: 'table.audit' },
  { name: 'admin templates', path: '/admin/templates', user: 'dev-template-editor', ready: 'h1' },
  { name: 'admin ingest', path: '/admin/ingest', user: 'dev-admin', ready: 'h1' },
  { name: 'not found', path: '/nope', user: 'dev-viewer', ready: 'h1' },
];

for (const route of ROUTES) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`axe: ${route.name} ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const path = route.path.replace('__note__', revisionId);
      if (route.user) await loginAs(page, route.user, path);
      else await page.goto(path);
      await page.locator(route.ready).first().waitFor({ timeout: 15_000 });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(150);
        expect(await analyze(page, route.exclude), `${route.name} at ${width}px ${scheme}`).toEqual([]);
      }
    });
  }
}
