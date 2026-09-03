// HTML → PDF with Playwright Chromium (research/editor.md section 6.3). One browser per process, started on
// first use; the HTML is written to a file so the KaTeX stylesheet and fonts load from disk.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

let browser: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = chromium.launch({ headless: true }).catch((err) => {
      browser = null;
      throw err;
    });
  }
  return browser;
}

export async function closePdfRenderer(): Promise<void> {
  if (!browser) return;
  const b = await browser.catch(() => null);
  browser = null;
  await b?.close();
}

export interface PdfOptions {
  footerLeft: string;
  workDir: string;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function htmlToPdf(html: string, opts: PdfOptions): Promise<Buffer> {
  mkdirSync(opts.workDir, { recursive: true });
  const file = join(opts.workDir, `render-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(file, html);
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.goto(`file://${file}`, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({
      format: 'Letter',
      margin: { top: '1in', right: '1in', bottom: '1in', left: '1in' },
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="font-size:8px;color:#555;width:100%;padding:0 1in;display:flex;justify-content:space-between;font-family:Arial,Helvetica,sans-serif"><span>${escape(opts.footerLeft)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
    rmSync(file, { force: true });
  }
}
