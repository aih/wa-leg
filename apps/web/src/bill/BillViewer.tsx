import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AmendmentDocument, BillDocument, BillSection, CiteEvent, VersionDiff } from '@wa-leg/bill-document/browser';
import { BillOutline } from './BillOutline';
import { ReadingColumn, type Annotation } from './ReadingColumn';
import { VersionCompare } from './VersionCompare';
import { SHORTCUTS, actionForKey, type ShortcutAction } from './shortcuts';
import { citationString, defaultUrlBuilder, findBlock, makeCiteEvent, sectionGloss, sectionSubjectLabel, sectionPlainText, versionShortLabel, type BillUrlBuilder } from './cite';

export interface SectionSelectEvent {
  sectionId: string;
  sectionNum: string;
  kind: BillSection['kind'];
  target?: BillSection['target'];
  via: 'click' | 'keyboard' | 'outline' | 'hash';
}

export interface ViewerState {
  versionCode: string;
  compareFrom: string | null;
  overlayAmendmentId: string | null;
  outlineOpen: boolean;
  lineNumbers: boolean;
  density: 'comfortable' | 'compact';
  activeSectionId: string | null;
}

export interface BillViewerProps {
  document: BillDocument;
  compare?: { from: BillDocument; diff: VersionDiff } | null;
  overlay?: AmendmentDocument | null;
  annotations?: Annotation[];
  initialState?: Partial<ViewerState>;
  hash?: string | null;
  readOnly?: boolean;
  urlBuilder?: BillUrlBuilder;
  options?: { showHeader?: boolean; showRcwAffected?: boolean; collapsible?: boolean; theme?: 'light' | 'dark' | 'system' };
  /** Returns `'duplicate'` when the host already has a citation with the same target. */
  onCite?: (e: CiteEvent) => void | 'inserted' | 'duplicate';
  onSectionSelect?: (e: SectionSelectEvent) => void;
  onAnnotationActivate?: (a: Annotation) => void;
  onRequestVersion?: (code: string) => void;
  onRequestCompare?: (from: string, to: string) => void;
  onRequestOverlay?: (amendmentId: string | null) => void;
  onStateChange?: (s: ViewerState) => void;
  onNavigate?: (hash: string) => void;
  /** Host-owned pane collapse (the 48 px rail). */
  onCollapse?: () => void;
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function BillViewer(props: BillViewerProps) {
  const { document: doc, compare, overlay, annotations, urlBuilder, onCite, onSectionSelect, onRequestVersion, onRequestCompare, onNavigate, onCollapse } = props;
  const urls = urlBuilder ?? defaultUrlBuilder;
  const bill = { biennium: doc.bill.biennium, id: doc.bill.id };
  const rootRef = useRef<HTMLElement>(null);
  const readingRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const versionSelectRef = useRef<HTMLSelectElement>(null);
  const helpRef = useRef<HTMLDialogElement>(null);
  const [outlineOpen, setOutlineOpen] = useState<boolean>(() => props.initialState?.outlineOpen ?? readStored('bill.outlineOpen', true));
  const [lineNumbers, setLineNumbers] = useState<boolean>(() => props.initialState?.lineNumbers ?? readStored('bill.lineNumbers', false));
  const [density, setDensity] = useState<'comfortable' | 'compact'>(() => props.initialState?.density ?? readStored('bill.density', 'comfortable'));
  const [markPrefixes, setMarkPrefixes] = useState<boolean>(() => readStored('bill.markPrefixes', true));
  const [activeSectionId, setActiveSectionId] = useState<string | null>(props.initialState?.activeSectionId ?? doc.sections[0]?.id ?? null);
  const [status, setStatus] = useState('');
  const [selection, setSelection] = useState<{ sectionId: string; blockId: string | null; text: string; range: { start: number; end: number } | null; x: number; y: number } | null>(null);
  const hasLineMap = doc.provenance.hasLineNumbers === true;
  const suppressUntil = useRef(0);

  useEffect(() => writeStored('bill.outlineOpen', outlineOpen), [outlineOpen]);
  useEffect(() => writeStored('bill.lineNumbers', lineNumbers), [lineNumbers]);
  useEffect(() => writeStored('bill.density', density), [density]);
  useEffect(() => writeStored('bill.markPrefixes', markPrefixes), [markPrefixes]);
  useEffect(() => {
    props.onStateChange?.({ versionCode: doc.version.code, compareFrom: compare?.from.version.code ?? null, overlayAmendmentId: overlay?.id ?? null, outlineOpen, lineNumbers, density, activeSectionId });
  }, [outlineOpen, lineNumbers, density, activeSectionId, doc.version.code]);

  const sections = doc.sections;
  const sectionById = useMemo(() => new Map(sections.map((s) => [s.id, s])), [sections]);
  const activeSection = activeSectionId ? sectionById.get(activeSectionId) ?? null : null;
  const activeIndex = activeSectionId ? sections.findIndex((s) => s.id === activeSectionId) : -1;

  const versions = doc.versions ?? [{ code: doc.version.code, label: versionShortLabel(doc), seq: doc.version.seq }];
  const currentIdx = versions.findIndex((v) => v.code === doc.version.code);
  const previous = currentIdx > 0 ? versions[currentIdx - 1] : null;

  // ---- navigation helpers ----
  const scrollTo = useCallback(
    (id: string, via: SectionSelectEvent['via'], focus = true) => {
      const root = rootRef.current;
      if (!root) return false;
      const el = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
      if (!el) return false;
      root.querySelectorAll('.target').forEach((t) => t.classList.remove('target'));
      el.classList.add('target');
      suppressUntil.current = Date.now() + 400;
      el.scrollIntoView({ block: 'start' });
      if (focus) {
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
        el.focus({ preventScroll: true });
      }
      const sec = el.closest<HTMLElement>('[data-section]');
      if (sec) {
        setActiveSectionId(sec.id);
        const s = sectionById.get(sec.id);
        if (s && via !== 'hash') onSectionSelect?.({ sectionId: s.id, sectionNum: s.num, kind: s.kind, target: s.target, via });
      }
      onNavigate?.(id);
      return true;
    },
    [onNavigate, onSectionSelect, sectionById],
  );

  // Deep link on mount and on hash prop change.
  useEffect(() => {
    const h = props.hash?.replace(/^#/, '');
    if (h) {
      // Wait a frame for layout.
      const t = setTimeout(() => {
        if (!scrollTo(h, 'hash')) setStatus(`No element ${h} in this version.`);
      }, 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [props.hash, doc.version.code, compare?.diff, scrollTo]);

  // Track the section at the reading line: the last section heading at or above the sticky stack.
  useEffect(() => {
    const scroller = readingRef.current;
    if (!scroller || compare) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      if (Date.now() < suppressUntil.current) return;
      const heads = Array.from(scroller.querySelectorAll<HTMLElement>('[data-section]'));
      if (!heads.length) return;
      const top = scroller.getBoundingClientRect().top + 8;
      let current: HTMLElement = heads[0]!;
      for (const h of heads) {
        if (h.getBoundingClientRect().top <= top) current = h;
        else break;
      }
      setActiveSectionId((prev) => (prev === current.id ? prev : current.id));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [doc, compare]);

  // Selection → floating cite control.
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      const root = readingRef.current;
      if (!sel || sel.isCollapsed || !root || sel.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        setSelection(null);
        return;
      }
      const node = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
      const block = node?.closest<HTMLElement>('[data-block]') ?? null;
      const sec = node?.closest<HTMLElement>('[data-section]') ?? null;
      if (!sec) {
        setSelection(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        setSelection(null);
        return;
      }
      let charRange: { start: number; end: number } | null = null;
      if (block) {
        const textEl = block.querySelector<HTMLElement>(':scope > .text');
        if (textEl && textEl.contains(range.startContainer)) {
          const pre = document.createRange();
          pre.selectNodeContents(textEl);
          pre.setEnd(range.startContainer, range.startOffset);
          const start = plainLength(pre.cloneContents());
          charRange = { start, end: start + text.length };
        }
      }
      const rect = range.getBoundingClientRect();
      setSelection({ sectionId: sec.id, blockId: block?.id ?? null, text, range: charRange, x: rect.right, y: rect.bottom });
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  const emitCite = useCallback(
    (sectionId: string, blockId: string | null, range: { start: number; end: number } | null, text?: string) => {
      const s = sectionById.get(sectionId);
      if (!s) return;
      const t = text ?? (blockId ? plainOfBlock(s, blockId) : sectionPlainText(s));
      const ev = makeCiteEvent(doc, s, blockId, range, t, urls, overlay?.id);
      const result = onCite?.(ev);
      setStatus(result === 'duplicate' ? `Already cited ${ev.citation}.` : `Cited ${ev.citation}.`);
    },
    [doc, onCite, overlay?.id, sectionById, urls],
  );

  const copySection = useCallback(
    async (sectionId: string) => {
      const s = sectionById.get(sectionId);
      if (!s) return;
      const text = `${citationString(doc, s, null)}\n${sectionPlainText(s)}`;
      try {
        await navigator.clipboard.writeText(text);
        setStatus(`Copied ${citationString(doc, s, null)}.`);
      } catch {
        setStatus('Clipboard unavailable.');
      }
    },
    [doc, sectionById],
  );

  // ---- keyboard map ----
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const handler = (e: KeyboardEvent) => {
      const inside = root.contains(e.target as Node) || (e.target === document.body && root.dataset.lastActive === '1');
      if (!inside) return;
      const action = actionForKey(e);
      if (!action) return;
      const done = runAction(action);
      if (done) e.preventDefault();
    };
    const runAction = (action: ShortcutAction): boolean => {
      const idx = activeIndex < 0 ? 0 : activeIndex;
      switch (action) {
        case 'next-section': {
          const n = sections[Math.min(idx + 1, sections.length - 1)];
          if (n && n.id !== activeSectionId) scrollTo(n.id, 'keyboard');
          else setStatus('Already at the last section.');
          return true;
        }
        case 'prev-section': {
          const p = sections[Math.max(idx - 1, 0)];
          if (p && p.id !== activeSectionId) scrollTo(p.id, 'keyboard');
          else setStatus('Already at the first section.');
          return true;
        }
        case 'next-block':
        case 'prev-block': {
          const s = activeSection;
          if (!s || s.blocks.length === 0) return true;
          const focused = document.activeElement?.closest<HTMLElement>('[data-block]');
          const top = s.blocks.map((b) => b.id);
          const cur = focused ? top.indexOf(focused.id) : -1;
          const next = action === 'next-block' ? Math.min(cur + 1, top.length - 1) : Math.max(cur - 1, 0);
          const id = top[next];
          if (id) scrollTo(id, 'keyboard');
          return true;
        }
        case 'section-top':
          if (activeSectionId) scrollTo(activeSectionId, 'keyboard');
          return true;
        case 'top':
          if (sections[0]) scrollTo(sections[0].id, 'keyboard');
          readingRef.current?.closest('.viewer-scroll')?.scrollTo({ top: 0 });
          return true;
        case 'bottom':
          if (sections.length) scrollTo(sections[sections.length - 1]!.id, 'keyboard');
          return true;
        case 'toggle-outline':
          setOutlineOpen((o) => !o);
          setStatus(outlineOpen ? 'Outline hidden.' : 'Outline shown.');
          return true;
        case 'version-switcher':
          versionSelectRef.current?.focus();
          return true;
        case 'compare':
          if (previous) onRequestCompare?.(previous.code, doc.version.code);
          else setStatus('This is the first version; nothing to compare with.');
          return true;
        case 'toggle-overlay':
          setStatus('Amendment overlay is built but switched off in this build.');
          return true;
        case 'find':
          if (!outlineOpen) setOutlineOpen(true);
          setTimeout(() => findRef.current?.focus(), 0);
          return true;
        case 'cite':
          if (selection) emitCite(selection.sectionId, selection.blockId, selection.range, selection.text);
          else if (activeSectionId) emitCite(activeSectionId, null, null);
          return true;
        case 'copy':
          if (activeSectionId) void copySection(activeSectionId);
          return true;
        case 'toggle-lines':
          if (hasLineMap) setLineNumbers((l) => !l);
          else setStatus('No line map for this version; line numbers are off.');
          return true;
        case 'help':
          helpRef.current?.showModal();
          return true;
        case 'escape':
          if (helpRef.current?.open) helpRef.current.close();
          else if (compare) props.onRequestCompare?.('', '');
          else setSelection(null);
          return true;
      }
    };
    document.addEventListener('keydown', handler);
    const mark = () => {
      root.dataset.lastActive = '1';
    };
    root.addEventListener('focusin', mark);
    root.addEventListener('pointerdown', mark);
    return () => {
      document.removeEventListener('keydown', handler);
      root.removeEventListener('focusin', mark);
      root.removeEventListener('pointerdown', mark);
    };
  }, [activeIndex, activeSection, activeSectionId, compare, copySection, doc.version.code, emitCite, hasLineMap, onRequestCompare, outlineOpen, previous, props, scrollTo, sections, selection]);

  const changedIds = compare ? compare.diff.sections.filter((s) => s.status !== 'equal' && s.toSectionId).map((s) => s.toSectionId as string) : undefined;
  const annotationCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const a of annotations ?? []) out[a.sectionId] = (out[a.sectionId] ?? 0) + 1;
    return out;
  }, [annotations]);

  const prevSection = activeIndex > 0 ? sections[activeIndex - 1] : null;
  const nextSection = activeIndex >= 0 && activeIndex < sections.length - 1 ? sections[activeIndex + 1] : null;

  return (
    <section className={`bill-viewer density-${density}${outlineOpen ? ' outline-open' : ''}`} aria-label="Bill text" ref={rootRef}>
      <div className="viewer-sticky">
        <div className="toolbar" role="toolbar" aria-label="Bill viewer controls">
          {props.options?.collapsible !== false && onCollapse && (
            <button type="button" className="icon" onClick={onCollapse} aria-label="Collapse the bill pane" title="Collapse the bill pane">
              ◧
            </button>
          )}
          <button type="button" className="icon" onClick={() => setOutlineOpen((o) => !o)} aria-pressed={outlineOpen} aria-label="Toggle outline" title="Toggle outline (o)">
            ☰
          </button>
          <span className="bill-id">
            <strong>{doc.bill.id.replace(/^([A-Z]+)(\d+)$/, '$1 $2')}</strong>
          </span>
          <label className="version-switch">
            <span className="visually-hidden">Version</span>
            <select
              ref={versionSelectRef}
              value={doc.version.code}
              onChange={(e) => onRequestVersion?.(e.target.value)}
              aria-label="Version"
              title="Version (v)"
            >
              {versions.map((v) => (
                <option key={v.code} value={v.code}>
                  {v.label}
                  {v.code === versions[versions.length - 1]?.code ? ' (newest)' : ''}
                </option>
              ))}
            </select>
          </label>
          {versions.length > 1 && (
            <details className="compare-menu">
              <summary>Compare with…</summary>
              <div className="menu-body">
                {previous && (
                  <a href={urls.compare(bill, previous.code, doc.version.code, activeSectionId ?? undefined)} onClick={(e) => { e.preventDefault(); onRequestCompare?.(previous.code, doc.version.code); }}>
                    What changed since {previous.label}
                  </a>
                )}
                <label>
                  <span>Other version </span>
                  <select
                    aria-label="Compare with version"
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) onRequestCompare?.(e.target.value, doc.version.code);
                    }}
                  >
                    <option value="">Choose…</option>
                    {versions
                      .filter((v) => v.code !== doc.version.code)
                      .map((v) => (
                        <option key={v.code} value={v.code}>
                          {v.label}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            </details>
          )}
          <span className="spacer" />
          <button type="button" className="icon" aria-pressed={lineNumbers} disabled={!hasLineMap} title={hasLineMap ? 'Line numbers (l)' : 'Line numbers: no line map for this version'} aria-label="Toggle line numbers" onClick={() => setLineNumbers((l) => !l)}>
            #
          </button>
          <button type="button" className="icon" aria-pressed={density === 'compact'} title="Compact density" aria-label="Toggle compact density" onClick={() => setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact'))}>
            ≡
          </button>
          <button type="button" className="icon" aria-pressed={!markPrefixes} title="Silence spoken mark prefixes (struck/inserted)" aria-label="Silence spoken mark prefixes" onClick={() => setMarkPrefixes((m) => !m)}>
            🔈
          </button>
          <button type="button" className="icon" onClick={() => helpRef.current?.showModal()} aria-label="Keyboard help" title="Keyboard help (?)">
            ?
          </button>
        </div>
        <nav className="section-bar" aria-label="Section">
          <button type="button" className="linkish" disabled={!prevSection} onClick={() => prevSection && scrollTo(prevSection.id, 'keyboard')} aria-label={prevSection ? `Previous: Sec. ${prevSection.num}` : 'No previous section'}>
            ← {prevSection ? `Sec. ${prevSection.num}` : ''}
          </button>
          <span className="current" aria-live="polite">
            {activeSection ? (
              <>
                <a href={`#${activeSection.id}`} onClick={(e) => { e.preventDefault(); scrollTo(activeSection.id, 'keyboard'); }}>
                  Sec. {activeSection.num}
                </a>
                {activeSection.isNewSection && <span className="badge"> NEW SECTION</span>}
                {sectionSubjectLabel(activeSection) && <span className="section-subject"> · {sectionSubjectLabel(activeSection)}</span>}
                {activeSection.target && <span className="muted"> · {sectionGloss(activeSection)}</span>}
              </>
            ) : (
              <span className="muted">{compare ? 'Comparison' : 'Bill'}</span>
            )}
          </span>
          <button type="button" className="linkish" disabled={!nextSection} onClick={() => nextSection && scrollTo(nextSection.id, 'keyboard')} aria-label={nextSection ? `Next: Sec. ${nextSection.num}` : 'No next section'}>
            {nextSection ? `Sec. ${nextSection.num}` : ''} →
          </button>
          {!props.readOnly && (
            <button type="button" className="cite-btn" disabled={!activeSectionId || !!compare} onClick={() => activeSectionId && emitCite(activeSectionId, null, null)} title="Cite this section in the note (.)">
              Cite
            </button>
          )}
          <button type="button" className="secondary small" disabled={!activeSectionId} onClick={() => activeSectionId && void copySection(activeSectionId)} title="Copy citation and text (c)">
            Copy
          </button>
        </nav>
      </div>
      <div className="viewer-body">
        {outlineOpen && (
          <BillOutline
            document={doc}
            activeSectionId={activeSectionId}
            changedSectionIds={changedIds}
            annotationCounts={annotationCounts}
            showRcwAffected={props.options?.showRcwAffected !== false}
            urls={urls}
            findInputRef={findRef}
            onSelect={(id, via) => scrollTo(id, via === 'click' ? 'outline' : 'keyboard')}
          />
        )}
        <div className="viewer-scroll" ref={readingRef}>
          {compare ? (
            <VersionCompare from={compare.from} to={doc} diff={compare.diff} focusSectionId={props.hash?.replace(/^#/, '') ?? null} urls={urls} onClose={() => props.onRequestCompare?.('', '')} onActiveSection={(id) => setActiveSectionId(id)} />
          ) : (
            <ReadingColumn
              document={doc}
              urls={urls}
              annotations={annotations}
              showLineNumbers={lineNumbers && hasLineMap}
              markPrefixes={markPrefixes}
              onSectionActivate={(id) => scrollTo(id, 'click')}
              onAnnotationActivate={props.onAnnotationActivate}
            />
          )}
        </div>
      </div>
      {selection && !props.readOnly && !compare && (
        <div className="cite-float" role="group" aria-label="Selection actions" style={{ left: Math.max(8, Math.min(selection.x, window.innerWidth - 180)), top: selection.y + 6 }}>
          <button type="button" onClick={() => emitCite(selection.sectionId, selection.blockId, selection.range, selection.text)}>
            Cite
          </button>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              const s = sectionById.get(selection.sectionId);
              if (!s) return;
              try {
                await navigator.clipboard.writeText(`${citationString(doc, s, selection.blockId)}\n${selection.text}`);
                setStatus('Copied selection with citation.');
              } catch {
                setStatus('Clipboard unavailable.');
              }
            }}
          >
            Copy
          </button>
        </div>
      )}
      <p className="visually-hidden" role="status" aria-live="polite">
        {status}
      </p>
      <dialog ref={helpRef} className="help" aria-labelledby="help-h">
        <h2 id="help-h">Keyboard shortcuts</h2>
        <table>
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.action}>
                <th scope="row">
                  {s.keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </th>
                <td>{s.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Keys do nothing while focus is in a text field or the note editor.</p>
        <form method="dialog">
          <button type="submit">Close</button>
        </form>
      </dialog>
    </section>
  );
}

function plainLength(fragment: DocumentFragment): number {
  // Visually hidden mark prefixes are excluded so offsets index the block's plain text.
  fragment.querySelectorAll('.visually-hidden').forEach((n) => n.remove());
  return (fragment.textContent ?? '').length;
}

function plainOfBlock(s: BillSection, blockId: string): string {
  const b = findBlock(s, blockId);
  if (!b) return '';
  const parts: string[] = [];
  if (b.label) parts.push(b.label);
  parts.push(b.runs.map((r) => r.text).join(''));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
