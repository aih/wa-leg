import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionLabels, type TemplateContext } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = join(here, '..', '..', '..', 'design', 'templates');

export const manifest = JSON.parse(readFileSync(join(TEMPLATES_DIR, 'manifest.json'), 'utf8')) as {
  templates: { id: string; name: string; file: string; description: string; tags: string[]; parts: string[]; tables: string[]; slots: string[]; tokens: string[] }[];
};

export function templateHtml(file: string): string {
  return readFileSync(join(TEMPLATES_DIR, file), 'utf8');
}

export function templateFiles(): string[] {
  return readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.html')).sort();
}

export const JOB_CLASSES = [
  { title: 'EXCISE TAX EX 2', salary: '59,844' },
  { title: 'EXCISE TAX EX 3', salary: '66,012' },
  { title: 'TAX POLICY SP 3', salary: '91,068' },
  { title: 'IT B A-JOURNEY', salary: '94,728' },
  { title: 'MGMT ANALYST4', salary: '78,468' },
  { title: 'WMS BAND 2', salary: '101,410' },
];

/** Salary tokens as the templates spell them (templates/README.md `ref.salary.<CLASS>`). */
export const SALARIES: Record<string, string> = {
  EMS_BAND_4: '135,635',
  EXCISE_TAX_EX_2: '59,844',
  EXCISE_TAX_EX_3: '66,012',
  EXCISE_TAX_EX_4: '72,924',
  IT_BA_JOURNEY: '94,728',
  IT_BA_SR_SPEC: '104,412',
  IT_QA_JOURNEY: '94,728',
  IT_SYS_ADM_JOURNEY: '99,444',
  MGMT_ANALYST_4: '78,468',
  PROPERTY_ACQ_SP_5: '78,468',
  REVENUE_AUDITOR_3: '72,924',
  REVENUE_AUDITOR_4: '91,068',
  TAX_INFO_SPEC_1: '47,988',
  TAX_POLICY_SP_2: '80,460',
  TAX_POLICY_SP_3: '91,068',
  TAX_POLICY_SP_4: '98,040',
  WMS_BAND_2: '101,410',
  WMS_BAND_3: '115,352',
};

export function sampleContext(overrides: Partial<TemplateContext> = {}): TemplateContext {
  const labels = sessionLabels(2026);
  return {
    bill: { number: '2402 S HB', numberOnly: '2402', version: 'SHB', title: 'Phthalates/medical equipment', effectiveDate: 'January 1, 2030', effectiveSection: '3', prefExemptSection: '2', key: 'WA:2025-26:HB2402', versionCode: 'S' },
    agency: { code: '140', name: 'Department of Revenue' },
    request: { date: '02/05/2026', id: '2402-1-1', tenYearRequested: true },
    legContact: { name: 'Jane Legislative', phone: '360-786-7100' },
    preparer: { name: 'Dana Drafter', phone: '360-534-1500', date: '02/06/2026', datetime: '02/06/2026 10:00 AM' },
    approver: { name: '', phone: '', date: '' },
    ofm: { name: '', phone: '', date: '' },
    session: { year: 2026, biennium: labels.biennium },
    fy: labels.fy,
    bien: labels.bien,
    cy: labels.cy,
    impl: { date: 'January 1, 2030', leadMonths: 0 },
    impact: { months: { state: 'five', local: 'four' } },
    ref: {
      forecast: { vintage: 'November 2025' },
      localRate: '3.0',
      aprilShare: '52.62',
      octoberShare: '47.38',
      salary: SALARIES,
      tes: { year: 2024 },
      priorYear: 2025,
      priorFY: 'FY 2025',
    },
    prior: { requestId: '2402-1', versionLabel: 'HB 2402' },
    ...overrides,
  };
}
