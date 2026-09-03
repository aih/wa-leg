import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { BillCitation, CiteEvent } from '@wa-leg/bill-document/browser';
import type { PMNode } from '@wa-leg/note-schema';
import { BillViewer } from '../bill/BillViewer';
import { useBill, useVersion } from '../bill/api';
import { defaultUrlBuilder } from '../bill/cite';
import { SplitPane } from '../components/SplitPane';
import { RequireRole } from '../components/RequireRole';
import { useSession } from '../lib/session';
import { ApiError } from '../lib/api';
import { NoteEditor, type NoteEditorHandle } from '../notes/NoteEditor';
import { TemplatePanel } from '../notes/TemplatePanel';
import { CommentsPanel, type PendingComment } from '../notes/CommentsPanel';
import { fmtTime, fmtWhen, isConflict, notesApi, useResource, STATE_LABELS, type CommentThread, type ConflictDetails, type LockInfo, type NoteDocument, type NoteSummary } from '../notes/api';
import '../notes/notes.css';

type Tab = 'editor' | 'comments' | 'templates';
type SaveState = { kind: 'idle' } | { kind: 'dirty' } | { kind: 'saving' } | { kind: 'saved'; at: string; version: number } | { kind: 'error'; message: string } | { kind: 'conflict'; server: ConflictDetails };

const DEBOUNCE_MS = 1500;
const MAX_WAIT_MS = 10_000;
const LOCK_RENEW_MS = 60_000;

/** Workspace: bill viewer on the left, the note editor (or read-only view) on the right, workflow bar on top. */
export function NoteWorkspace() {
  const { revisionId } = useParams();
  const summary = useResource(revisionId ? () => notesApi.summary(revisionId) : null, [revisionId]);
  const document = useResource(revisionId ? () => notesApi.document(revisionId) : null, [revisionId]);
  const error = summary.error ?? document.error;
  useEffect(() => {
    if (summary.data) window.document.title = `${summary.data.versionLabel} fiscal note · Fiscal Note Workbench`;
  }, [summary.data]);

  if (!revisionId) return <p role="alert">Missing note id.</p>;
  if (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return (
      <RequireRole roles={[]}>
        <p role="alert" className="pad">
          {status === 403 ? 'You do not have access to this note.' : status === 404 ? 'This note does not exist.' : error.message}
        </p>
      </RequireRole>
    );
  }
  if (!summary.data || !document.data) {
    return (
      <RequireRole roles={[]}>
        <p aria-live="polite" className="pad">
          Loading note…
        </p>
      </RequireRole>
    );
  }
  return (
    <RequireRole roles={[]}>
      <Workspace key={revisionId} revisionId={revisionId} summary={summary.data} initialDocument={document.data} reloadSummary={summary.reload} />
    </RequireRole>
  );
}

