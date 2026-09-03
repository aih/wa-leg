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

export interface ChangeRequestItem {
  id: string;
  seq: number;
  commentId: string | null;
  threadStatus: 'open' | 'resolved' | null;
  anchorText: string | null;
  body: string;
  status: 'open' | 'addressed';
  addressedBy: string | null;
  addressedByName?: string;
  addressedAt: string | null;
  resolution: string | null;
  resolutionVersion: number | null;
}

export interface ChangeRequest {
  id: string;
  noteRevisionId: string;
  transitionSeq: number | null;
  event: string;
  requestedBy: string;
  requestedByName?: string;
  requestedAt: string;
  documentVersion: number | null;
  summary: string;
  status: 'open' | 'closed';
  closedBy: string | null;
  closedByName?: string;
  closedAt: string | null;
  resolution: string | null;
  resolutionVersion: number | null;
  openItems: number;
  items: ChangeRequestItem[];
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
  createRevision: (id: string, versionCode: string) => api<NoteSummary>(`/notes/${id}/revisions`, { method: 'POST', body: { versionCode } }),
  templates: (query: { mode?: EditorMode; kind?: string; taxType?: string; impactType?: string; q?: string } = {}) => api<TemplateSummary[]>('/templates', { query }),
  template: (id: string) => api<TemplateFull>(`/templates/${id}`),
  async templatePreview(id: string, noteId?: string): Promise<string> {
    const url = new URL(`/api/v1/templates/${id}/preview`, window.location.origin);
    if (noteId) url.searchParams.set('noteId', noteId);
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'preview_failed', res.statusText);
    return res.text();
  },
  changeRequests: (id: string) => api<ChangeRequest[]>(`/notes/${id}/change-requests`),
  addressItem: (id: string, crId: string, itemId: string, resolution: string) => api<{ ok: boolean }>(`/notes/${id}/change-requests/${crId}/items/${itemId}/address`, { method: 'POST', body: { resolution } }),
  reopenItem: (id: string, crId: string, itemId: string, reason?: string) => api<{ ok: boolean }>(`/notes/${id}/change-requests/${crId}/items/${itemId}/reopen`, { method: 'POST', body: { reason } }),
  closeChangeRequest: (id: string, crId: string, resolution: string) => api<{ ok: boolean }>(`/notes/${id}/change-requests/${crId}/close`, { method: 'POST', body: { resolution } }),
  audit: (id: string) => api<{ id: number; actorId: string; action: string; objectType: string; objectId: string; before: unknown; after: unknown; requestId: string | null; at: string }[]>(`/notes/${id}/audit`),
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

/**
 * One status vocabulary for every screen. The same note shows the same word on the drafter's dashboard, the
 * reviewer's dashboard and the workspace bar.
 */
export const STATE_LABELS: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  'review.pending': 'Ready for review',
  'review.active': 'In review',
  changes_requested: 'Changes requested',
  'exec_review.pending': 'Waiting for executive review',
  'exec_review.active': 'In executive review',
  approved: 'Approved',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
};

/** What the state means for the person reading it; shown as a hint beside the status. */
export const STATE_HINTS: Record<string, string> = {
  todo: 'Assigned; the drafter has not started',
  in_progress: 'The drafter is writing',
  'review.pending': 'Submitted; waiting for a reviewer to claim it',
  'review.active': 'A reviewer is reading it',
  changes_requested: 'Back with the drafter; see the Changes tab',
  'exec_review.pending': 'Approved by the reviewer; waiting for the executive chain',
  'exec_review.active': 'An executive reviewer is reading it',
  approved: 'Published beside the bill',
  cancelled: 'Withdrawn',
  superseded: 'Replaced by a revision for a newer bill version',
};

// ---- workflow and notifications (milestone 6) ----

export type DueBand = 'more_than_24h' | 'within_24h' | 'within_4h' | 'overdue' | 'none';

