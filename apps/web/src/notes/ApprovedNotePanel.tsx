import { useMemo } from 'react';
import { Link } from 'react-router';
import { docToHtml } from '@wa-leg/note-schema';
import type { BillSummary } from '../bill/api';
import { useSession } from '../lib/session';
import { fmtWhen, notesApi, useResource, type NoteSummary } from './api';
import 'katex/dist/katex.min.css';

/** The approved fiscal note for the selected bill version, or the latest approved note for an earlier version. */
export function ApprovedNotePanel({ bill, currentCode, notes }: { bill: BillSummary; currentCode: string; notes: NoteSummary[] }) {
  const { principal } = useSession();
  const approved = notes.filter((n) => n.state === 'approved' && n.approvedVersion !== null && n.kind === 'note');
  const seq = (code: string) => bill.versions.findIndex((v) => v.code === code);
  const exact = approved.filter((n) => n.versionCode === currentCode).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  const earlier = exact ? null : approved.filter((n) => seq(n.versionCode) < seq(currentCode)).sort((a, b) => seq(b.versionCode) - seq(a.versionCode) || b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  const chosen = exact ?? earlier;
  const doc = useResource(chosen ? () => notesApi.document(chosen.noteRevisionId, chosen.approvedVersion!) : null, [chosen?.noteRevisionId, chosen?.approvedVersion]);
  const html = useMemo(() => (doc.data ? docToHtml(doc.data.doc, { mode: doc.data.mode, stripComments: true, renderMath: true, citationsAs: 'link' }) : ''), [doc.data]);
  const ofm = bill.priorFiscalNotes;

  return (
    <section className="approved-note" aria-labelledby="approved-note-h">
      <h2 id="approved-note-h">Fiscal note</h2>
      {!chosen && (
        <p className="muted">
          No approved fiscal note for {bill.versions.find((v) => v.code === currentCode)?.shortLabel ?? currentCode} yet.
          {ofm.length > 0 && ' OFM has published a package for this bill; see the links below.'}
        </p>
      )}
      {chosen && (
        <>
          <p className={earlier ? 'notice' : 'muted small'} role={earlier ? 'status' : undefined}>
            {earlier ? `No approved note for this version. Showing the approved note for ${chosen.versionLabel} (an earlier version).` : `Approved note for ${chosen.versionLabel}`} · approved version {chosen.approvedVersion} · {fmtWhen(chosen.updatedAt)}
            {principal && (chosen.drafter?.userId === principal.userId || principal.roles.some((r) => ['reviewer', 'manager', 'admin', 'approver'].includes(r))) && (
              <>
                {' '}
                · <Link to={`/notes/${chosen.noteRevisionId}`}>Open in the workspace</Link>
              </>
            )}
          </p>
          <div className="row export-links" role="group" aria-label="Export">
            <a className="button secondary" href={`/api/v1/notes/${chosen.noteRevisionId}/export?format=pdf`} target="_blank" rel="noreferrer">
              PDF
            </a>
            <a className="button secondary" href={`/api/v1/notes/${chosen.noteRevisionId}/export?format=docx`}>
              DOCX
            </a>
            <a className="button secondary" href={`/api/v1/notes/${chosen.noteRevisionId}/export?format=html`} target="_blank" rel="noreferrer">
              HTML
            </a>
          </div>
          {doc.error && <p role="alert">{doc.error.message}</p>}
          {doc.loading && !doc.data && (
            <p aria-live="polite" className="muted">
              Loading the note…
            </p>
          )}
          {html && <div className="note-readonly note-html approved-html" dangerouslySetInnerHTML={{ __html: html }} />}
        </>
      )}
      {ofm.length > 0 && (
        <p className="small">
          Published by OFM:{' '}
          {ofm.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ', '}
              <a href={p.url} target="_blank" rel="noreferrer">
                {p.label}
              </a>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
