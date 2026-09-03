import { Link } from 'react-router';
import type { BillSummary } from '../bill/api';

function fmt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Bill facts beside the viewer: status, next hearing, versions, prior fiscal notes, companion. */
export function BillSidebar({ bill, currentCode }: { bill: BillSummary; currentCode: string }) {
  const upcoming = bill.hearings.filter((h) => !h.cancelled && new Date(h.hearingAt) > new Date());
  const next = upcoming[0];
  return (
    <aside className="bill-sidebar" aria-labelledby="bill-facts-h">
      <h2 id="bill-facts-h">
        {bill.id.replace(/^([A-Z]+)(\d+)$/, '$1 $2')} <span className="muted">· {bill.title}</span>
      </h2>
      <dl className="facts">
        <dt>Status</dt>
        <dd>
          {bill.status ?? 'unknown'}
          {bill.statusDate ? ` (${bill.statusDate})` : ''}
          {bill.committee?.name ? ` · ${bill.committee.name}` : ''}
        </dd>
        <dt>Next hearing</dt>
        <dd>{next ? `${fmt(next.hearingAt)} · ${next.committee} (${next.kind.replace('_', ' ')})` : 'none scheduled'}</dd>
        <dt>Versions</dt>
        <dd>
          {bill.versions.map((v, i) => (
            <span key={v.code}>
              {i > 0 && ', '}
              {v.code === currentCode ? <strong>{v.shortLabel}</strong> : <Link to={`/bills/${bill.biennium}/${bill.id}/${v.code}`}>{v.shortLabel}</Link>}
              {v.status !== 'parsed' && <span className="muted"> ({v.status})</span>}
            </span>
          ))}
        </dd>
        {bill.companion && (
          <>
            <dt>Companion</dt>
            <dd>
              <Link to={`/bills/${bill.biennium}/${bill.companion.id}`}>{bill.companion.id.replace(/^([A-Z]+)(\d+)$/, '$1 $2')}</Link>
            </dd>
          </>
        )}
        {bill.priorFiscalNotes.length > 0 && (
          <>
            <dt>Published fiscal notes (OFM)</dt>
            <dd>
              <ul className="plain">
                {bill.priorFiscalNotes.map((p) => (
                  <li key={p.id}>
                    <a href={p.url} target="_blank" rel="noreferrer">
                      {p.label}
                    </a>
                    {p.publishedAt && <span className="muted"> · {p.publishedAt}</span>}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
    </aside>
  );
}
