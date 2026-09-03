import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { fmtWhen, type ChangeRequest, type ChangeRequestItem } from './api';

export interface ChangeRequestsPanelProps {
  revisionId: string;
  requests: ChangeRequest[];
  /** Current head document version, cited when an item is addressed. */
  headVersion: number;
  /** The signed-in user may address and close (the drafter, or an editor of the note). */
  canAddress: boolean;
  /** The signed-in user may reopen items (a reviewer, or the drafter). */
  canReopen: boolean;
  onOpenThread: (commentId: string) => void;
  onAddress: (crId: string, itemId: string, resolution: string) => Promise<void>;
  onReopen: (crId: string, itemId: string, reason?: string) => Promise<void>;
  onClose: (crId: string, resolution: string) => Promise<void>;
}

/**
 * Change requests, newest first. Each request lists what the reviewer asked for; the drafter marks every item
 * addressed with a note on how, then closes the request. Closed requests keep the resolutions and link to the
 * version comparison that shows the edits.
 */
export function ChangeRequestsPanel({ revisionId, requests, headVersion, canAddress, canReopen, onOpenThread, onAddress, onReopen, onClose }: ChangeRequestsPanelProps) {
  if (requests.length === 0) {
    return (
      <section className="changes-panel" aria-labelledby="changes-h">
        <h2 id="changes-h">Change requests</h2>
        <p className="muted">No reviewer has requested changes on this note.</p>
      </section>
    );
  }
  return (
    <section className="changes-panel" aria-labelledby="changes-h">
      <h2 id="changes-h">Change requests</h2>
      <ol className="change-requests">
        {requests.map((cr) => (
          <li key={cr.id}>
            <Request revisionId={revisionId} cr={cr} headVersion={headVersion} canAddress={canAddress} canReopen={canReopen} onOpenThread={onOpenThread} onAddress={onAddress} onReopen={onReopen} onClose={onClose} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Request({ revisionId, cr, headVersion, canAddress, canReopen, onOpenThread, onAddress, onReopen, onClose }: Omit<ChangeRequestsPanelProps, 'requests'> & { cr: ChangeRequest }) {
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = cr.status === 'open';
  const allAddressed = cr.openItems === 0;
  const compareHref = cr.documentVersion !== null && (cr.resolutionVersion ?? headVersion) > cr.documentVersion ? `/notes/${revisionId}/versions?from=${cr.documentVersion}&to=${cr.resolutionVersion ?? headVersion}` : null;

  const close = async (e: FormEvent) => {
    e.preventDefault();
    if (!resolution.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onClose(cr.id, resolution.trim());
      setResolution('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`change-request ${open ? 'open' : 'closed'}`} aria-labelledby={`cr-${cr.id}-h`}>
      <header className="cr-head">
        <h3 id={`cr-${cr.id}-h`}>
          {cr.event === 'EXEC_RETURN' ? 'Returned by' : 'Changes requested by'} {cr.requestedByName ?? cr.requestedBy}
          <span className="muted small"> · {fmtWhen(cr.requestedAt)}</span>
        </h3>
        <span className={`status ${open ? 'status-changes_requested' : 'status-approved'}`}>{open ? `${cr.openItems} of ${cr.items.length} open` : 'Closed'}</span>
      </header>
      {cr.summary && <blockquote className="cr-summary">{cr.summary}</blockquote>}
      <p className="muted small">
        Requested against document version {cr.documentVersion ?? '?'}.{' '}
        {cr.transitionSeq !== null && <>Recorded as transition #{cr.transitionSeq} in the History panel.</>}
      </p>
      <ol className="cr-items">
        {cr.items.map((item) => (
          <Item key={item.id} cr={cr} item={item} canAddress={canAddress && open} canReopen={canReopen} onOpenThread={onOpenThread} onAddress={onAddress} onReopen={onReopen} />
        ))}
      </ol>
      {open && canAddress && (
        <form className="cr-close" onSubmit={(e) => void close(e)} aria-labelledby={`cr-${cr.id}-close-h`}>
          <h4 id={`cr-${cr.id}-close-h`}>Close this request</h4>
          {!allAddressed && <p className="muted small">Mark every item addressed first. Submit for review is unavailable while items are open.</p>}
          <label htmlFor={`cr-${cr.id}-resolution`} className="small">
            How the request was addressed (sent to the reviewer)
          </label>
          <textarea id={`cr-${cr.id}-resolution`} rows={2} value={resolution} onChange={(e) => setResolution(e.target.value)} disabled={!allAddressed} />
          <div className="row">
            <button type="submit" disabled={busy || !allAddressed || !resolution.trim()}>
              Close request
            </button>
            {compareHref && (
              <Link to={compareHref} className="small">
                Compare v{cr.documentVersion} with the current v{headVersion}
              </Link>
            )}
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </form>
      )}
      {open && !canAddress && <p className="muted small">Waiting for the drafter to address each item and close the request.</p>}
      {!open && (
        <div className="cr-resolution">
          <p>
            <strong>Closed by {cr.closedByName ?? cr.closedBy}</strong>
            {cr.closedAt && <span className="muted small"> · {fmtWhen(cr.closedAt)}</span>}
            {cr.resolutionVersion !== null && <span className="muted small"> · document version {cr.resolutionVersion}</span>}
          </p>
          {cr.resolution && <blockquote>{cr.resolution}</blockquote>}
          {compareHref && (
            <Link to={compareHref} className="small">
              Compare v{cr.documentVersion} (as requested) with v{cr.resolutionVersion ?? headVersion} (as resolved)
            </Link>
          )}
        </div>
      )}
    </article>
  );
}

function Item({ cr, item, canAddress, canReopen, onOpenThread, onAddress, onReopen }: { cr: ChangeRequest; item: ChangeRequestItem; canAddress: boolean; canReopen: boolean; onOpenThread: (id: string) => void; onAddress: ChangeRequestsPanelProps['onAddress']; onReopen: ChangeRequestsPanelProps['onReopen'] }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addressed = item.status === 'addressed';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onAddress(cr.id, item.id, text.trim());
      setText('');
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reopen = async () => {
    const reason = window.prompt('Why is this item being reopened? (optional)') ?? undefined;
    setBusy(true);
    setError(null);
    try {
      await onReopen(cr.id, item.id, reason || undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`cr-item ${addressed ? 'addressed' : 'open'}`}>
      <div className="cr-item-head">
        <span className={`cr-mark`} aria-hidden="true">
          {addressed ? '☑' : '☐'}
        </span>
        <span className="visually-hidden">{addressed ? 'Addressed:' : 'Open:'}</span>
        <div className="cr-item-body">
          <p className="cr-item-text">
            {item.seq}. {item.body}
          </p>
          {item.commentId && (
            <p className="small">
              On the text{' '}
              <button type="button" className="linkish" onClick={() => onOpenThread(item.commentId!)} title="Go to the commented text">
                “{item.anchorText && item.anchorText.length > 80 ? item.anchorText.slice(0, 80) + '…' : item.anchorText}”
              </button>{' '}
              <span className="muted">(comment thread, {item.threadStatus ?? 'deleted'})</span>
            </p>
          )}
          {addressed && (
            <p className="cr-item-resolution small">
              <strong>Addressed by {item.addressedByName ?? item.addressedBy}</strong>
              {item.addressedAt && <span className="muted"> · {fmtWhen(item.addressedAt)}</span>}
              {item.resolutionVersion !== null && <span className="muted"> · v{item.resolutionVersion}</span>}
              {item.resolution && <>: {item.resolution}</>}
            </p>
          )}
        </div>
      </div>
      {(canAddress || (addressed && canReopen)) && (
        <div className="row small cr-item-actions">
          {!addressed && canAddress && !editing && (
            <button type="button" className="linkish" onClick={() => setEditing(true)}>
              Mark addressed
            </button>
          )}
          {!addressed && canAddress && editing && (
            <form className="reply-form" onSubmit={(e) => void submit(e)}>
              <label className="visually-hidden" htmlFor={`cr-item-${item.id}`}>
                How this item was addressed
              </label>
              <textarea id={`cr-item-${item.id}`} rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="What changed and where, e.g. “Filled Part II.B, FY 2026 and FY 2027”" autoFocus />
              <div className="row">
                <button type="submit" disabled={busy || !text.trim()}>
                  Save
                </button>
                <button type="button" className="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {addressed && canReopen && cr.status === 'open' && (
            <button type="button" className="linkish" onClick={() => void reopen()} disabled={busy}>
              Reopen
            </button>
          )}
          {addressed && canReopen && cr.status === 'closed' && (
            <button type="button" className="linkish" onClick={() => void reopen()} disabled={busy} title="Reopens the item and the request">
              Not resolved, reopen
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="error small">
          {error}
        </p>
      )}
    </li>
  );
}
