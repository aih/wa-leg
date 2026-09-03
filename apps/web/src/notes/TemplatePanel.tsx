import { useEffect, useMemo, useState } from 'react';
import { loadTemplate, type PMNode, type TemplateContext } from '@wa-leg/note-schema';
import { notesApi, useResource, type EditorMode, type TemplateSummary } from './api';

const RECENT_KEY = 'templates.recent';

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}
function pushRecent(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, 6)));
  } catch {
    /* storage unavailable */
  }
}

export interface TemplatePanelProps {
  mode: EditorMode;
  noteRevisionId: string;
  /** Tags already recorded for the bill, e.g. ["tax:sales-use"]; preselects the tax chip. */
  defaultTags?: string[];
  documentIsEmpty: boolean;
  onApply: (doc: PMNode, how: 'document' | 'snippet', template: TemplateSummary) => void;
  onClose: () => void;
}

/** Template library beside the editor: search, tag chips, preview, apply as document or insert at the cursor. */
export function TemplatePanel({ mode, noteRevisionId, defaultTags = [], documentIsEmpty, onApply, onClose }: TemplatePanelProps) {
  const [q, setQ] = useState('');
  const [tax, setTax] = useState<string | null>(defaultTags.find((t) => t.startsWith('tax:'))?.slice(4) ?? null);
  const [impact, setImpact] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>('');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [part, setPart] = useState<string>('');
  const templates = useResource(() => notesApi.templates({ mode }), [mode]);
  const context = useResource(() => notesApi.context(noteRevisionId), [noteRevisionId]);

  const list = useMemo(() => {
    const recent = readRecent();
    const all = (templates.data ?? []).filter((t) => {
      if (tax && !t.tags.includes(`tax:${tax}`)) return false;
      if (impact && !t.tags.includes(`impact:${impact}`)) return false;
      if (q) {
        const needle = q.toLowerCase();
        return t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle) || t.tags.some((g) => g.toLowerCase().includes(needle));
      }
      return true;
    });
    return all.sort((a, b) => {
      const ra = recent.indexOf(a.id);
      const rb = recent.indexOf(b.id);
      if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
      return a.name.localeCompare(b.name);
    });
  }, [templates.data, q, tax, impact]);

  const tagValues = (prefix: string) => Array.from(new Set((templates.data ?? []).flatMap((t) => t.tags.filter((g) => g.startsWith(prefix)).map((g) => g.slice(prefix.length))))).sort();
  const current = list.find((t) => t.id === selected) ?? (templates.data ?? []).find((t) => t.id === selected) ?? null;

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    notesApi
      .templatePreview(selected, noteRevisionId)
      .then((html) => {
        if (!cancelled) setPreview(html);
      })
      .catch(() => setPreview('<p>Preview unavailable.</p>'));
    return () => {
      cancelled = true;
    };
  }, [selected, noteRevisionId]);

  const build = async (t: TemplateSummary): Promise<PMNode> => {
    const full = await notesApi.template(t.id);
    const ctx = (context.data ?? (await notesApi.context(noteRevisionId))) as TemplateContext;
    return loadTemplate(full.html, ctx, { mode }).doc;
  };

  const apply = async (how: 'document' | 'snippet') => {
    if (!current) return;
    if (how === 'document' && !documentIsEmpty && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const doc = await build(current);
      let payload = doc;
      if (how === 'snippet' && current.kind === 'document') {
        const sections = (doc.content ?? []).filter((n) => n.type === 'noteSection');
        const chosen = sections.find((s) => String(s.attrs?.part) === part) ?? sections[0];
        if (!chosen) throw new Error('This template has no sections to insert');
        payload = { type: 'doc', content: [chosen] };
      }
      pushRecent(current.id);
      onApply(payload, how, current);
      setConfirmReplace(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="template-panel" aria-labelledby="tpl-h">
      <div className="panel-head">
        <h2 id="tpl-h">Templates</h2>
        <button type="button" className="linkish" onClick={onClose}>
          Close
        </button>
      </div>
      <label className="visually-hidden" htmlFor="tpl-q">
        Search templates
      </label>
      <input id="tpl-q" type="search" placeholder="Search name, description, tag" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips" role="group" aria-label="Tax type">
        {tagValues('tax:').map((v) => (
          <button key={v} type="button" className="chip" aria-pressed={tax === v} onClick={() => setTax(tax === v ? null : v)}>
            {v}
          </button>
        ))}
      </div>
      <div className="chips" role="group" aria-label="Impact type">
        {tagValues('impact:').map((v) => (
          <button key={v} type="button" className="chip" aria-pressed={impact === v} onClick={() => setImpact(impact === v ? null : v)}>
            {v}
          </button>
        ))}
      </div>
      {templates.error && <p role="alert">{templates.error.message}</p>}
      <ul className="tpl-list" aria-label="Templates">
        {list.map((t) => (
          <li key={t.id}>
            <button type="button" className="tpl-item" aria-pressed={selected === t.id} onClick={() => setSelected(t.id)}>
              <span className="tpl-name">{t.name}</span>
              <span className="tpl-kind muted">{t.kind}</span>
              <span className="tpl-desc muted">{t.description}</span>
            </button>
          </li>
        ))}
        {list.length === 0 && !templates.loading && <li className="muted">No templates match.</li>}
      </ul>
      {current && (
        <div className="tpl-preview">
          <h3>{current.name}</h3>
          <p className="muted small">
            {current.slots.filter((s) => s.required).length} required slots · parts {current.parts.join(', ') || 'n/a'}
          </p>
          <iframe title={`Preview of ${current.name}`} sandbox="" srcDoc={preview} className="tpl-frame" />
          {error && <p role="alert">{error}</p>}
          <div className="row">
            {current.kind === 'document' && (
              <>
                <button type="button" onClick={() => void apply('document')} disabled={busy}>
                  {confirmReplace ? 'Replace current document' : 'Apply as document'}
                </button>
                {confirmReplace && (
                  <button type="button" className="secondary" onClick={() => setConfirmReplace(false)}>
                    Keep current
                  </button>
                )}
              </>
            )}
            {current.kind === 'document' && current.parts.length > 0 && (
              <label className="inline">
                Section
                <select value={part} onChange={(e) => setPart(e.target.value)}>
                  {current.parts.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" className="secondary" onClick={() => void apply('snippet')} disabled={busy}>
              Insert at cursor
            </button>
          </div>
          {confirmReplace && (
            <p role="status" className="warn">
              The note already has content. Replacing it keeps the previous text in the version history.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
