import { useState, type FormEvent } from 'react';
import { fmtWhen, type CommentThread } from './api';

export interface PendingComment {
  range: { from: number; to: number };
  anchorText: string;
}

export interface CommentsPanelProps {
  threads: CommentThread[];
  activeId: string | null;
  pending: PendingComment | null;
  canComment: boolean;
  onSelect: (id: string) => void;
  onCreate: (body: string) => Promise<void>;
  onCancelPending: () => void;
  onReply: (id: string, body: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

/** Threads in document order with open/resolved filter; detached threads (mark deleted) are listed last. */
export function CommentsPanel({ threads, activeId, pending, canComment, onSelect, onCreate, onCancelPending, onReply, onResolve, onDelete }: CommentsPanelProps) {
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [body, setBody] = useState('');
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [busy, setBusy] = useState(false);

  const visible = threads.filter((t) => filter === 'all' || t.status === filter);
  const attached = visible.filter((t) => !t.detached);
  const detached = visible.filter((t) => t.detached);

  const submitNew = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await onCreate(body.trim());
      setBody('');
    } finally {
      setBusy(false);
    }
  };
  const submitReply = async (e: FormEvent, id: string) => {
    e.preventDefault();
    if (!replyBody.trim()) return;
    setBusy(true);
    try {
      await onReply(id, replyBody.trim());
      setReplyBody('');
      setReplyFor(null);
    } finally {
      setBusy(false);
    }
  };

  const Thread = ({ t }: { t: CommentThread }) => (
    <li className={`thread${t.id === activeId ? ' active' : ''}${t.status === 'resolved' ? ' resolved' : ''}`} aria-current={t.id === activeId ? 'true' : undefined}>
      <button type="button" className="thread-anchor linkish" onClick={() => onSelect(t.id)} disabled={t.detached} title={t.detached ? 'The commented text was deleted' : 'Go to the commented text'}>
        “{t.anchorText.length > 80 ? t.anchorText.slice(0, 80) + '…' : t.anchorText}”
      </button>
      <span className="thread-status muted">{t.detached ? 'detached · ' : ''}{t.status}</span>
      <ol className="messages">
        {t.messages.map((m) => (
          <li key={m.id}>
            <span className="author">{m.authorName}</span> <span className="muted small">{fmtWhen(m.createdAt)}</span>
            <p>{m.body}</p>
          </li>
        ))}
      </ol>
      {canComment && (
        <div className="row small">
          {replyFor === t.id ? (
            <form onSubmit={(e) => void submitReply(e, t.id)} className="reply-form">
              <label className="visually-hidden" htmlFor={`reply-${t.id}`}>
                Reply
              </label>
              <textarea id={`reply-${t.id}`} rows={2} value={replyBody} onChange={(e) => setReplyBody(e.target.value)} autoFocus />
              <button type="submit" disabled={busy}>
                Post reply
              </button>
              <button type="button" className="secondary" onClick={() => setReplyFor(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <>
              <button type="button" className="linkish" onClick={() => setReplyFor(t.id)}>
                Reply
              </button>
              <button type="button" className="linkish" onClick={() => void onResolve(t.id, t.status !== 'resolved')}>
                {t.status === 'resolved' ? 'Reopen' : 'Resolve'}
              </button>
              <button type="button" className="linkish" onClick={() => void onDelete(t.id)}>
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );

  return (
    <section className="comments-panel" aria-labelledby="comments-h">
      <div className="panel-head">
        <h2 id="comments-h">Comments</h2>
        <label className="inline small">
          Show
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        </label>
      </div>
      {pending && (
        <form className="new-comment" onSubmit={(e) => void submitNew(e)} aria-labelledby="new-comment-h">
          <h3 id="new-comment-h">New comment</h3>
          <p className="muted small">On: “{pending.anchorText.length > 120 ? pending.anchorText.slice(0, 120) + '…' : pending.anchorText}”</p>
          <label className="visually-hidden" htmlFor="new-comment-body">
            Comment
          </label>
          <textarea id="new-comment-body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
          <div className="row">
            <button type="submit" disabled={busy || !body.trim()}>
              Add comment
            </button>
            <button type="button" className="secondary" onClick={onCancelPending}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {!pending && canComment && <p className="muted small">Select text in the note and press Comment in the toolbar to start a thread.</p>}
      <ol className="threads" aria-label="Comment threads">
        {attached.map((t) => (
          <Thread key={t.id} t={t} />
        ))}
      </ol>
      {detached.length > 0 && (
        <>
          <h3>Detached</h3>
          <ol className="threads" aria-label="Detached threads">
            {detached.map((t) => (
              <Thread key={t.id} t={t} />
            ))}
          </ol>
        </>
      )}
      {visible.length === 0 && !pending && <p className="muted">No {filter === 'all' ? '' : filter + ' '}comments.</p>}
    </section>
  );
}
