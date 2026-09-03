import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { BillSummary } from '../bill/api';
import { useSession } from '../lib/session';
import { ApiError } from '../lib/api';
import { notesApi, useResource } from './api';

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

/** Start a fiscal note (reviewer, manager, admin) or an estimate (drafter, for themselves) on a bill version. */
export function NewNoteForm({ bill, currentCode }: { bill: BillSummary; currentCode: string }) {
  const { principal, hasRole } = useSession();
  const navigate = useNavigate();
  const canCreateNote = hasRole('reviewer', 'manager', 'admin');
  const canCreateEstimate = hasRole('drafter');
  const [kind, setKind] = useState<'note' | 'estimate'>(canCreateNote ? 'note' : 'estimate');
  const [versionCode, setVersionCode] = useState(currentCode);
  const [templateId, setTemplateId] = useState('');
  const [drafterId, setDrafterId] = useState(principal?.userId ?? '');
  const [requestId, setRequestId] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high' | 'urgent'>('normal');
  const [confidential, setConfidential] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templates = useResource(() => notesApi.templates({ mode: kind === 'estimate' ? undefined : 'limited' }), [kind]);
  const drafters = useResource(canCreateNote ? () => notesApi.users('drafter') : null, [canCreateNote]);

  if (!canCreateNote && !canCreateEstimate) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await notesApi.create({
        billKey: bill.billKey,
        versionCode,
        kind,
        templateId: templateId || undefined,
        drafterId: kind === 'note' ? drafterId || undefined : undefined,
        priority,
        confidential,
        request: kind === 'note' ? { requestId: requestId || undefined, legContact: contactName || contactPhone ? { name: contactName, phone: contactPhone } : undefined } : undefined,
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
      <summary>New {kind === 'note' ? 'fiscal note' : 'estimate'}</summary>
      <form onSubmit={(e) => void submit(e)} className="stack" aria-label="New note">
        {canCreateNote && canCreateEstimate && (
          <fieldset>
            <legend>Kind</legend>
            <label className="inline">
              <input type="radio" name="kind" checked={kind === 'note'} onChange={() => setKind('note')} /> Fiscal note
            </label>
            <label className="inline">
              <input type="radio" name="kind" checked={kind === 'estimate'} onChange={() => setKind('estimate')} /> Estimate
            </label>
          </fieldset>
        )}
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
          <select id="nn-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">Blank</option>
            {(templates.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        {kind === 'note' && (
          <>
            <Field id="nn-drafter" label="Drafter">
              <select id="nn-drafter" value={drafterId} onChange={(e) => setDrafterId(e.target.value)} required>
                <option value="">Choose a drafter</option>
                {(drafters.data ?? []).map((u) => (
                  <option key={u.userId} value={u.userId}>
                    {u.displayName} ({u.divisions.join(', ') || 'no division'})
                  </option>
                ))}
              </select>
            </Field>
            <Field id="nn-request" label="Request id">
              <input id="nn-request" value={requestId} onChange={(e) => setRequestId(e.target.value)} placeholder="e.g. 2402-1-1" />
            </Field>
            <div className="row">
              <Field id="nn-contact" label="Legislative contact">
                <input id="nn-contact" value={contactName} onChange={(e) => setContactName(e.target.value)} />
              </Field>
              <Field id="nn-phone" label="Phone">
                <input id="nn-phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
              </Field>
            </div>
          </>
        )}
        <div className="row">
          <Field id="nn-priority" label="Priority">
            <select id="nn-priority" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </Field>
          <label className="inline">
            <input type="checkbox" checked={confidential} onChange={(e) => setConfidential(e.target.checked)} /> Confidential
          </label>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          Create and open
        </button>
      </form>
    </details>
  );
}
