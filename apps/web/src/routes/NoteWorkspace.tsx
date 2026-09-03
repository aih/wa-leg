import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
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
import { CommentsPanel, type PendingComment } from '../notes/CommentsPanel';
import { fmtTime, isConflict, notesApi, useResource, type CommentThread, type NoteDocument, type NoteSummary } from '../notes/api';
import { WorkflowBar } from '../notes/WorkflowBar';
import '../notes/notes.css';

type Tab = 'editor' | 'comments';
type SaveState = { kind: 'idle' } | { kind: 'dirty' } | { kind: 'saving' } | { kind: 'saved'; at: string; version: number } | { kind: 'error'; message: string } | { kind: 'conflict' };

const DEBOUNCE_MS = 1500;
const MAX_WAIT_MS = 10_000;

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
  const { principal, hasRole } = useSession();
  const navigate = useNavigate();
  const editorRef = useRef<NoteEditorHandle>(null);
  const [tab, setTab] = useState<Tab>('editor');
  const [collapsed, setCollapsed] = useState(false);
  const [billHash, setBillHash] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [slots, setSlots] = useState({ filled: 0, required: 0, unfilled: [] as string[] });
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const bill = useBill(summary.biennium, summary.billId);
  const version = useVersion(summary.biennium, summary.billId, summary.versionCode);

  const isDrafter = !!principal && summary.drafter?.userId === principal.userId;
  // Draft and Changes requested are editable by the drafter; every other status and every other user is read-only.
  const editing = summary.editable && isDrafter;
  const canComment = !!principal && summary.state !== 'published' && (isDrafter || hasRole('reviewer'));
  const openThreads = threads.filter((t) => t.status === 'open').length;

  // ---- autosave ----
  const versionRef = useRef(initialDocument.version);
  const dirtyRef = useRef<PMNode | null>(null);
  const timer = useRef<number | null>(null);
  const firstDirtyAt = useRef<number | null>(null);
  const clientId = useMemo(() => `web-${Math.random().toString(36).slice(2, 10)}`, []);
  const saveRef = useRef<() => Promise<void>>(async () => {});

  const doSave = useCallback(async () => {
    const doc = dirtyRef.current;
    if (!doc) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    firstDirtyAt.current = null;
    setSave({ kind: 'saving' });
    try {
      const res = await notesApi.save(revisionId, versionRef.current, { doc, mode: initialDocument.mode, clientId });
      versionRef.current = res.version;
      if (dirtyRef.current === doc) dirtyRef.current = null;
      setSave({ kind: 'saved', at: res.savedAt, version: res.version });
      void refreshThreads();
    } catch (err) {
      if (isConflict(err)) {
        setSave({ kind: 'conflict' });
        return;
      }
      setSave({ kind: 'error', message: err instanceof ApiError ? `${err.status}: ${err.message}` : (err as Error).message });
    }
  }, [revisionId, initialDocument.mode, clientId]);
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

  /** After a 412: load the head version and replace the editor's document with it. */
  const reloadDocument = async () => {
    try {
      const fresh = await notesApi.document(revisionId);
      editorRef.current?.setDocument(fresh.doc, { addToHistory: false });
      versionRef.current = fresh.version;
      dirtyRef.current = null;
      setSave({ kind: 'saved', at: fresh.updatedAt, version: fresh.version });
      await reloadSummary();
    } catch (err) {
      setSave({ kind: 'error', message: (err as Error).message });
    }
  };

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

  const saveMarks = async () => {
    if (!editing) return;
    dirtyRef.current = editorRef.current?.getJSON() ?? null;
    await doSave();
  };
  const createComment = async (body: string) => {
    if (!pending) return;
    const { id } = await notesApi.createComment(revisionId, pending.anchorText, body);
    editorRef.current?.applyCommentMark(pending.range, id);
    setPending(null);
    setActiveComment(id);
    await refreshThreads();
    await saveMarks();
  };
  const resolveComment = async (id: string, resolved: boolean) => {
    await notesApi.setCommentStatus(revisionId, id, resolved ? 'resolved' : 'open');
    editorRef.current?.setComment(id, { resolved });
    await refreshThreads();
    await saveMarks();
  };
  const deleteComment = async (id: string) => {
    await notesApi.deleteComment(revisionId, id);
    editorRef.current?.setComment(id, { remove: true });
    if (activeComment === id) setActiveComment(null);
    await refreshThreads();
    await saveMarks();
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
      const result = editorRef.current?.insertCitation(c);
      setNotice(result === 'duplicate' ? `Already cited: ${c.citation}` : null);
      setTab('editor');
      return result;
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

  const billLabel = summary.billId.replace(/^([A-Z]+)(\d+)$/, '$1 $2');

  const right = (
    <div className="note-pane workspace-right">
      <div className="tabs pane-tabs" role="tablist" aria-label="Note panels">
        {(
          [
            ['editor', 'Note'],
            ['comments', `Comments${openThreads ? ` (${openThreads})` : ''}`],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
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
          <p>This note was saved elsewhere.</p>
          <button type="button" onClick={() => void reloadDocument()}>
            Reload
          </button>
        </div>
      )}
      <div role="tabpanel" id="panel-editor" aria-labelledby="tab-editor" hidden={tab !== 'editor'} className="tabpanel">
        <NoteEditor
          ref={editorRef}
          mode={initialDocument.mode}
          doc={initialDocument.doc}
          readOnly={!editing}
          canComment={canComment}
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
            {save.kind === 'conflict' && 'Not saved'}
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
    </div>
  );

  return (
    <div className="bill-page two-pane workspace">
      <WorkflowBar revisionId={revisionId} summary={summary} openThreads={openThreads} onShowComments={() => setTab('comments')} onChanged={reloadSummary} />
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
