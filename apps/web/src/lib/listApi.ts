import type { WorkflowState } from '@wa-leg/workflow-machine';
import { api } from './api';

/** One row of `GET /notes` and `GET /bills/{b}/{id}/notes`. */
export interface NoteRow {
  noteRevisionId: string;
  noteId: string;
  billKey: string;
  biennium: string;
  billId: string;
  billTitle?: string;
  versionCode: string;
  versionLabel: string;
  state: WorkflowState;
  drafter: { userId: string; displayName?: string } | null;
  reviewer: { userId: string; displayName?: string } | null;
  headVersion: number;
  approvedVersion: number | null;
  publishedAt: string | null;
  publishedBy: { userId: string; displayName?: string } | null;
  publishedVersion: number | null;
  templateId: string | null;
  templateVersion: number | null;
  mode: 'limited' | 'full';
  editable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserRow {
  userId: string;
  displayName: string;
  email: string | null;
  roles: string[];
  divisions: string[];
}

// WP6: replace with the generated type
export interface PublishedItem {
  revisionId: string;
  bill: { biennium: string; billId: string; number: string; title: string };
  versionCode: string;
  title: string;
  publishedAt: string;
  publishedBy: { userId: string; displayName: string };
  publishedVersion: number;
  exports: { pdf: string; docx: string; html: string; xml: string };
}

// WP6: replace with the generated type
export interface PublishedPage {
  items: PublishedItem[];
  nextCursor: string | null;
}

/** Every note the caller may see: reviewers all of them, drafters their own, viewers the published ones. */
export function listNotes(): Promise<NoteRow[]> {
  return api<NoteRow[]>('/notes', { query: { size: 200 } });
}

export function listUsers(role: string): Promise<UserRow[]> {
  return api<UserRow[]>('/users', { query: { role } });
}

export function listPublished(cursor?: string | null): Promise<PublishedPage> {
  return api<PublishedPage>('/published', { query: { cursor: cursor ?? undefined } });
}
