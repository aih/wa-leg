import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { BillSummary } from '../bill/api';
import { useSession } from '../lib/session';
import { ApiError } from '../lib/api';
import { listUsers } from '../lib/listApi';
import { notesApi, useResource } from './api';

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

/** Start a fiscal note on a bill version: version, template, and (for reviewers) the drafter. A drafter creates for themselves. */
export function NewNoteForm({ bill, currentCode }: { bill: BillSummary; currentCode: string }) {
  const { hasRole } = useSession();
  const navigate = useNavigate();
  const isReviewer = hasRole('reviewer');
  const isDrafter = hasRole('drafter');
  const [versionCode, setVersionCode] = useState(currentCode);
  const [templateId, setTemplateId] = useState('');
  const [drafterId, setDrafterId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templates = useResource(() => notesApi.templates({ kind: 'document' }), []);
  const drafters = useResource(isReviewer ? () => listUsers('drafter') : null, [isReviewer]);

  useEffect(() => {
    if (!templateId && templates.data?.length) setTemplateId(templates.data[0]!.id);
  }, [templates.data, templateId]);

  if (!isReviewer && !isDrafter) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await notesApi.create({
        billKey: bill.billKey,
        versionCode,
        templateId,
        drafterId: isReviewer && drafterId ? drafterId : undefined,
      });
      navigate(`/notes/${created.noteRevisionId}`);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="new-note">
      <summary>New fiscal note</summary>
      <form onSubmit={(e) => void submit(e)} className="stack" aria-label="New fiscal note">
        <Field id="nn-version" label="Bill version">
          <select id="nn-version" value={versionCode} onChange={(e) => setVersionCode(e.target.value)}>
            {bill.versions.map((v) => (
              <option key={v.code} value={v.code}>
                {v.shortLabel}
                {v.status !== 'parsed' ? ` (${v.status})` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field id="nn-template" label="Template">
          <select id="nn-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
            {(templates.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        {isReviewer && (
          <Field id="nn-drafter" label="Drafter">
            <select id="nn-drafter" value={drafterId} onChange={(e) => setDrafterId(e.target.value)} required={!isDrafter}>
              <option value="">{isDrafter ? 'Myself' : 'Choose a drafter'}</option>
              {(drafters.data ?? []).map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.displayName}
                </option>
              ))}
            </select>
          </Field>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !templateId}>
          Create and open
        </button>
      </form>
    </details>
  );
}
