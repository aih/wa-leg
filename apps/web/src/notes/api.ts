import { useCallback, useEffect, useState } from 'react';
import type { EstimateData, PMNode, ValidationResult } from '@wa-leg/note-schema';
import { EVENT_LABELS as MACHINE_EVENT_LABELS, STATE_HINTS as MACHINE_STATE_HINTS, STATE_LABELS as MACHINE_STATE_LABELS, type EventType, type WorkflowState } from '@wa-leg/workflow-machine';
import { api, ApiError } from '../lib/api';

export type EditorMode = 'limited' | 'full';

export interface UserRef {
  userId: string;
  displayName?: string;
}

export interface NoteSummary {
  noteRevisionId: string;
  noteId: string;
  billKey: string;
  biennium: string;
  billId: string;
  billTitle?: string;
  versionCode: string;
  versionLabel: string;
  state: WorkflowState;
  drafter: UserRef | null;
  reviewer: UserRef | null;
  headVersion: number;
  approvedVersion: number | null;
  publishedAt: string | null;
  publishedBy: UserRef | null;
  publishedVersion: number | null;
  templateId: string | null;
  templateVersion: number | null;
  mode: EditorMode;
  /** True while the state allows editing; the client also checks that the caller is the drafter. */
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

export type ExportFormat = 'pdf' | 'docx' | 'html' | 'xml';
export const EXPORT_FORMATS: { format: ExportFormat; label: string }[] = [
  { format: 'pdf', label: 'PDF' },
  { format: 'docx', label: 'DOCX' },
  { format: 'html', label: 'HTML' },
  { format: 'xml', label: 'XML' },
];

export const exportUrl = (id: string, format: ExportFormat) => `/api/v1/notes/${id}/export?format=${format}`;

export const notesApi = {
  summary: (id: string) => api<NoteSummary>(`/notes/${id}`),
  document: (id: string, version?: number) => api<NoteDocument>(version ? `/notes/${id}/versions/${version}` : `/notes/${id}/document`),
  save: (id: string, version: number, body: { doc: PMNode; mode: EditorMode; clientId: string }) => api<SaveResult>(`/notes/${id}/document`, { method: 'PUT', headers: { 'if-match': `"${version}"` }, body }),
  versions: (id: string) => api<VersionRow[]>(`/notes/${id}/versions`),
  comments: (id: string) => api<CommentThread[]>(`/notes/${id}/comments`),
  createComment: (id: string, anchorText: string, body: string) => api<{ id: string }>(`/notes/${id}/comments`, { method: 'POST', body: { anchorText, body } }),
  reply: (id: string, cid: string, body: string) => api<{ id: string }>(`/notes/${id}/comments/${cid}/messages`, { method: 'POST', body: { body } }),
  setCommentStatus: (id: string, cid: string, status: 'open' | 'resolved') => api<{ ok: boolean }>(`/notes/${id}/comments/${cid}`, { method: 'PATCH', body: { status } }),
  deleteComment: (id: string, cid: string) => api<void>(`/notes/${id}/comments/${cid}`, { method: 'DELETE' }),
  list: (query: { billKey?: string; state?: string } = {}) => api<NoteSummary[]>('/notes', { query }),
  forBill: (biennium: string, id: string) => api<NoteSummary[]>(`/bills/${biennium}/${id}/notes`),
  create: (body: { billKey: string; versionCode: string; templateId: string; drafterId?: string }) => api<NoteSummary>('/notes', { method: 'POST', body }),
  templates: (query: { mode?: EditorMode; kind?: string; taxType?: string; impactType?: string; q?: string } = {}) => api<TemplateSummary[]>('/templates', { query }),
  template: (id: string) => api<TemplateFull>(`/templates/${id}`),
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

/** True for the 412 a save gets when the head version moved. */
export function isConflict(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 412;
}

export function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
}

/** Status words and hints, one vocabulary for every screen. Widened to string keys for rows typed by the API as plain strings. */
export const STATE_LABELS: Record<string, string> = { ...MACHINE_STATE_LABELS };
export const STATE_HINTS: Record<string, string> = { ...MACHINE_STATE_HINTS };
export const EVENT_LABELS: Record<string, string> = { ...MACHINE_EVENT_LABELS };

// ---- workflow ----

export interface WorkflowView {
  instanceId: string;
  noteRevisionId: string;
  state: WorkflowState;
  version: number;
  drafter: UserRef | null;
  reviewer: UserRef | null;
  availableEvents: { type: EventType; label: string }[];
  changeRequest: { message: string; by: UserRef; at: string } | null;
  editable: boolean;
  updatedAt: string;
}

export interface TransitionRow {
  seq: number;
  event: string;
  fromState: string;
  toState: string;
  actorId: string;
  actorName?: string | null;
  comment: string | null;
  occurredAt: string;
}

export const workflowApi = {
  view: (id: string) => api<WorkflowView>(`/notes/${id}/workflow`),
  transitions: (id: string) => api<TransitionRow[]>(`/notes/${id}/transitions`),
  send: (id: string, body: { event: EventType; message?: string; expectedVersion?: number }) => api<{ instanceId: string; state: WorkflowState; version: number; seq: number }>(`/notes/${id}/workflow`, { method: 'POST', body }),
};
