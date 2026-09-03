import { useMemo, useState, type FormEvent } from 'react';
import type { BillDocument } from '@wa-leg/bill-document/browser';
import { sectionGloss, sectionPlainText, sectionSubjectLabel, type BillUrlBuilder } from './cite';

interface Props {
  document: BillDocument;
  activeSectionId: string | null;
  changedSectionIds?: string[];
  amendedSectionIds?: string[];
  annotationCounts?: Record<string, number>;
  showRcwAffected?: boolean;
  urls: BillUrlBuilder;
  onSelect?: (sectionId: string, via: 'click' | 'keyboard') => void;
  onFind?: (query: string) => void;
  findInputRef?: React.RefObject<HTMLInputElement | null>;
}

const ACTION_LETTER: Record<string, string> = { amend: 'A', 'reenact-amend': 'A', add: '+', repeal: 'R', decodify: 'D', recodify: 'C', reference: '·' };

export function BillOutline({ document, activeSectionId, changedSectionIds, amendedSectionIds, annotationCounts, showRcwAffected = true, urls, onSelect, onFind, findInputRef }: Props) {
  const [query, setQuery] = useState('');
  const texts = useMemo(() => new Map(document.sections.map((s) => [s.id, sectionPlainText(s).toLowerCase()])), [document]);
  const q = query.trim().toLowerCase();
  const matches = q ? document.sections.filter((s) => texts.get(s.id)?.includes(q) || sectionGloss(s).toLowerCase().includes(q) || (sectionSubjectLabel(s)?.toLowerCase().includes(q) ?? false)) : document.sections;
  const changed = new Set(changedSectionIds ?? []);
  const amended = new Set(amendedSectionIds ?? []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onFind?.(query);
    const first = matches[0];
    if (first) onSelect?.(first.id, 'keyboard');
  };
  return (
    <nav className="outline" aria-label="Bill outline">
      <form role="search" className="find" onSubmit={submit}>
        <label htmlFor="find-in-bill" className="visually-hidden">
          Find in bill
        </label>
        <input id="find-in-bill" ref={findInputRef} type="search" placeholder="Find in bill" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
        <span className="muted find-count" aria-live="polite">
          {q ? `${matches.length} of ${document.sections.length}` : ''}
        </span>
      </form>
      <ol className="outline-list">
        {matches.map((s) => {
          const subject = sectionSubjectLabel(s);
          // The action ("amends RCW 82.04.260") stays as a second line unless the subject already says it.
          const gloss = sectionGloss(s);
          const showGloss = gloss && !!s.target && (subject ?? '').replace(/^\[|\]$/g, '').toLowerCase() !== gloss.toLowerCase();
          const count = annotationCounts?.[s.id];
          return (
            <li key={s.id} className={`outline-item kind-${s.kind}${changed.has(s.id) ? ' changed' : ''}${amended.has(s.id) ? ' amended' : ''}`}>
              <a
                href={`#${s.id}`}
                aria-current={activeSectionId === s.id ? 'true' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  onSelect?.(s.id, 'click');
                }}
              >
                <span className="outline-num">
                  {s.isNewSection && (
                    <i className="outline-new" title="New section (not an amendment of existing law)">
                      NEW SECTION{' '}
                    </i>
                  )}
                  Sec. {s.num}
                </span>
                {changed.has(s.id) && <span className="dot" aria-label="changed in this comparison" />}
                {amended.has(s.id) && <span className="dot dot-amend" aria-label="amended by the overlay" />}
                {count ? <span className="count" aria-label={`${count} annotations`}>{count}</span> : null}
                {subject && <span className="outline-subject">{subject}</span>}
                {showGloss && <span className="outline-gloss">{gloss}</span>}
              </a>
            </li>
          );
        })}
      </ol>
      {showRcwAffected && document.rcwAffected && document.rcwAffected.length > 0 && (
        <section className="rcw-affected" aria-labelledby="rcw-affected-h">
          <h3 id="rcw-affected-h">RCW affected</h3>
          <ul>
            {document.rcwAffected.map((r) => (
              <li key={`${r.action}:${r.cite}`}>
                <a href={r.href ?? urls.rcw(r.cite)} target="_blank" rel="noreferrer" title={r.caption}>
                  {r.cite}
                  <span className="visually-hidden"> (opens leg.wa.gov)</span>
                </a>
                <span className={`action action-${r.action}`} title={r.action}>
                  {' '}
                  {ACTION_LETTER[r.action] ?? '·'}
                  <span className="visually-hidden"> {r.action}</span>
                </span>{' '}
                {r.sectionIds.map((sid) => (
                  <a
                    key={sid}
                    href={`#${sid}`}
                    className="jump"
                    onClick={(e) => {
                      e.preventDefault();
                      onSelect?.(sid, 'click');
                    }}
                  >
                    §{sid.replace('sec-', '')}
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
    </nav>
  );
}