function Workspace({ revisionId, summary, initialDocument, reloadSummary }: { revisionId: string; summary: NoteSummary; initialDocument: NoteDocument; reloadSummary: () => Promise<void> }) {
  const { principal } = useSession();
  const navigate = useNavigate();
  const editorRef = useRef<NoteEditorHandle>(null);
  const [tab, setTab] = useState<Tab>('editor');
  const [collapsed, setCollapsed] = useState(false);
  const [billHash, setBillHash] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [slots, setSlots] = useState({ filled: 0, required: 0, unfilled: [] as string[] });
  const [lock, setLock] = useState<{ status: 'mine' | 'other' | 'none' | 'unavailable'; info?: LockInfo }>({ status: 'none' });
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const bill = useBill(summary.biennium, summary.billId);
  const version = useVersion(summary.biennium, summary.billId, summary.versionCode);

  const isDrafter = !!principal && summary.drafter?.userId === principal.userId;
  const isReviewerOrManager = !!principal && (principal.roles.includes('reviewer') || principal.roles.includes('manager') || principal.roles.includes('admin'));
  const mayEdit = summary.editable && (isDrafter || (summary.state === 'review.active' && summary.reviewer?.userId === principal?.userId) || (summary.state === 'exec_review.active' && summary.execChain.some((e) => e.userId === principal?.userId)));
  const editing = mayEdit && lock.status !== 'other';
  const canComment = !!principal && (isDrafter || isReviewerOrManager || summary.reviewer?.userId === principal.userId);

  // ---- autosave ----
  const versionRef = useRef(initialDocument.version);
  const dirtyRef = useRef<PMNode | null>(null);
  const timer = useRef<number | null>(null);
  const firstDirtyAt = useRef<number | null>(null);
  const clientId = useMemo(() => `web-${Math.random().toString(36).slice(2, 10)}`, []);
  const saveRef = useRef<(opts?: { force?: boolean }) => Promise<void>>(async () => {});

  const doSave = useCallback(
    async (opts: { force?: boolean } = {}) => {
      const doc = dirtyRef.current ?? (opts.force ? editorRef.current?.getJSON() ?? null : null);
      if (!doc) return;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
      firstDirtyAt.current = null;
      setSave({ kind: 'saving' });
      try {
        const res = await notesApi.save(revisionId, versionRef.current, { doc, mode: initialDocument.mode, clientId }, opts.force);
        versionRef.current = res.version;
        if (dirtyRef.current === doc) dirtyRef.current = null;
        setSave({ kind: 'saved', at: res.savedAt, version: res.version });
        void refreshThreads();
      } catch (err) {
        if (isConflict(err)) {
          setSave({ kind: 'conflict', server: err.body.details });
          return;
        }
        setSave({ kind: 'error', message: err instanceof ApiError ? `${err.status}: ${err.message}` : (err as Error).message });
      }
    },
    [revisionId, initialDocument.mode, clientId],
  );
  saveRef.current = doSave;

  const scheduleSave = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    const now = Date.now();
    firstDirtyAt.current ??= now;
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (now - firstDirtyAt.current)));
    timer.current = window.setTimeout(() => void saveRef.current(), wait);
  }, []);

  const onChange = useCallback(
    (doc: PMNode) => {
      if (!editing) return;
      dirtyRef.current = doc;
      setSave((s) => (s.kind === 'conflict' ? s : { kind: 'dirty' }));
      scheduleSave();
    },
    [editing, scheduleSave],
  );

  // Flush on blur, when the tab hides, and before leaving the page.
  useEffect(() => {
    const flush = () => {
      if (dirtyRef.current) void saveRef.current();
    };
    const onHide = () => {
      if (window.document.visibilityState === 'hidden') flush();
    };
    const beforeUnload = () => {
      if (!dirtyRef.current) return;
      void fetch(`/api/v1/notes/${revisionId}/document`, { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'if-match': `"${versionRef.current}"` }, body: JSON.stringify({ doc: dirtyRef.current, mode: initialDocument.mode, clientId }) });
    };
    window.addEventListener('blur', flush);
    window.document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('blur', flush);
      window.document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', beforeUnload);
      flush();
    };
  }, [revisionId, initialDocument.mode, clientId]);

  // ---- lock ----
  useEffect(() => {
    if (!mayEdit) return;
    let stopped = false;
    let handle: number | null = null;
    const acquire = async () => {
      try {
        const info = await notesApi.lock(revisionId);
        if (!stopped) setLock({ status: 'mine', info });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const holder = (err.body as { details?: LockInfo } | undefined)?.details;
          if (!stopped) setLock({ status: 'other', info: holder });
        } else if (!stopped) setLock({ status: 'unavailable' });
      }
    };
    void acquire();
    handle = window.setInterval(() => void acquire(), LOCK_RENEW_MS);
    return () => {
      stopped = true;
      if (handle) window.clearInterval(handle);
      void notesApi.unlock(revisionId).catch(() => undefined);
    };
  }, [revisionId, mayEdit]);

  // ---- comments ----
  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await notesApi.comments(revisionId));
    } catch {
      /* keep the last list */
    }
  }, [revisionId]);
  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  const createComment = async (body: string) => {
    if (!pending) return;
    const { id } = await notesApi.createComment(revisionId, pending.anchorText, body);
    editorRef.current?.applyCommentMark(pending.range, id);
    setPending(null);
    setActiveComment(id);
    await refreshThreads();
    if (editing) {
      dirtyRef.current = editorRef.current?.getJSON() ?? null;
      await doSave();
    }
  };
  const resolveComment = async (id: string, resolved: boolean) => {
    await notesApi.setCommentStatus(revisionId, id, resolved ? 'resolved' : 'open');
    editorRef.current?.setComment(id, { resolved });
    await refreshThreads();
    if (editing) {
      dirtyRef.current = editorRef.current?.getJSON() ?? null;
      await doSave();
    }
  };
  const deleteComment = async (id: string) => {
    await notesApi.deleteComment(revisionId, id);
    editorRef.current?.setComment(id, { remove: true });
    if (activeComment === id) setActiveComment(null);
    await refreshThreads();
    if (editing) {
      dirtyRef.current = editorRef.current?.getJSON() ?? null;
      await doSave();
    }
  };

  // ---- citations ----
  const versionLabel = summary.versionLabel;
  const onCite = useCallback(
    (e: CiteEvent) => {
      const c: BillCitation = {
        billKey: `WA:${e.bill.biennium}:${e.bill.id}`,
        versionCode: e.versionCode,
        versionLabel,
        sectionId: e.sectionId,
        blockId: e.blockId ?? undefined,
        label: e.label ?? `Sec. ${e.sectionNum}`,
        citation: e.citation,
        href: e.href,
        text: e.text,
        amendmentId: e.amendmentId,
      };
      if (!editing) {
        setNotice(`Citation ${c.citation} is ready, but this note is read-only.`);
        return;
      }
      editorRef.current?.insertCitation(c);
      setTab('editor');
    },
    [editing, versionLabel],
  );
  const onCitationActivate = useCallback((c: BillCitation) => {
    const hash = c.href.includes('#') ? c.href.slice(c.href.indexOf('#')) : `#${c.sectionId}`;
    setCollapsed(false);
    setBillHash(hash);
  }, []);
  const onCiteRequest = useCallback(() => {
    setNotice('Select text in the bill, or press Cite in the bill’s section bar, to insert a citation at the cursor.');
    setCollapsed(false);
  }, []);

  // ---- conflict actions ----
  const reloadTheirs = () => {
    if (save.kind !== 'conflict') return;
    editorRef.current?.setDocument(save.server.doc);
    versionRef.current = save.server.version;
    dirtyRef.current = null;
    setSave({ kind: 'saved', at: save.server.updatedAt, version: save.server.version });
  };
  const keepMine = () => {
    if (save.kind !== 'conflict') return;
    dirtyRef.current = editorRef.current?.getJSON() ?? dirtyRef.current;
    void doSave({ force: true });
  };

  const applyTemplate = (doc: PMNode, how: 'document' | 'snippet') => {
    if (how === 'document') editorRef.current?.setDocument(doc);
    else editorRef.current?.insertContent(doc.content ?? []);
    setTab('editor');
    window.setTimeout(() => editorRef.current?.focusSlot('next'), 0);
  };

  const state = STATE_LABELS[summary.state] ?? summary.state;
  const billLabel = summary.billId.replace(/^([A-Z]+)(\d+)$/, '$1 $2');

  const right = (
    <div className="note-pane workspace-right">
      <div className="tabs pane-tabs" role="tablist" aria-label="Note panels">
        {(
          [
            ['editor', mayEdit ? 'Editor' : 'Note'],
            ['comments', `Comments${threads.filter((t) => t.status === 'open').length ? ` (${threads.filter((t) => t.status === 'open').length})` : ''}`],
            ['templates', 'Templates'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="pane-links">
        <Link to={`/notes/${revisionId}/versions`} className="tab-link">
          Versions
        </Link>
      </div>
      {notice && (
        <p role="status" className="notice">
          {notice}{' '}
          <button type="button" className="linkish" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}
      {save.kind === 'conflict' && (
        <div role="alert" className="banner conflict">
          <p>
            Saved by {save.server.updatedByName ?? save.server.updatedBy} at {fmtTime(save.server.updatedAt)} (version {save.server.version}). Reload their version or keep yours as a new version.
          </p>
          <button type="button" onClick={reloadTheirs}>
            Reload theirs
          </button>
          <button type="button" className="secondary" onClick={keepMine}>
            Keep mine
          </button>
        </div>
      )}
      {mayEdit && lock.status === 'other' && (
        <div role="status" className="banner">
          <p>
            {lock.info?.holderName ?? lock.info?.holder ?? 'Another user'} is editing this note. It opens read-only until they leave.
          </p>
          <button type="button" className="secondary" onClick={() => notesApi.lock(revisionId).then((info) => setLock({ status: 'mine', info })).catch(() => undefined)}>
            Request edit
          </button>
        </div>
      )}
      <div role="tabpanel" id="panel-editor" aria-labelledby="tab-editor" hidden={tab !== 'editor'} className="tabpanel">
        <NoteEditor
          ref={editorRef}
          mode={initialDocument.mode}
          doc={initialDocument.doc}
          readOnly={!editing}
          activeCommentId={activeComment}
          onChange={onChange}
          onSaveRequest={() => void doSave()}
          onCiteRequest={onCiteRequest}
          onCitationActivate={onCitationActivate}
          onCommentRequest={(range, anchorText) => {
            setPending({ range, anchorText });
            setTab('comments');
          }}
          onCommentSelect={(id) => setActiveComment(id)}
          onTemplateRequest={() => setTab('templates')}
          onSlotStatus={setSlots}
        />
        <div className="status-bar">
          <span aria-live="polite" className="slot-count">
            {slots.required > 0 ? `${slots.filled} of ${slots.required} required slots filled` : 'No required slots'}
          </span>
          <span aria-live="polite" className={`save-state save-${save.kind}`}>
            {save.kind === 'idle' && (editing ? 'All changes saved' : 'Read-only')}
            {save.kind === 'dirty' && 'Unsaved changes'}
            {save.kind === 'saving' && 'Saving…'}
            {save.kind === 'saved' && `Saved at ${fmtTime(save.at)} · v${save.version}`}
            {save.kind === 'error' && `Save failed: ${save.message}`}
            {save.kind === 'conflict' && 'Save conflict'}
          </span>
          {editing && (
            <button type="button" className="linkish" onClick={() => void doSave()} disabled={!dirtyRef.current}>
              Save now
            </button>
          )}
        </div>
      </div>
      <div role="tabpanel" id="panel-comments" aria-labelledby="tab-comments" hidden={tab !== 'comments'} className="tabpanel">
        <CommentsPanel
          threads={threads}
          activeId={activeComment}
          pending={pending}
          canComment={canComment}
          onSelect={(id) => {
            setActiveComment(id);
            setTab('editor');
            window.setTimeout(() => editorRef.current?.focusComment(id), 0);
          }}
          onCreate={createComment}
          onCancelPending={() => setPending(null)}
          onReply={async (id, body) => {
            await notesApi.reply(revisionId, id, body);
            await refreshThreads();
          }}
          onResolve={resolveComment}
          onDelete={deleteComment}
        />
      </div>
      <div role="tabpanel" id="panel-templates" aria-labelledby="tab-templates" hidden={tab !== 'templates'} className="tabpanel">
        {tab === 'templates' && (
          <TemplatePanel
            mode={initialDocument.mode}
            noteRevisionId={revisionId}
            documentIsEmpty={editorRef.current?.isEmpty() ?? false}
            onApply={(doc, how) => {
              if (!editing) {
                setNotice('This note is read-only; templates cannot be applied.');
                return;
              }
              applyTemplate(doc, how);
            }}
            onClose={() => setTab('editor')}
          />
        )}
      </div>
    </div>
  );

  return (
    <div className="bill-page two-pane workspace">
      <header className="workflow-bar">
        <h1>
          <Link to={`/bills/${summary.biennium}/${summary.billId}/${summary.versionCode}`}>{summary.versionLabel}</Link> {summary.kind === 'estimate' ? 'estimate' : 'fiscal note'}
          {summary.billTitle && <span className="muted"> · {summary.billTitle}</span>}
        </h1>
        <dl className="wf-facts">
          <dt>State</dt>
          <dd>
            <span className={`status status-${summary.state.replace('.', '-')}`}>{state}</span>
          </dd>
          <dt>Drafter</dt>
          <dd>{summary.drafter?.displayName ?? summary.drafter?.userId ?? 'unassigned'}</dd>
          {summary.reviewer && (
            <>
              <dt>Reviewer</dt>
              <dd>{summary.reviewer.displayName ?? summary.reviewer.userId}</dd>
            </>
          )}
          <dt>Due</dt>
          <dd>{summary.effectiveDueAt ? fmtWhen(summary.effectiveDueAt) : 'no deadline yet'}</dd>
          {summary.requestId && (
            <>
              <dt>Request</dt>
              <dd>{summary.requestId}</dd>
            </>
          )}
          {summary.confidential && (
            <>
              <dt>Access</dt>
              <dd>Confidential</dd>
            </>
          )}
        </dl>
        <div className="wf-actions">
          {summary.supersededBy && (
            <button type="button" className="secondary" onClick={() => navigate(`/notes/${summary.supersededBy}`)}>
              Open newer revision
            </button>
          )}
          <button type="button" className="secondary" onClick={() => void reloadSummary()}>
            Refresh
          </button>
        </div>
      </header>
      <SplitPane
        railLabel={billLabel}
        storageKey="workspace.split"
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        tabs={['Bill', 'Note']}
        left={
          version.data ? (
            <BillViewer
              document={version.data}
              hash={billHash}
              urlBuilder={defaultUrlBuilder}
              onCite={onCite}
              onCollapse={() => setCollapsed(true)}
              onRequestVersion={(c) => navigate(`/bills/${summary.biennium}/${summary.billId}/${c}`)}
              onRequestCompare={(from, to) => {
                if (from) navigate(defaultUrlBuilder.compare({ biennium: summary.biennium, id: summary.billId }, from, to));
              }}
              onNavigate={(hash) => setBillHash(`#${hash}`)}
              options={{ showHeader: false }}
            />
          ) : version.error ? (
            <p role="alert" className="pad">
              {bill.error?.message ?? version.error.message}
            </p>
          ) : (
            <p aria-live="polite" className="pad">
              Loading bill text…
            </p>
          )
        }
        right={right}
      />
    </div>
  );
}
