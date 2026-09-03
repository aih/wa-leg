import type { ReactNode } from 'react';
import type { BillDocument, BillSection, Block, Run, TableData } from '@wa-leg/bill-document/browser';
import type { BillUrlBuilder } from './cite';
import { sectionGloss } from './cite';

export interface Annotation {
  id: string;
  sectionId: string;
  blockId?: string;
  range?: { start: number; end: number };
  kind: 'citation' | 'comment' | 'assumption' | 'flag';
  label: string;
  href?: string;
}

interface Props {
  document: BillDocument;
  urls: BillUrlBuilder;
  annotations?: Annotation[];
  showLineNumbers?: boolean;
  markPrefixes?: boolean;
  onSectionActivate?: (sectionId: string, via: 'click') => void;
  onAnnotationActivate?: (a: Annotation) => void;
}

export function RunsView({ runs, urls, prefixes = true }: { runs: Run[]; urls: BillUrlBuilder; prefixes?: boolean }) {
  return (
    <>
      {runs.map((r, i) => {
        const key = i;
        if (r.t === 'cite' && r.cite) {
          const href = r.cite.kind === 'bill-section' && r.cite.targetId ? `#${r.cite.targetId}` : r.cite.href ?? (r.cite.cite ? urls.rcw(r.cite.cite) : undefined);
          const external = !!href && !href.startsWith('#');
          const link = href ? (
            <a key={key} href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined} className="cite">
              {r.text}
              {external && <span className="visually-hidden"> (opens leg.wa.gov)</span>}
            </a>
          ) : (
            <span key={key}>{r.text}</span>
          );
          if (r.mark === 'ins') return <ins key={key}>{prefixes && <span className="visually-hidden">inserted: </span>}{link}{prefixes && <span className="visually-hidden"> end inserted</span>}</ins>;
          if (r.mark === 'del') return <del key={key}>{prefixes && <span className="visually-hidden">struck: </span>}{link}{prefixes && <span className="visually-hidden"> end struck</span>}</del>;
          return link;
        }
        if (r.t === 'ins') {
          return (
            <ins key={key}>
              {prefixes && <span className="visually-hidden">inserted: </span>}
              {r.text}
              {prefixes && <span className="visually-hidden"> end inserted</span>}
            </ins>
          );
        }
        if (r.t === 'del') {
          return (
            <del key={key}>
              {prefixes && <span className="visually-hidden">struck: </span>}
              {r.text}
              {prefixes && <span className="visually-hidden"> end struck</span>}
            </del>
          );
        }
        return <span key={key}>{r.text}</span>;
      })}
    </>
  );
}

