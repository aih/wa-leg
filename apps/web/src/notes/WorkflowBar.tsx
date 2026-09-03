import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { EventType } from '@wa-leg/workflow-machine';
import { ApiError } from '../lib/api';
import { EVENT_LABELS, EXPORT_FORMATS, exportUrl, fmtWhen, STATE_HINTS, STATE_LABELS, useResource, workflowApi, type NoteSummary } from './api';

/** Events that open a message dialog before they are sent. */
const DIALOG_EVENTS: Record<string, { required: boolean }> = {
  SUBMIT: { required: false },
  REQUEST_CHANGES: { required: true },
};

export interface WorkflowBarProps {
  revisionId: string;
  summary: NoteSummary;
  /** Called after a transition so the workspace reloads the summary. */
  onChanged: () => Promise<void> | void;
  /** Open comment threads on the text; shown in the change request banner. */
  openThreads?: number;
  onShowComments?: () => void;
}

/**
 * Bill link and title, status with its hint, drafter, reviewer, the actions the caller may take, the export menu
 * and the transition history. The change request banner shows while the status is Changes requested.
 */
export function WorkflowBar({ revisionId, summary, onChanged, openThreads = 0, onShowComments }: WorkflowBarProps) {
  const wf = useResource(() => workflowApi.view(revisionId), [revisionId, summary.state, summary.headVersion]);
  const [dialog, setDialog] = useState<{ event: EventType; label: string } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const view = wf.data;
  const state = view?.state ?? summary.state;
  const drafter = view?.drafter ?? summary.drafter;
  const reviewer = view?.reviewer ?? summary.reviewer;
  const changeRequest = state === 'changes_requested' ? view?.changeRequest ?? null : null;

  const run = async (event: EventType, text?: string) => {
    setBusy(true);
    setError(null);
    try {
      await workflowApi.send(revisionId, { event, message: text || undefined, expectedVersion: view?.version });
      setDialog(null);
      setMessage('');
      await wf.reload();
      await onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const d = (err.body as { details?: { state?: string } } | undefined)?.details;
        setError(err.code === 'version_mismatch' && d?.state ? `${err.message} (now ${STATE_LABELS[d.state] ?? d.state})` : err.message);
        await wf.reload();
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const press = (ev: { type: EventType; label: string }) => {
    if (DIALOG_EVENTS[ev.type]) {
      setError(null);
      setDialog({ event: ev.type, label: ev.label });
    } else void run(ev.type);
  };

  const submitDialog = (e: FormEvent) => {
    e.preventDefault();
    if (!dialog) return;
    if (DIALOG_EVENTS[dialog.event]?.required && !message.trim()) {
      setError('A message is required');
      return;
    }
    void run(dialog.event, message.trim());
  };

  const closeDialog = () => {
    setDialog(null);
    setMessage('');
    setError(null);
  };

  const replying = dialog?.event === 'SUBMIT' && state === 'changes_requested';
  const required = !!dialog && !!DIALOG_EVENTS[dialog.event]?.required;

  return (
    <>
      <header className="workflow-bar" aria-label="Workflow">
        <div className="wf-row">
          <h1>
            <Link to={`/bills/${summary.biennium}/${summary.billId}/${summary.versionCode}`}>{summary.versionLabel}</Link> fiscal note
            {summary.billTitle && <span className="muted"> · {summary.billTitle}</span>}
          </h1>
          <dl className="wf-facts">
            <dt>Status</dt>
            <dd>
              <span className={`status status-${state}`}>{STATE_LABELS[state] ?? state}</span>
              {STATE_HINTS[state] && <span className="muted small state-hint"> {STATE_HINTS[state]}</span>}
            </dd>
            <dt>Drafter</dt>
            <dd>{drafter?.displayName ?? drafter?.userId ?? 'none'}</dd>
            <dt>Reviewer</dt>
            <dd>{reviewer?.displayName ?? reviewer?.userId ?? 'not yet'}</dd>
          </dl>
        </div>
        <div className="wf-row wf-actions" role="group" aria-label="Workflow actions">
          {(view?.availableEvents ?? []).map((ev) => (
            <button key={ev.type} type="button" onClick={() => press(ev)} disabled={busy || !!dialog}>
              {ev.label}
            </button>
          ))}
          <details className="export-menu">
            <summary>Export</summary>
            <div className="menu-body" role="group" aria-label="Export formats">
              {EXPORT_FORMATS.map((f) => (
                <a key={f.format} href={exportUrl(revisionId, f.format)} target={f.format === 'pdf' || f.format === 'html' ? '_blank' : undefined} rel={f.format === 'pdf' || f.format === 'html' ? 'noreferrer' : undefined}>
                  {f.label}
                </a>
              ))}
            </div>
          </details>
          <button type="button" className="secondary" aria-expanded={showHistory} onClick={() => setShowHistory((s) => !s)}>
            History
          </button>
          {error && !dialog && (
            <span role="alert" className="error">
              {error}
            </span>
          )}
        </div>
        {changeRequest && (
          <div role="status" className="banner changes">
            <p>
              <strong>{changeRequest.by.displayName ?? changeRequest.by.userId} requested changes</strong> on {fmtWhen(changeRequest.at)}: {changeRequest.message}
            </p>
            <button type="button" className="linkish" onClick={onShowComments}>
              {openThreads} open comment thread{openThreads === 1 ? '' : 's'}
            </button>
          </div>
        )}
        {showHistory && <HistoryPanel revisionId={revisionId} version={view?.version ?? 0} />}
      </header>
      {dialog && (
        <div role="dialog" aria-labelledby="wf-dialog-h" className="wf-dialog">
          <form onSubmit={submitDialog} aria-label={dialog.label}>
            <h2 id="wf-dialog-h">{dialog.label}</h2>
            <label htmlFor="wf-message">
              {replying ? 'Reply to the change request' : 'Message'}
              {required ? ' (required)' : ' (optional)'}
            </label>
            <textarea id="wf-message" rows={required ? 5 : 3} value={message} onChange={(e) => setMessage(e.target.value)} autoFocus />
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="row">
              <button type="submit" disabled={busy}>
                {dialog.label}
              </button>
              <button type="button" className="secondary" onClick={closeDialog}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function HistoryPanel({ revisionId, version }: { revisionId: string; version: number }) {
  const log = useResource(() => workflowApi.transitions(revisionId), [revisionId, version]);
  return (
    <section className="history-panel" aria-labelledby="history-h">
      <h2 id="history-h">History</h2>
      {log.error && <p role="alert">{log.error.message}</p>}
      <ol className="transitions" tabIndex={0} aria-label="Transitions, scrolls">
        {(log.data ?? []).map((t) => (
          <li key={t.seq}>
            <strong>{EVENT_LABELS[t.event] ?? t.event}</strong> · {STATE_LABELS[t.fromState] ?? t.fromState} → {STATE_LABELS[t.toState] ?? t.toState} · {t.actorName ?? t.actorId} · {fmtWhen(t.occurredAt)}
            {t.comment && <blockquote>{t.comment}</blockquote>}
          </li>
        ))}
        {log.data && log.data.length === 0 && <li className="muted">No transitions yet.</li>}
      </ol>
    </section>
  );
}

