import { useCallback, useEffect, useState } from 'react';
import type { EstimateData, PMNode, TemplateContext, ValidationResult } from '@wa-leg/note-schema';
import { api, ApiError } from '../lib/api';

export type EditorMode = 'limited' | 'full';

export interface NoteSummary {
  noteRevisionId: string;
  noteId: string;
  billKey: string;
  biennium: string;
  billId: string;
  billTitle?: string;
  versionCode: string;
  versionLabel: string;
  amendmentId: string | null;
  kind: 'note' | 'estimate';
  requestId: string | null;
  requestedAt: string | null;
  legContact: { name?: string; phone?: string } | null;
  tenYearRequested: boolean;
  confidential: boolean;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  identifier: string | null;
  state: string;
  drafterStatus: string;
  reviewerStatus: string;
  drafter: { userId: string; displayName?: string } | null;
  reviewer: { userId: string; displayName?: string } | null;
  execChain: { userId: string; division?: string }[];
  deadlines: { kind: string; dueAt: string; warnAt?: string }[];
  effectiveDueAt: string | null;
  headVersion: number;
  approvedVersion: number | null;
  previousRevisionId: string | null;
  supersededBy: string | null;
  templateId: string | null;
  editable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NoteDocument {
  noteId: string;
  version: number;
  mode: EditorMode;
  doc: PMNode;
  templateId: string | null;
  templateVersion: number | null;
  label: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface SaveResult {
  version: number;
  savedAt: string;
  estimateData: EstimateData;
  validation: ValidationResult;
}

export interface ConflictDetails {
  version: number;
  doc: PMNode;
  updatedBy: string;
  updatedByName?: string;
  updatedAt: string;
}

export interface VersionRow {
  version: number;
  label: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  summary: string | null;
}

export interface CommentThread {
  id: string;
  status: 'open' | 'resolved';
  anchorText: string;
  detached: boolean;
  position: number | null;
  createdBy: string;
  createdAt: string;
  messages: { id: string; authorId: string; authorName: string; body: string; createdAt: string }[];
}

export interface LockInfo {
  holder: string;
  holderName?: string;
  expiresAt: string;
  mine?: boolean;
}

export interface TemplateSummary {
  id: string;
  name: string;
  kind: 'document' | 'snippet';
  mode: EditorMode;
  version: number;
  description: string;
  tags: string[];
  parts: string[];
  slots: { id: string; required: boolean; hint?: string; type?: string }[];
  tokens: string[];
  etag: string;
}

export interface TemplateFull extends TemplateSummary {
  html: string;
}

export interface NoteDiff {
  html: string;
  tables: { table: string; row: string; column: string; old: number | null; new: number | null }[];
  summary: string;
}

export const notesApi = {
  summary: (id: string) => api<NoteSummary>(`/notes/${id}`),
  document: (id: string, version?: number) => api<NoteDocument>(version ? `/notes/${id}/versions/${version}` : `/notes/${id}/document`),
  context: (id: string) => api<TemplateContext>(`/notes/${id}/context`),
  async save(id: string, version: number, body: { doc: PMNode; mode: EditorMode; clientId: string }, force = false): Promise<SaveResult> {
    return api<SaveResult>(`/notes/${id}/document`, { method: 'PUT', headers: { 'if-match': `"${version}"` }, query: force ? { force: true } : undefined, body });
  },
  versions: (id: string) => api<VersionRow[]>(`/notes/${id}/versions`),
  snapshot: (id: string, label?: string) => api<{ version: number }>(`/notes/${id}/versions`, { method: 'POST', body: { label } }),
  restore: (id: string, v: number) => api<{ version: number }>(`/notes/${id}/versions/${v}/restore`, { method: 'POST' }),
  diff: (id: string, from: number, to: number) => api<NoteDiff>(`/notes/${id}/diff`, { query: { from, to } }),
  validate: (id: string) => api<ValidationResult>(`/notes/${id}/validate`),
  lock: (id: string) => api<LockInfo>(`/notes/${id}/lock`, { method: 'POST' }),
  lockStatus: (id: string) => api<{ lock: LockInfo | null }>(`/notes/${id}/lock`),
  unlock: (id: string) => api<void>(`/notes/${id}/lock`, { method: 'DELETE' }),
  comments: (id: string) => api<CommentThread[]>(`/notes/${id}/comments`),
  createComment: (id: string, anchorText: string, body: string) => api<{ id: string }>(`/notes/${id}/comments`, { method: 'POST', body: { anchorText, body } }),
  reply: (id: string, cid: string, body: string) => api<{ id: string }>(`/notes/${id}/comments/${cid}/messages`, { method: 'POST', body: { body } }),
  setCommentStatus: (id: string, cid: string, status: 'open' | 'resolved') => api<{ ok: boolean }>(`/notes/${id}/comments/${cid}`, { method: 'PATCH', body: { status } }),
  deleteComment: (id: string, cid: string) => api<void>(`/notes/${id}/comments/${cid}`, { method: 'DELETE' }),
  list: (query: { billKey?: string; state?: string; assignee?: string } = {}) => api<NoteSummary[]>('/notes', { query }),
  forBill: (biennium: string, id: string) => api<NoteSummary[]>(`/bills/${biennium}/${id}/notes`),
  create: (body: Record<string, unknown>) => api<NoteSummary>('/notes', { method: 'POST', body }),
  templates: (query: { mode?: EditorMode; kind?: string; taxType?: string; impactType?: string; q?: string } = {}) => api<TemplateSummary[]>('/templates', { query }),
  template: (id: string) => api<TemplateFull>(`/templates/${id}`),
  async templatePreview(id: string, noteId?: string): Promise<string> {
    const url = new URL(`/api/v1/templates/${id}/preview`, window.location.origin);
    if (noteId) url.searchParams.set('noteId', noteId);
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'preview_failed', res.statusText);
    return res.text();
  },
  users: (role?: string) => api<{ userId: string; displayName: string; roles: string[]; divisions: string[] }[]>('/users', { query: { role } }),
};

/** Fetch-once hook with a reload handle. */
export function useResource<T>(load: (() => Promise<T>) | null, deps: unknown[]): { data: T | null; error: Error | null; loading: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!!load);
  const reload = useCallback(async () => {
    if (!load) return;
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

export function isConflict(err: unknown): err is ApiError & { body: { details: ConflictDetails } } {
  return err instanceof ApiError && err.status === 412 && !!(err.body as { details?: unknown } | undefined)?.details;
}

export function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
}

export const STATE_LABELS: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  'review.pending': 'Waiting for reviewer',
  'review.active': 'In review',
  changes_requested: 'Changes requested',
  'exec_review.pending': 'Waiting for executive review',
  'exec_review.active': 'In executive review',
  approved: 'Approved',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
};
