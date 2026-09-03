import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import type { CiteEvent } from '@wa-leg/bill-document/browser';
import { BillViewer } from '../bill/BillViewer';
import { useBill, useVersion } from '../bill/api';
import { SplitPane } from '../components/SplitPane';
import { RequireRole } from '../components/RequireRole';
import { defaultUrlBuilder } from '../bill/cite';
import { BillSidebar } from '../components/BillSidebar';
import { ApiError } from '../lib/api';
import { NewNoteForm } from '../notes/NewNoteForm';
import { NoteList } from '../notes/NoteList';
import { ApprovedNotePanel } from '../notes/ApprovedNotePanel';
import { notesApi, useResource } from '../notes/api';
import { useSession } from '../lib/session';

/** Bill page: viewer on the left, the approved-note panel (milestone 7) on the right. Until then the
 *  right pane lists emitted citations. */
export function BillPage() {
  const { biennium, id, code } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [search] = useSearchParams();
  const bill = useBill(biennium, id?.toUpperCase());
  const version = useVersion(biennium, id?.toUpperCase(), code ?? 'current');
  const [collapsed, setCollapsed] = useState(false);
  const [cites, setCites] = useState<CiteEvent[]>([]);
  const { principal } = useSession();
  const notes = useResource(principal && biennium && id ? () => notesApi.forBill(biennium, id.toUpperCase()) : null, [principal?.userId, biennium, id]);

  // /bills/{b}/{id} → the current version, keeping the fragment.
  useEffect(() => {
    if (!code && version.data?.resolvedCode && biennium && id) {
      navigate(`/bills/${biennium}/${id.toUpperCase()}/${version.data.resolvedCode}${location.hash}`, { replace: true });
    }
  }, [code, version.data?.resolvedCode, biennium, id, navigate, location.hash]);

  const onNavigate = useCallback((hash: string) => {
    if (window.location.hash !== `#${hash}`) history.replaceState(null, '', `#${hash}`);
  }, []);

  const onCite = useCallback((e: CiteEvent) => setCites((c) => [...c, e]), []);

  if (!biennium || !id) return <p role="alert">Missing bill reference.</p>;

  const title = bill.data ? `${bill.data.id.replace(/^([A-Z]+)(\d+)$/, '$1 $2')}: ${bill.data.title}` : 'Bill';
  useDocumentTitle(title);

  if (version.error) {
    const status = version.error instanceof ApiError ? version.error.status : 500;
    return (
      <RequireRole roles={[]}>
        <section className="bill-page">
          <h1>{title}</h1>
          <p role="alert">
            {status === 404 ? `No text for ${id.toUpperCase()} version ${code ?? 'current'} is loaded.` : version.error.message}
          </p>
          {bill.data && <BillSidebar bill={bill.data} currentCode={code ?? bill.data.currentVersionCode} />}
        </section>
      </RequireRole>
    );
  }

  return (
    <RequireRole roles={[]}>
      <div className="bill-page two-pane">
        <SplitPane
          railLabel={bill.data?.id ?? id.toUpperCase()}
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          tabs={['Bill', 'Fiscal note']}
          left={
            version.data ? (
              <BillViewer
                document={version.data}
                hash={location.hash || null}
                urlBuilder={defaultUrlBuilder}
                onCite={onCite}
                onCollapse={() => setCollapsed(true)}
                onRequestVersion={(c) => navigate(`/bills/${biennium}/${id.toUpperCase()}/${c}`)}
                onRequestCompare={(from, to) => {
                  if (!from) return;
                  navigate(defaultUrlBuilder.compare({ biennium, id: id.toUpperCase() }, from, to, location.hash.replace(/^#/, '') || undefined));
                }}
                onNavigate={onNavigate}
              />
            ) : (
              <p aria-live="polite" className="pad">
                Loading bill text…
              </p>
            )
          }
          right={
            <div className="note-pane pad">
              {bill.data && <BillSidebar bill={bill.data} currentCode={version.data?.version.code ?? code ?? bill.data.currentVersionCode} />}
              {bill.data && <ApprovedNotePanel bill={bill.data} currentCode={version.data?.version.code ?? code ?? bill.data.currentVersionCode} notes={notes.data ?? []} />}
              <section aria-labelledby="notes-h" className="bill-notes">
                <h2 id="notes-h">Fiscal notes</h2>
                <NoteList notes={(notes.data ?? []).filter((n) => !!principal && (n.state !== 'approved' || principal.roles.some((r) => ['drafter', 'reviewer', 'manager', 'admin', 'approver'].includes(r))))} showBill={false} empty={principal ? 'No drafts you can see on this bill.' : 'Sign in to see drafts.'} />
                {bill.data && <NewNoteForm bill={bill.data} currentCode={version.data?.version.code ?? code ?? bill.data.currentVersionCode} />}
              </section>
              {cites.length > 0 && (
                <section aria-labelledby="cites-h" className="cite-list">
                  <h2 id="cites-h">Citations emitted</h2>
                  <ol>
                    {cites.map((c, i) => (
                      <li key={i}>
                        <a href={c.href}>{c.citation}</a>
                        {c.text && <blockquote>{c.text.length > 240 ? c.text.slice(0, 240) + '…' : c.text}</blockquote>}
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {search.get('amendment') && <p className="muted">Amendment overlay is built but switched off in this build.</p>}
            </div>
          }
        />
      </div>
    </RequireRole>
  );
}

function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Fiscal Note Workbench`;
  }, [title]);
}
