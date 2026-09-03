import { useMemo } from 'react';
import { Link } from 'react-router';
import { docToHtml } from '@wa-leg/note-schema';
import type { BillSummary } from '../bill/api';
import { useSession } from '../lib/session';
import { fmtWhen, notesApi, useResource, type NoteSummary } from './api';
import 'katex/dist/katex.min.css';

type PublishedSummary = NoteSummary & { publishedAt: string; publishedVersion: number };

const EXPORT_FORMATS = ['pdf', 'docx', 'html', 'xml'] as const;

/** The published fiscal note for the selected bill version, or the latest published note for an earlier version. */
export function ApprovedNotePanel({ bill, currentCode, notes }: { bill: BillSummary; currentCode: string; notes: NoteSummary[] }) {
  const { principal } = useSession();
  const published = notes.filter((n): n is PublishedSummary => n.state === 'published' && (n as PublishedSummary).publishedVersion !== null && (n as PublishedSummary).publishedAt !== null);
  const seq = (code: string) => bill.versions.findIndex((v) => v.code === code);
  const exact = published.filter((n) => n.versionCode === currentCode).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0] ?? null;
  const earlier = exact ? null : published.filter((n) => seq(n.versionCode) < seq(currentCode)).sort((a, b) => seq(b.versionCode) - seq(a.versionCode) || b.publishedAt.localeCompare(a.publishedAt))[0] ?? null;
  const chosen = exact ?? earlier;
  const doc = useResource(chosen ? () => notesApi.document(chosen.noteRevisionId, chosen.publishedVersion) : null, [chosen?.noteRevisionId, chosen?.publishedVersion]);
  const html = useMemo(() => (doc.data ? docToHtml(doc.data.doc, { mode: doc.data.mode, stripComments: true, renderMath: true, citationsAs: 'link' }) : ''), [doc.data]);
  const ofm = bill.priorFiscalNotes;

  return (
    <section className="approved-note" aria-labelledby="approved-note-h">
      <h2 id="approved-note-h">Fiscal note</h2>
      {!chosen && (
        <p className="muted">
          No published fiscal note for {bill.versions.find((v) => v.code === currentCode)?.shortLabel ?? currentCode} yet.
          {ofm.length > 0 && ' OFM has published a package for this bill; see the links below.'}
        </p>
      )}
      {chosen && (
        <>
          <p className={earlier ? 'notice' : 'muted small'} role={earlier ? 'status' : undefined}>
            {earlier ? `No published note for this version. Showing the published note for ${chosen.versionLabel} (an earlier version).` : `Published note for ${chosen.versionLabel}`} · Published {fmtWhen(chosen.publishedAt)}
            {principal && (chosen.drafter?.userId === principal.userId || principal.roles.some((r) => ['reviewer', 'admin'].includes(r))) && (
              <>
                {' '}
                · <Link to={`/notes/${chosen.noteRevisionId}`}>Open in the workspace</Link>
              </>
            )}
          </p>
          <div className="row export-links" role="group" aria-label="Export">
            {EXPORT_FORMATS.map((format) => (
              <a key={format} className="button secondary" href={`/api/v1/notes/${chosen.noteRevisionId}/export?format=${format}`} {...(format === 'docx' ? {} : { target: '_blank', rel: 'noreferrer' })}>
                {format.toUpperCase()}
              </a>
            ))}
          </div>
          {doc.error && <p role="alert">{doc.error.message}</p>}
          {doc.loading && !doc.data && (
            <p aria-live="polite" className="muted">
              Loading the note…
            </p>
          )}
          {html && <div className="note-readonly note-html approved-html" tabIndex={0} role="region" aria-label="Note text" dangerouslySetInnerHTML={{ __html: html }} />}
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
