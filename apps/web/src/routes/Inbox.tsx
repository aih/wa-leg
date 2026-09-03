import { useState } from 'react';
import { Link } from 'react-router';
import { RequireRole } from '../components/RequireRole';
import { useSession } from '../lib/session';
import { fmtWhen, notificationsApi, useResource, type Notification } from '../notes/api';
import '../notes/notes.css';

const changed = () => window.dispatchEvent(new Event('notifications:changed'));

/** In-app inbox: unread first; opening a link marks the notification read. */
export function Inbox() {
  const { principal } = useSession();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const list = useResource(principal ? () => notificationsApi.list(filter === 'unread') : null, [principal?.userId, filter]);
  const items = list.data ?? [];
  const unread = items.filter((n) => !n.readAt).length;

  const markRead = async (n: Notification) => {
    if (n.readAt) return;
    await notificationsApi.markRead(n.id);
    changed();
    await list.reload();
  };
  const readAll = async () => {
    await notificationsApi.readAll();
    changed();
    await list.reload();
  };

  return (
    <RequireRole roles={[]}>
      <div className="dash-head">
        <h1>Inbox</h1>
        <div className="counts">
          <span aria-live="polite">{unread} unread</span>
          <label className="inline">
            Show
            <select value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'unread')}>
              <option value="all">All</option>
              <option value="unread">Unread</option>
            </select>
          </label>
          <button type="button" className="linkish" onClick={() => void readAll()} disabled={unread === 0}>
            Mark all read
          </button>
        </div>
      </div>
      {list.error && <p role="alert">{list.error.message}</p>}
      {items.length === 0 && !list.loading && <p className="muted">No notifications{filter === 'unread' ? ' unread' : ''}.</p>}
      <ul className="inbox-list">
        {items.map((n) => (
          <li key={n.id} className={`inbox-item${n.readAt ? '' : ' unread'}`}>
            <span className="inbox-title">
              {n.link ? (
                <Link to={n.link} onClick={() => void markRead(n)}>
                  {n.title}
                </Link>
              ) : (
                n.title
              )}
              {!n.readAt && <span className="visually-hidden"> (unread)</span>}
            </span>
            <span className="inbox-actions">
              <span className="muted small">{fmtWhen(n.createdAt)}</span>
              {!n.readAt && (
                <button type="button" className="linkish small" onClick={() => void markRead(n)}>
                  Mark read
                </button>
              )}
            </span>
            <p className="inbox-body small">{n.body}</p>
          </li>
        ))}
      </ul>
    </RequireRole>
  );
}
