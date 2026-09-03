// FNS XML export. The OFM Fiscal Note System upload schema is not public (docs/OPEN-ITEMS.md); the mapper
// interface isolates the placeholder element names so the real schema can replace them in one file.
import { docToHtml, findAll, textOf, walk, type EditorMode, type EstimateData, type PMNode } from '@wa-leg/note-schema';

export interface FnsHeader {
  billNumber: string;
  billTitle: string;
  agencyCode: string;
  agencyName: string;
  requestId?: string | null;
  versionLabel: string;
  preparedBy?: { name?: string; phone?: string; date?: string } | null;
}

export interface FnsXmlMapper {
  readonly schemaVersion: string;
  render(input: { header: FnsHeader; doc: PMNode; estimate: EstimateData; mode: EditorMode }): string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

/** Placeholder mapping from research/editor.md section 6.4: slot values, Part I tables from estimate data, and the narrative parts as limited HTML. */
export class PlaceholderFnsXmlMapper implements FnsXmlMapper {
  readonly schemaVersion = 'placeholder';

  render({ header, doc, estimate, mode }: { header: FnsHeader; doc: PMNode; estimate: EstimateData; mode: EditorMode }): string {
    const lines: string[] = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push(`<FiscalNote schemaVersion="${this.schemaVersion}" generator="wa-leg-workbench">`);
    lines.push('  <Header>');
    lines.push(`    <BillNumber>${esc(header.billNumber)}</BillNumber>`);
    lines.push(`    <BillTitle>${esc(header.billTitle)}</BillTitle>`);
    lines.push(`    <BillVersion>${esc(header.versionLabel)}</BillVersion>`);
    lines.push(`    <AgencyCode>${esc(header.agencyCode)}</AgencyCode>`);
    lines.push(`    <AgencyName>${esc(header.agencyName)}</AgencyName>`);
    if (header.requestId) lines.push(`    <RequestNumber>${esc(header.requestId)}</RequestNumber>`);
    lines.push(`    <PreparedBy name="${esc(header.preparedBy?.name ?? '')}" phone="${esc(header.preparedBy?.phone ?? '')}" date="${esc(header.preparedBy?.date ?? '')}"/>`);
    lines.push('  </Header>');

    // Every slot value, by data-model path (checkboxes as booleans).
    lines.push('  <Fields>');
    walk(doc, (n) => {
      const slot = n.attrs?.slot as string | undefined;
      if (!slot) return;
      if (n.type === 'checkbox') lines.push(`    <Field path="${esc(slot)}" type="boolean">${n.attrs?.checked ? 'true' : 'false'}</Field>`);
      else if (n.type === 'slot' || n.type === 'noteCell' || n.type === 'paragraph') {
        const value = n.attrs?.value;
        const text = textOf(n).trim();
        lines.push(`    <Field path="${esc(slot)}"${n.attrs?.slotType ? ` type="${esc(String(n.attrs.slotType))}"` : ''}${typeof value === 'number' ? ` value="${value}"` : ''}>${esc(text)}</Field>`);
      }
      if (n.type === 'slot' || n.type === 'noteCell') return false;
      return;
    });
    lines.push('  </Fields>');

    const rows = (name: string, unit: string, list: EstimateData['revenue']) => {
      lines.push(`    <${name} unit="${unit}">`);
      for (const r of list) {
        lines.push(`      <Fund code="${esc(r.fund)}" name="${esc(r.fundName)}"${r.source ? ` source="${esc(r.source)}"` : ''} key="${esc(r.key)}">`);
        for (const [year, v] of Object.entries(r.fy)) lines.push(`        <FY year="${year}">${v}</FY>`);
        for (const [id, v] of Object.entries(r.biennia)) lines.push(`        <Biennium id="${id}">${v}</Biennium>`);
        lines.push('      </Fund>');
      }
      lines.push(`    </${name}>`);
    };
    lines.push('  <PartI>');
    lines.push(`    <NoFiscalImpact>${estimate.flags.noFiscalImpact ? 'true' : 'false'}</NoFiscalImpact>`);
    rows('Revenue', 'dollars', estimate.revenue);
    rows('Expenditure', 'dollars', estimate.expenditure);
    rows('FTE', 'fte', estimate.fte);
    rows('LocalRevenue', 'dollars', estimate.local);
    for (const [flag, on] of Object.entries(estimate.flags)) lines.push(`    <Flag name="${esc(flag)}">${on ? 'true' : 'false'}</Flag>`);
    lines.push('  </PartI>');

    // Narrative parts as limited HTML.
    lines.push('  <Narrative>');
    for (const s of findAll(doc, 'noteSection')) {
      const part = String(s.attrs?.part ?? 'unknown');
      const html = docToHtml({ type: 'doc', content: s.content ?? [] }, { mode, unwrapSlots: true, stripComments: true, renderMath: false, citationsAs: 'text' });
      lines.push(`    <Section part="${esc(part)}"${s.attrs?.title ? ` title="${esc(String(s.attrs.title))}"` : ''}>${cdata(html)}</Section>`);
    }
    lines.push('  </Narrative>');

    if (estimate.objects.length) rows('ExpenditureByObject', 'dollars', estimate.objects);
    if (estimate.tenYear.length) {
      lines.push('  <TenYear>');
      for (const t of estimate.tenYear) {
        lines.push(`    <Row key="${esc(t.key)}" title="${esc(t.title)}" account="${esc(t.account)}" total="${t.total}">`);
        for (const [year, v] of Object.entries(t.fy)) lines.push(`      <FY year="${year}">${v}</FY>`);
        lines.push('    </Row>');
      }
      lines.push('  </TenYear>');
    }
    lines.push('</FiscalNote>');
    return lines.join('\n') + '\n';
  }
}
