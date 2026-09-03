import { useEffect, useRef } from 'react';
import type { BillDocument, DiffLine, SectionDiff, VersionDiff } from '@wa-leg/bill-document/browser';
import { diffSummary } from '@wa-leg/bill-document/browser';
import { versionShortLabel, type BillUrlBuilder } from './cite';

interface Props {
  from: BillDocument;
  to: BillDocument;
  diff: VersionDiff;
  focusSectionId?: string | null;
  mode?: 'as-printed' | 'effect';
  urls: BillUrlBuilder;
  onClose?: () => void;
  /** Section id in the `to` document currently at the reading line. */
  onActiveSection?: (id: string | null) => void;
}

const GLYPH: Record<DiffLine['mark'], string> = { equal: ' ', changed: '▌', insert: '+', delete: '−' };
const NAME: Record<DiffLine['mark'], string> = { equal: '', changed: 'changed line', insert: 'added line', delete: 'removed line' };

export function DiffLineView({ line }: { line: DiffLine }) {
  return (
    <p className={`diff-line diff-line--${line.mark}${line.kind === 'note' ? ' diff-line--note' : ''}`} style={{ ['--depth' as string]: line.depth - 1 }} aria-label={NAME[line.mark] || undefined}>
      <span className="gutter" aria-hidden="true">
        {GLYPH[line.mark]}
      </span>
      <span className="line-text">
        {line.spans.map((s, i) => {
          const inner = s.billMark ? <span className={`bill-${s.billMark}`}>{s.text}</span> : s.text;
          if (s.mark === 'insert') return <ins key={i}>{inner}</ins>;
          if (s.mark === 'delete') return <del key={i}>{inner}</del>;
          return <span key={i}>{inner}</span>;
        })}
      </span>
    </p>
  );
}

function SectionDiffView({ sd, from, to, focus }: { sd: SectionDiff; from: BillDocument; to: BillDocument; focus: boolean }) {
  const toSec = sd.toSectionId ? to.sections.find((s) => s.id === sd.toSectionId) : null;
  const fromSec = sd.fromSectionId ? from.sections.find((s) => s.id === sd.fromSectionId) : null;
  const label = toSec?.label ?? fromSec?.label ?? sd.identity;
  const id = sd.toSectionId ?? sd.fromSectionId ?? sd.identity;
  const summary = sd.status === 'equal' ? 'No changes' : sd.status === 'renumbered' ? `Renumbered from Sec. ${sd.fromNum}, text unchanged` : diffSummary(sd.summary);
  return (
    <section className={`diff-section status-${sd.status}${focus ? ' target' : ''}`} id={id} aria-labelledby={`${id}-dh`} data-section data-diff-status={sd.status}>
      <h2 id={`${id}-dh`} className="sec-h">
        <span className="sec-num">{label}</span>
        <span className={`status status-${sd.status}`}> {sd.status}</span>
        <span className="muted"> · {summary}</span>
      </h2>
      {sd.lines.length > 0 ? (
        sd.lines.map((l, i) => <DiffLineView key={i} line={l} />)
      ) : (
        <p className="muted small">{sd.status === 'equal' ? 'Reading text identical (textHash equal).' : summary}</p>
      )}
    </section>
  );
}

export function VersionCompare({ from, to, diff, focusSectionId, mode = 'as-printed', urls, onClose, onActiveSection }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusSectionId || !rootRef.current) return;
    const el = rootRef.current.querySelector<HTMLElement>(`#${CSS.escape(focusSectionId)}`);
    if (el) {
      el.scrollIntoView({ block: 'start' });
      el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
    }
  }, [focusSectionId]);
  useEffect(() => {
    if (!rootRef.current || !onActiveSection) return;
    const headings = Array.from(rootRef.current.querySelectorAll<HTMLElement>('[data-section]'));
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) onActiveSection(visible[0].target.id);
      },
      { rootMargin: '-10% 0px -70% 0px' },
    );
    headings.forEach((h) => io.observe(h));
    return () => io.disconnect();
  }, [diff, onActiveSection]);
  const bill = { biennium: to.bill.biennium, id: to.bill.id };
  void urls;
  void bill;
  return (
    <div className="compare reading" role="region" aria-label="Version comparison" ref={rootRef}>
      <div className="compare-head">
        <p>
          <strong>{versionShortLabel(from)}</strong> → <strong>{versionShortLabel(to)}</strong>
          <span className="muted"> · {mode === 'effect' ? 'resulting law' : 'as printed'} · </span>
          {diffSummary(diff.summary)}
          {diff.summary.sectionsChanged > 0 && <span className="muted"> in {diff.summary.sectionsChanged} sections</span>}
        </p>
        <dl className="legend" aria-label="Legend">
          <dt>
            <span className="gutter" aria-hidden="true">
              ▌
            </span>
          </dt>
          <dd>changed line</dd>
          <dt>
            <span className="gutter" aria-hidden="true">
              +
            </span>
          </dt>
          <dd>added line</dd>
          <dt>
            <span className="gutter" aria-hidden="true">
              −
            </span>
          </dt>
          <dd>removed line</dd>
          <dt>
            <ins>text</ins>
          </dt>
          <dd>inserted between versions</dd>
          <dt>
            <del>text</del>
          </dt>
          <dd>removed between versions</dd>
          <dt>
            <span className="bill-ins">text</span>
          </dt>
          <dd>the bill's own underline (added to current law)</dd>
          <dt>
            <span className="bill-del">((text))</span>
          </dt>
          <dd>the bill's own strike (removed from current law)</dd>
        </dl>
        {onClose && (
          <button type="button" className="secondary" onClick={onClose}>
            Close comparison
          </button>
        )}
      </div>
      {diff.sections.map((sd) => (
        <SectionDiffView key={`${sd.identity}:${sd.fromSectionId}:${sd.toSectionId}`} sd={sd} from={from} to={to} focus={!!focusSectionId && (sd.toSectionId === focusSectionId || sd.fromSectionId === focusSectionId)} />
      ))}
    </div>
  );
}
