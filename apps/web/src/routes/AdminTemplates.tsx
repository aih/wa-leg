import { useEffect, useState } from 'react';
import { RequireRole } from '../components/RequireRole';
import { useSession } from '../lib/session';
import { ApiError } from '../lib/api';
import { notesApi, useResource, type TemplateFull } from '../notes/api';
import '../notes/notes.css';

/** Template library administration: list, preview, and (template_editor) edit as a new version. */
export function AdminTemplates() {
  const { hasRole } = useSession();
  const canEdit = hasRole('template_editor', 'admin');
  const list = useResource(() => notesApi.templates(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [full, setFull] = useState<TemplateFull | null>(null);
  const [preview, setPreview] = useState('');
  const [description, setDescription] = useState('');
  const [html, setHtml] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setEditing(false);
    setMessage(null);
    Promise.all([notesApi.template(selected), notesApi.templatePreview(selected)])
      .then(([t, p]) => {
        if (cancelled) return;
        setFull(t);
        setDescription(t.description);
        setHtml(t.html);
        setPreview(p);
      })
      .catch((err) => setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const save = async () => {
    if (!full) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await (await import('../lib/api')).api<TemplateFull>(`/templates/${full.id}`, { method: 'PUT', body: { description, html } });
      setFull(updated);
      setMessage(`Saved as version ${updated.version}`);
      setEditing(false);
      setPreview(await notesApi.templatePreview(full.id));
      await list.reload();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <RequireRole roles={['template_editor', 'admin']}>
      <h1>Templates</h1>
      {list.error && <p role="alert">{list.error.message}</p>}
      <div className="versions-layout">
        <section aria-labelledby="tpl-list-h">
          <h2 id="tpl-list-h">Library</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">Template</th>
                <th scope="col">Kind</th>
                <th scope="col">Version</th>
                <th scope="col">Tags</th>
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((t) => (
                <tr key={t.id} className={t.id === selected ? 'selected' : undefined}>
                  <td>
                    <button type="button" className="linkish" aria-pressed={t.id === selected} onClick={() => setSelected(t.id)}>
                      {t.name}
                    </button>
                    <div className="muted small">{t.description}</div>
                  </td>
                  <td>{t.kind}</td>
                  <td>{t.version}</td>
                  <td className="small">{t.tags.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section aria-labelledby="tpl-detail-h" aria-busy={busy}>
          <h2 id="tpl-detail-h">{full ? full.name : 'Detail'}</h2>
          {!full && <p className="muted">Choose a template to preview it.</p>}
          {full && (
            <>
              <p className="muted small">
                {full.kind} · {full.mode} mode · version {full.version} · {full.slots.filter((s) => s.required).length} required slots · tokens: {full.tokens.slice(0, 8).join(', ')}
                {full.tokens.length > 8 ? '…' : ''}
              </p>
              {canEdit && !editing && (
                <button type="button" className="secondary" onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
              {editing ? (
                <form
                  className="stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                  }}
                  aria-label="Edit template"
                >
                  <div className="field">
                    <label htmlFor="tpl-desc">Description</label>
                    <input id="tpl-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="tpl-html">HTML</label>
                    <textarea id="tpl-html" rows={18} value={html} onChange={(e) => setHtml(e.target.value)} spellCheck={false} />
                  </div>
                  <div className="row">
                    <button type="submit" disabled={busy}>
                      Save as new version
                    </button>
                    <button type="button" className="secondary" onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <iframe title={`Preview of ${full.name}`} sandbox="" srcDoc={preview} className="tpl-frame tpl-frame-large" />
              )}
              {message && (
                <p role="status" className="ok">
                  {message}
                </p>
              )}
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </RequireRole>
  );
}