function TableView({ table, urls }: { table: TableData; urls: BillUrlBuilder }) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Table">
      <table className="bill-table">
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => {
                const Tag = cell.header ? 'th' : 'td';
                return (
                  <Tag key={ci} colSpan={cell.colspan} rowSpan={cell.rowspan} style={cell.align ? { textAlign: cell.align } : undefined} scope={cell.header ? 'col' : undefined}>
                    <RunsView runs={cell.runs} urls={urls} />
                  </Tag>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BlockView({
  block,
  urls,
  annotations,
  showLineNumbers,
  prefixes,
  onAnnotationActivate,
}: {
  block: Block;
  urls: BillUrlBuilder;
  annotations?: Annotation[];
  showLineNumbers?: boolean;
  prefixes?: boolean;
  onAnnotationActivate?: (a: Annotation) => void;
}) {
  const own = annotations?.filter((a) => a.blockId === block.id) ?? [];
  const labelNode: ReactNode = block.label ? (
    block.labelMark === 'ins' ? (
      <ins className="num">{block.label}</ins>
    ) : block.labelMark === 'del' ? (
      <del className="num">(({block.label}))</del>
    ) : (
      <span className="num">{block.label}</span>
    )
  ) : null;
  return (
    <div className={`prov prov--${block.kind} depth-${block.level}`} id={block.id} data-block>
      {showLineNumbers && block.lines && (
        <span className="lineno" aria-hidden="true">
          {block.lines.pageStart}:{block.lines.lineStart}
        </span>
      )}
      {own.length > 0 && (
        <span className="annot-gutter">
          {own.map((a) => (
            <button key={a.id} type="button" className={`annot annot--${a.kind}`} title={a.label} aria-label={a.label} onClick={() => onAnnotationActivate?.(a)}>
              <span aria-hidden="true">{a.kind === 'citation' ? '❝' : a.kind === 'comment' ? '✎' : a.kind === 'flag' ? '⚑' : '≡'}</span>
            </button>
          ))}
        </span>
      )}
      {block.table ? (
        <>
          {labelNode}
          <TableView table={block.table} urls={urls} />
        </>
      ) : (
        <p className={`text${block.align ? ` align-${block.align}` : ''}`}>
          {labelNode}
          {labelNode && ' '}
          <RunsView runs={block.runs} urls={urls} prefixes={prefixes} />
        </p>
      )}
      {block.children.map((c) => (
        <BlockView key={c.id} block={c} urls={urls} annotations={annotations} showLineNumbers={showLineNumbers} prefixes={prefixes} onAnnotationActivate={onAnnotationActivate} />
      ))}
    </div>
  );
}

export function SectionView({
  section,
  urls,
  annotations,
  showLineNumbers,
  prefixes,
  onActivate,
  onAnnotationActivate,
  part,
}: {
  section: BillSection;
  urls: BillUrlBuilder;
  annotations?: Annotation[];
  showLineNumbers?: boolean;
  prefixes?: boolean;
  onActivate?: (id: string) => void;
  onAnnotationActivate?: (a: Annotation) => void;
  part?: boolean;
}) {
  const gloss = sectionGloss(section);
  return (
    <>
      {part && section.part && (
        <h2 className="part-heading" id={`part-${section.id}`}>
          <span className="part-label">{section.part.label}</span>
          {section.part.heading && <span className="part-title"> {section.part.heading}</span>}
        </h2>
      )}
      <section className={`bill-section kind-${section.kind}`} id={section.id} aria-labelledby={`${section.id}-h`} data-section>
        <h2 id={`${section.id}-h`} className="sec-h">
          <button type="button" className="sec-label" onClick={() => onActivate?.(section.id)}>
            {section.isNewSection && <span className="new-section">NEW SECTION. </span>}
            <span className="sec-num">Sec. {section.num}.</span>
          </button>
          {gloss && <span className="sec-gloss"> {gloss}</span>}
          {section.veto && <span className="badge badge-veto"> vetoed</span>}
        </h2>
        {section.introText && section.introText.length > 0 && (
          <p className="intro">
            <RunsView runs={section.introText} urls={urls} prefixes={prefixes} />
            {section.heading && <span className="caption"> {section.heading}</span>}
          </p>
        )}
        {section.blocks.map((b) => (
          <BlockView key={b.id} block={b} urls={urls} annotations={annotations} showLineNumbers={showLineNumbers} prefixes={prefixes} onAnnotationActivate={onAnnotationActivate} />
        ))}
        {section.notes && section.notes.length > 0 && (
          <details className="notes">
            <summary>History and notes</summary>
            <ul>
              {section.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </>
  );
}

export function BillHeaderView({ document }: { document: BillDocument }) {
  const h = document.header;
  return (
    <details className="bill-header" open>
      <summary>
        <span className="long-id">{h.longBillId ?? document.version.label}</span>
        {h.session && <span className="muted"> · {h.session}</span>}
      </summary>
      <h1 className="bill-title">{h.title}</h1>
      <dl className="bill-meta">
        {h.sponsors && (
          <>
            <dt>By</dt>
            <dd>{h.sponsors.join('; ')}</dd>
          </>
        )}
        {h.readFirstTime && (
          <>
            <dt>Read first time</dt>
            <dd>{h.readFirstTime}</dd>
          </>
        )}
        {h.briefDescription && (
          <>
            <dt>Brief description</dt>
            <dd>{h.briefDescription}</dd>
          </>
        )}
        {document.certificate?.chapter && (
          <>
            <dt>Session law</dt>
            <dd>
              Chapter {document.certificate.chapter}, Laws of {document.certificate.year}
              {document.certificate.partialVeto ? ' (partial veto)' : ''}
              {document.certificate.effectiveDate ? ` · Effective ${document.certificate.effectiveDate}` : ''}
            </dd>
          </>
        )}
      </dl>
      <p className="enacting">BE IT ENACTED BY THE LEGISLATURE OF THE STATE OF WASHINGTON:</p>
    </details>
  );
}

export function ReadingColumn({ document, urls, annotations, showLineNumbers, markPrefixes = true, onSectionActivate, onAnnotationActivate }: Props) {
  let lastPart: string | undefined;
  return (
    <div className="reading" role="region" aria-label="Reading column">
      <BillHeaderView document={document} />
      {document.sections.map((s) => {
        const showPart = !!s.part && s.part.label !== lastPart;
        lastPart = s.part?.label;
        return (
          <SectionView
            key={s.id}
            section={s}
            urls={urls}
            annotations={annotations}
            showLineNumbers={showLineNumbers}
            prefixes={markPrefixes}
            part={showPart}
            onActivate={(id) => onSectionActivate?.(id, 'click')}
            onAnnotationActivate={onAnnotationActivate}
          />
        );
      })}
      {document.certificate?.history && document.certificate.history.length > 0 && (
        <section className="certificate" aria-label="Certificate">
          <ul>
            {document.certificate.history.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </section>
      )}
      <p className="provenance muted">
        Source fetched {document.provenance.fetchedAt.slice(0, 10)} by {document.provenance.parser} {document.provenance.parserVersion}
        {document.version.sourceUrls?.pdf && (
          <>
            {' · '}
            <a href={urls.source(document.version.sourceUrls.pdf)} target="_blank" rel="noreferrer">
              Printed bill (PDF)
            </a>
          </>
        )}
        {document.provenance.warnings && document.provenance.warnings.length > 0 && <> · {document.provenance.warnings.length} parser warnings</>}
      </p>
    </div>
  );
}
