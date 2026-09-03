import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useSession } from '../lib/session';
import { ApiError } from '../lib/api';
import type { BillSummary } from '../bill/api';
import { BAND_LABELS, dueCountdown, fmtWhen, notesApi, STATE_HINTS, STATE_LABELS, useResource, workflowApi, type NoteSummary, type WorkflowView } from './api';

const COMMENT_REQUIRED = new Set(['REQUEST_CHANGES', 'EXEC_RETURN', 'CANCEL']);
const COMMENT_OPTIONAL = new Set(['SUBMIT_FOR_REVIEW', 'APPROVE', 'EXEC_DONE']);

export interface WorkflowBarProps {
  revisionId: string;
  summary: NoteSummary;
  bill: BillSummary | null;
  /** Called after any transition or assignment so the workspace reloads the summary and lock state. */
  onChanged: () => Promise<void> | void;
  /** Open comment threads that a Request changes will attach as items. */
  openThreads?: number;
  /** Items of the open change request still to address; Submit for review is blocked while > 0. */
  openChangeItems?: number;
  onShowChanges?: () => void;
}

/** State, due countdown, assignees, the transition buttons the caller may press, and assigner controls. */
export function WorkflowBar({ revisionId, summary, bill, onChanged, openThreads = 0, openChangeItems = 0, onShowChanges }: WorkflowBarProps) {
  const { principal, hasRole } = useSession();
  const navigate = useNavigate();
  const wf = useResource(() => workflowApi.view(revisionId), [revisionId, summary.state, summary.headVersion]);
  const [dialog, setDialog] = useState<{ event: string; label: string } | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAssign, setShowAssign] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const h = window.setInterval(() => tick((t) => t + 1), 60_000);
    return () => window.clearInterval(h);
  }, []);

  const view = wf.data;
  const isAssigner = hasRole('reviewer', 'approver', 'manager', 'admin');
  const state = view?.state ?? summary.state;
  const stateLabel = STATE_LABELS[state] ?? state;
  const due = view?.effectiveDueAt ?? summary.effectiveDueAt ?? null;
  const band = view?.deadlines.map((d) => d.band).sort((a, b) => rank(a) - rank(b))[0] ?? 'none';
  const newerVersion = bill && !summary.supersededBy && !['approved', 'cancelled', 'superseded'].includes(state) && bill.currentVersionCode && bill.currentVersionCode !== summary.versionCode ? bill.versions.find((v) => v.code === bill.currentVersionCode) : null;

  const run = async (event: string, text?: string) => {
    setBusy(true);
    setError(null);
    try {
      await workflowApi.send(revisionId, { event, comment: text || undefined, expectedVersion: view?.version });
      setDialog(null);
      setComment('');
      await wf.reload();
      await onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const d = (err.body as { details?: { state?: string; allowed?: string[] } } | undefined)?.details;
        setError(`${err.message}${d?.state ? ` (now ${STATE_LABELS[d.state] ?? d.state})` : ''}`);
        await wf.reload();
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const press = (ev: { type: string; label: string }) => {
    if (ev.type === 'SUBMIT_FOR_REVIEW' && openChangeItems > 0) {
      setError(`${openChangeItems} change request item${openChangeItems === 1 ? ' is' : 's are'} still open. Address each one in the Changes tab before resubmitting.`);
      onShowChanges?.();
      return;
    }
    if (COMMENT_REQUIRED.has(ev.type) || COMMENT_OPTIONAL.has(ev.type)) setDialog({ event: ev.type, label: ev.label });
    else void run(ev.type);
  };

  const submitDialog = (e: FormEvent) => {
    e.preventDefault();
    if (!dialog) return;
    if (COMMENT_REQUIRED.has(dialog.event) && !comment.trim()) {
      setError('A comment is required');
      return;
    }
    void run(dialog.event, comment.trim());
  };

  const createRevision = async () => {
    if (!newerVersion) return;
    setBusy(true);
    try {
      const created = await notesApi.createRevision(revisionId, newerVersion.code);
      navigate(`/notes/${created.noteRevisionId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="workflow-bar" aria-label="Workflow">
      <div className="wf-row">
        <h1>
          <Link to={`/bills/${summary.biennium}/${summary.billId}/${summary.versionCode}`}>{summary.versionLabel}</Link> {summary.kind === 'estimate' ? 'estimate' : 'fiscal note'}
          {summary.billTitle && <span className="muted"> · {summary.billTitle}</span>}
        </h1>
        <dl className="wf-facts">
          <dt>State</dt>
          <dd>
            <span className={`status status-${state.replace('.', '-')}`} title={STATE_HINTS[state]}>
              {stateLabel}
            </span>
            {STATE_HINTS[state] && <span className="muted small state-hint"> {STATE_HINTS[state]}</span>}
            {view && view.execChain.length > 0 && state.startsWith('exec_review') && <span className="muted"> step {Math.min(view.execIndex + 1, view.execChain.length)} of {view.execChain.length}</span>}
          </dd>
          <dt>Due</dt>
          <dd>
            <span className={`due due-${band}`} title={due ? fmtWhen(due) : undefined}>
              {due ? `${dueCountdown(due)} · ${BAND_LABELS[band]}` : 'No deadline yet'}
            </span>
          </dd>
          <dt>Drafter</dt>
          <dd>{summary.drafter?.displayName ?? summary.drafter?.userId ?? 'unassigned'}</dd>
          <dt>Reviewer</dt>
          <dd>{summary.reviewer?.displayName ?? summary.reviewer?.userId ?? (state === 'review.pending' ? 'unclaimed' : 'none')}</dd>
          {view && view.execChain.length > 0 && (
            <>
              <dt>Executive review</dt>
              <dd>
                {view.execChain.map((s, i) => (
                  <span key={i} className={i === view.execIndex && state.startsWith('exec_review') ? 'exec-current' : s.doneAt ? 'exec-done' : undefined}>
                    {i > 0 && ' → '}
                    {s.userId}
                    {s.doneAt ? ' ✓' : ''}
                  </span>
                ))}
              </dd>
            </>
          )}
          {summary.requestId && (
            <>
              <dt>Request</dt>
              <dd>{summary.requestId}</dd>
            </>
          )}
        </dl>
      </div>
      <div className="wf-row wf-actions" role="group" aria-label="Workflow actions">
        {(view?.availableEvents ?? []).map((ev) => (
          <button key={ev.type} type="button" className={ev.type === 'CANCEL' ? 'secondary' : undefined} onClick={() => press(ev)} disabled={busy}>
            {ev.label}
          </button>
        ))}
        {isAssigner && !['approved', 'cancelled', 'superseded'].includes(state) && (
          <button type="button" className="secondary" aria-expanded={showAssign} onClick={() => setShowAssign((s) => !s)}>
            Assign
          </button>
        )}
        <button type="button" className="secondary" aria-expanded={showHistory} onClick={() => setShowHistory((s) => !s)}>
          History
        </button>
        <details className="export-menu">
          <summary>Export</summary>
          <div className="menu-body" role="group" aria-label="Export formats">
            <a href={`/api/v1/notes/${revisionId}/export?format=pdf`} target="_blank" rel="noreferrer">
              PDF
            </a>
            <a href={`/api/v1/notes/${revisionId}/export?format=docx`}>DOCX</a>
            <a href={`/api/v1/notes/${revisionId}/export?format=docx&comments=true`}>DOCX with comments</a>
            <a href={`/api/v1/notes/${revisionId}/export?format=html`} target="_blank" rel="noreferrer">
              HTML
            </a>
            <a href={`/api/v1/notes/${revisionId}/export?format=xml`}>FNS XML (placeholder)</a>
          </div>
        </details>
        {summary.supersededBy && (
          <button type="button" className="secondary" onClick={() => navigate(`/notes/${summary.supersededBy}`)}>
            Open newer revision
          </button>
        )}
        {principal && summary.drafter?.userId === principal.userId && newerVersion && (
          <button type="button" onClick={() => void createRevision()} disabled={busy}>
            Create revision for {newerVersion.shortLabel}
          </button>
        )}
        {error && (
          <span role="alert" className="error">
            {error}
          </span>
        )}
      </div>
      {newerVersion && (
        <p role="status" className="notice">
          {newerVersion.shortLabel} is now the current version of this bill. This note is written against {summary.versionLabel}.
        </p>
      )}
      {dialog && (
        <form className="wf-dialog" onSubmit={submitDialog} aria-labelledby="wf-dialog-h">
          <h2 id="wf-dialog-h">{dialog.label}</h2>
          <label htmlFor="wf-comment">Comment{COMMENT_REQUIRED.has(dialog.event) ? ' (required)' : ' (optional)'}</label>
          {(dialog.event === 'REQUEST_CHANGES' || dialog.event === 'EXEC_RETURN') && (
            <p className="muted small wf-hint">
              Lines that start with “-” or “1.” become items the drafter checks off one by one.
              {openThreads > 0 ? ` The ${openThreads} open comment thread${openThreads === 1 ? '' : 's'} on the text will be attached as items too.` : ' Comment threads on the text, if any, are attached as items too.'}
            </p>
          )}
          <textarea id="wf-comment" rows={dialog.event === 'REQUEST_CHANGES' || dialog.event === 'EXEC_RETURN' ? 5 : 3} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus placeholder={dialog.event === 'REQUEST_CHANGES' ? 'Summary of what needs to change\n- First item\n- Second item' : undefined} />
          <div className="row">
            <button type="submit" disabled={busy}>
              {dialog.label}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setDialog(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {showAssign && view && <AssignPanel revisionId={revisionId} view={view} onDone={async () => { await wf.reload(); await onChanged(); }} onClose={() => setShowAssign(false)} />}
      {showHistory && <HistoryPanel revisionId={revisionId} version={view?.version ?? 0} />}
    </header>
  );
}

function rank(b: string): number {
  return ['overdue', 'within_4h', 'within_24h', 'more_than_24h', 'none'].indexOf(b);
}

function AssignPanel({ revisionId, view, onDone, onClose }: { revisionId: string; view: WorkflowView; onDone: () => Promise<void>; onClose: () => void }) {
  const drafters = useResource(() => notesApi.users('drafter'), []);
  const reviewers = useResource(() => notesApi.users('reviewer'), []);
  const approvers = useResource(() => notesApi.users('approver'), []);
  const [drafter, setDrafter] = useState(view.drafterId ?? '');
  const [reviewer, setReviewer] = useState(view.reviewerId ?? '');
  const [dueAt, setDueAt] = useState('');
  const [chain, setChain] = useState<string[]>(view.execChain.map((s) => s.userId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const call = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMessage(done);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="assign-panel" aria-labelledby="assign-h">
      <div className="panel-head">
        <h2 id="assign-h">Assignments</h2>
        <button type="button" className="linkish" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor="as-drafter">Drafter</label>
          <select id="as-drafter" value={drafter} onChange={(e) => setDrafter(e.target.value)}>
            <option value="">Choose</option>
            {(drafters.data ?? []).map((u) => (
              <option key={u.userId} value={u.userId}>
                {u.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="as-due">Due (optional)</label>
          <input id="as-due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </div>
        <button type="button" disabled={busy || !drafter || drafter === view.drafterId} onClick={() => void call(() => workflowApi.assign(revisionId, { role: 'drafter', userId: drafter, dueAt: dueAt ? new Date(dueAt).toISOString() : undefined }), 'Drafter assigned')}>
          {view.drafterId ? 'Reassign drafter' : 'Assign drafter'}
        </button>
      </div>
      {view.reviewerId && (
        <div className="row">
          <div className="field">
            <label htmlFor="as-reviewer">Reviewer</label>
            <select id="as-reviewer" value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
              <option value="">Choose</option>
              {(reviewers.data ?? []).map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.displayName}
                </option>
              ))}
            </select>
          </div>
          <button type="button" disabled={busy || !reviewer || reviewer === view.reviewerId} onClick={() => void call(() => workflowApi.assign(revisionId, { role: 'reviewer', userId: reviewer }), 'Reviewer reassigned')}>
            Reassign reviewer
          </button>
        </div>
      )}
      <fieldset className="exec-chain">
        <legend>Executive review chain (in order)</legend>
        {chain.map((u, i) => (
          <div className="row" key={i}>
            <label className="visually-hidden" htmlFor={`as-exec-${i}`}>
              Step {i + 1}
            </label>
            <select id={`as-exec-${i}`} value={u} onChange={(e) => setChain(chain.map((x, j) => (j === i ? e.target.value : x)))}>
              <option value="">Choose</option>
              {(approvers.data ?? []).map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.displayName} ({a.divisions.join(', ')})
                </option>
              ))}
            </select>
            <button type="button" className="linkish" onClick={() => setChain(chain.filter((_, j) => j !== i))} aria-label={`Remove step ${i + 1}`}>
              Remove
            </button>
          </div>
        ))}
        <div className="row">
          <button type="button" className="secondary" onClick={() => setChain([...chain, ''])}>
            Add step
          </button>
          <button type="button" disabled={busy || chain.some((c) => !c)} onClick={() => void call(() => workflowApi.setExecChain(revisionId, chain.map((userId) => ({ userId, division: (approvers.data ?? []).find((a) => a.userId === userId)?.divisions[0] }))), 'Executive review chain set')}>
            Save chain
          </button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="ok">
          {message}
        </p>
      )}
    </section>
  );
}

function HistoryPanel({ revisionId, version }: { revisionId: string; version: number }) {
  const log = useResource(() => workflowApi.transitions(revisionId), [revisionId, version]);
  const audit = useResource(() => notesApi.audit(revisionId), [revisionId, version]);
  return (
    <section className="history-panel" aria-labelledby="history-h">
      <h2 id="history-h">Transition history</h2>
      {log.error && <p role="alert">{log.error.message}</p>}
      <ol className="transitions" tabIndex={0} aria-label="Transitions, scrolls">
        {(log.data ?? []).map((t) => (
          <li key={t.seq}>
            <span className="seq">#{t.seq}</span> <strong>{t.event.replace(/_/g, ' ').toLowerCase()}</strong> · {STATE_LABELS[t.fromState] ?? t.fromState} → {STATE_LABELS[t.toState] ?? t.toState} · {t.actorName ?? t.actorId} · {fmtWhen(t.occurredAt)}
            {t.comment && <blockquote>{t.comment}</blockquote>}
          </li>
        ))}
        {log.data && log.data.length === 0 && <li className="muted">No transitions yet.</li>}
      </ol>
      <h3>Audit trail</h3>
      <ol className="audit-rows" tabIndex={0} aria-label="Audit rows, scrolls">
        {(audit.data ?? []).slice(0, 60).map((a) => (
          <li key={a.id}>
            <span className="seq">{fmtWhen(a.at)}</span> <strong>{a.action}</strong> · {a.actorId}
            {a.after != null && <span className="muted small"> {JSON.stringify(a.after).slice(0, 120)}</span>}
          </li>
        ))}
        {audit.error && <li className="muted">Audit rows are visible to participants and reviewers.</li>}
      </ol>
    </section>
  );
}