export interface WorkflowView {
  instanceId: string;
  noteRevisionId: string;
  state: string;
  version: number;
  drafterStatus: string;
  reviewerStatus: string;
  drafterId: string | null;
  reviewerId: string | null;
  execChain: { userId: string; division: string; dueAt: string | null; doneAt: string | null }[];
  execIndex: number;
  availableEvents: { type: string; label: string }[];
  deadlines: { kind: string; dueAt: string; warnAt: string; band: DueBand; breached: boolean }[];
  effectiveDueAt: string | null;
  supersededBy: string | null;
  duplicatedFrom: string | null;
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

export interface AssignmentRow {
  instanceId: string;
  noteRevisionId: string;
  billKey: string;
  versionCode: string;
  versionLabel: string;
  title: string | null;
  kind: 'note' | 'estimate';
  role: 'drafter' | 'reviewer' | 'exec';
  position: number;
  pool: boolean;
  status: string;
  state: string;
  priority: string;
  dueAt: string | null;
  effectiveDueAt: string | null;
  band: DueBand;
  nextHearingAt: string | null;
  assignedAt: string;
  updatedAt: string;
  counterpart: { userId: string; displayName?: string } | null;
  supersededBy: string | null;
  confidential: boolean;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface UnassignedHearing {
  id: string;
  billKey: string;
  biennium: string;
  billId: string;
  title: string;
  versionCode: string | null;
  committee: string;
  chamber: string | null;
  kind: string;
  hearingAt: string;
}

export const workflowApi = {
  view: (id: string) => api<WorkflowView>(`/notes/${id}/workflow`),
  transitions: (id: string) => api<TransitionRow[]>(`/notes/${id}/transitions`),
  send: (id: string, body: { event: string; comment?: string; expectedVersion?: number }) => api<{ state: string; version: number; seq: number }>(`/notes/${id}/transitions`, { method: 'POST', body }),
  assign: (id: string, body: { role: 'drafter' | 'reviewer' | 'exec'; userId: string; position?: number; dueAt?: string }) => api<{ state: string; version: number }>(`/notes/${id}/assign`, { method: 'POST', body }),
  setExecChain: (id: string, chain: { userId: string; division?: string; dueAt?: string | null }[]) => api<{ state: string; version: number }>(`/notes/${id}/exec-chain`, { method: 'PUT', body: { chain } }),
  assignments: (query: { assignee?: string; role?: string; status?: string; state?: string; all?: boolean } = {}) => api<AssignmentRow[]>('/assignments', { query }),
  summary: (query: { state?: string; drafter?: string; reviewer?: string } = {}) => api<Record<string, number>>('/workflow/summary', { query }),
  unassignedHearings: (withinHours = 72) => api<UnassignedHearing[]>('/workflow/unassigned-hearings', { query: { withinHours } }),
};

export const notificationsApi = {
  list: (unread = false) => api<Notification[]>('/notifications', { query: { unread } }),
  unreadCount: () => api<{ unread: number }>('/notifications/unread-count'),
  markRead: (id: string) => api<void>(`/notifications/${id}/read`, { method: 'POST' }),
  readAll: () => api<{ marked: number }>('/notifications/read-all', { method: 'POST' }),
};

export const BAND_LABELS: Record<DueBand, string> = {
  overdue: 'Overdue',
  within_4h: 'Due within 4 hours',
  within_24h: 'Due within 24 hours',
  more_than_24h: 'Due later',
  none: 'No deadline',
};

/** "Due in 3 h", "Overdue by 2 d", from an ISO time. */
export function dueCountdown(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'No deadline';
  const ms = new Date(iso).getTime() - now;
  const abs = Math.abs(ms);
  const unit = abs >= 48 * 3_600_000 ? `${Math.round(abs / 86_400_000)} d` : abs >= 3_600_000 ? `${Math.round(abs / 3_600_000)} h` : `${Math.max(1, Math.round(abs / 60_000))} min`;
  return ms < 0 ? `Overdue by ${unit}` : `Due in ${unit}`;
}

