import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { BillViewer } from '../bill/BillViewer';
import { fetchDiff, useBill, useResource, useVersion } from '../bill/api';
import { RequireRole } from '../components/RequireRole';
import { defaultUrlBuilder } from '../bill/cite';

export function ComparePage() {
  const { biennium, id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const from = search.get('from') ?? '';
  const to = search.get('to') ?? '';
  const at = search.get('at');
  const mode = (search.get('mode') === 'effect' ? 'effect' : 'as-printed') as 'as-printed' | 'effect';
  const upper = id?.toUpperCase();
  const bill = useBill(biennium, upper);
  const fromDoc = useVersion(biennium, upper, from || undefined);
  const toDoc = useVersion(biennium, upper, to || undefined);
  const diff = useResource(biennium && upper && from && to ? `${biennium}/${upper}/${from}/${to}/${mode}` : null, () => fetchDiff(biennium!, upper!, from, to, mode));

  useEffect(() => {
    document.title = `Compare ${upper ?? ''} ${from} → ${to} · Fiscal Note Workbench`;
  }, [upper, from, to]);

  if (!biennium || !upper) return <p role="alert">Missing bill reference.</p>;
  if (!from || !to) return <p role="alert">Both from and to versions are required.</p>;
  const err = fromDoc.error ?? toDoc.error ?? diff.error;
  if (err) return <p role="alert">{err.message}</p>;
  if (!fromDoc.data || !toDoc.data || !diff.data) return <p aria-live="polite">Loading comparison…</p>;

  return (
    <RequireRole roles={[]}>
      <div className="bill-page compare-page">
        <BillViewer
          document={toDoc.data}
          compare={{ from: fromDoc.data, diff: diff.data }}
          hash={at ? `#${at}` : null}
          urlBuilder={defaultUrlBuilder}
          readOnly
          onRequestVersion={(c) => navigate(`/bills/${biennium}/${upper}/${c}`)}
          onRequestCompare={(f, t) => {
            if (!f) navigate(`/bills/${biennium}/${upper}/${to}${at ? `#${at}` : ''}`);
            else navigate(defaultUrlBuilder.compare({ biennium, id: upper }, f, t, at ?? undefined));
          }}
          onNavigate={(h) => history.replaceState(null, '', `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&at=${encodeURIComponent(h)}${mode === 'effect' ? '&mode=effect' : ''}`)}
        />
        <p className="pad muted small">
          {bill.data?.title} ·{' '}
          <a href={`?from=${from}&to=${to}${at ? `&at=${at}` : ''}${mode === 'effect' ? '' : '&mode=effect'}`}>{mode === 'effect' ? 'Show as printed' : 'Show resulting law (effect mode)'}</a>
        </p>
      </div>
    </RequireRole>
  );
}
