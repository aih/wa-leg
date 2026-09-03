// SearchBackend interface (design/research/search.md section 7.2) and the flat search document.
import type { Principal } from '../identity/index.js';

export type DocType = 'bill' | 'section' | 'amendment' | 'fiscal_note' | 'rcw_section' | 'template';

export interface SearchDoc {
  id: string;
  doc_type: DocType;
  bill_key?: string | null;
  biennium?: string | null;
  chamber?: string | null;
  type?: string | null;
  number?: number | null;
  bill_number?: string | null;
  bill_number_forms?: string[];
  display?: string | null;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  status_code?: number | null;
  committee?: { id?: string; name?: string; chamber?: string } | null;
  sponsors?: { people_id?: string; name?: string; last_name?: string; party?: string; district?: string; primary?: boolean }[];
  sponsor_names?: string | null;
  companion_bill_key?: string | null;
  version_code?: string | null;
  version_label?: string | null;
  version_codes?: string[];
  latest_version_code?: string | null;
  is_latest_version?: boolean | null;
  section_id?: string | null;
  section_no?: string | null;
  ordinal?: number | null;
  heading?: string | null;
  action?: string | null;
  rcw_cite?: string | null;
  rcw_chapter?: string | null;
  rcw_title?: string | null;
  rcw_cites?: string[];
  rcw_chapters?: string[];
  rcw_titles?: string[];
  text?: string | null;
  added_text?: string | null;
  struck_text?: string | null;
  body?: string | null;
  history_text?: string | null;
  last_action?: string | null;
  last_action_date?: string | null;
  next_hearing_date?: string | null;
  hearing_count?: number | null;
  has_fiscal_note?: boolean | null;
  fiscal_note_count?: number | null;
  fiscal_note_status?: string | null;
  fiscal_note_package_ids?: string[];
  assigned_user_ids?: string[];
  /** Amendments */
  amendment_id?: string | null;
  target_version_code?: string | null;
  amending_chamber?: string | null;
  kind?: string | null;
  sponsor?: string | null;
  drafter_number?: string | null;
  amd_number?: number | null;
  disposition?: string | null;
  disposition_date?: string | null;
  /** Fiscal notes */
  note_id?: string | null;
  source?: string | null;
  package_id?: string | null;
  ofm_kind?: string | null;
  note_version?: number | null;
  author_id?: string | null;
  reviewer_ids?: string[];
  /** RCW sections */
  cite?: string | null;
  caption?: string | null;
  affected_by?: { bill_key: string; version_code: string; action: string; display: string }[];
  affected_by_bill_keys?: string[];
  /** Templates */
  template_id?: string | null;
  name?: string | null;
  /** Common */
  url?: string | null;
  visibility: 'public' | 'restricted';
  allowed_roles: string[];
  allowed_user_ids: string[];
  suggest?: { input: string[]; weight?: number };
  updated_at: string;
  source_hash?: string | null;
}

export interface SearchFilters {
  biennium?: string;
  chamber?: string;
  type?: string[];
  status?: string[];
  committee?: string;
  sponsor?: string;
  has_fiscal_note?: boolean;
  fiscal_note_status?: string[];
  doc_type?: DocType[];
  rcw?: string;
  rcw_cites?: string[];
  rcw_chapters?: string[];
  rcw_titles?: string[];
  version_code?: string;
  date_from?: string;
  date_to?: string;
  assigned_to_me?: boolean;
  bill_key?: string;
}

export interface SearchRequest {
  q: string;
  filters: SearchFilters;
  page: number;
  size: number;
  sort: 'relevance' | 'date' | 'bill_number';
}

export interface SearchHit {
  id: string;
  doc_type: DocType;
  score: number;
  bill_key?: string | null;
  display?: string | null;
  title?: string | null;
  version_code?: string | null;
  version_label?: string | null;
  section_no?: string | null;
  heading?: string | null;
  status?: string | null;
  url?: string | null;
  highlight?: Record<string, string[]>;
  inner_hits?: { id: string; doc_type: DocType; section_no?: string | null; heading?: string | null; version_label?: string | null; url?: string | null; highlight?: Record<string, string[]> }[];
  extra?: Record<string, unknown>;
}

export interface Facet {
  key: string;
  count: number;
}

export interface SearchResult {
  hits: SearchHit[];
  facets: Record<string, Facet[]>;
  total: number;
  took_ms: number;
}

export interface Suggestion {
  kind: string;
  bill_key?: string;
  display?: string;
  label?: string;
  title?: string;
  status?: string;
  url?: string;
  note_id?: string;
}

export interface SearchBackend {
  readonly name: 'opensearch' | 'postgres';
  init(): Promise<void>;
  search(req: SearchRequest, principal: Principal): Promise<SearchResult>;
  suggest(q: string, biennium: string, principal: Principal, size: number): Promise<Suggestion[]>;
  /** Fetch documents by id (permission-filtered). */
  get(ids: string[], principal: Principal): Promise<SearchDoc[]>;
  /** Every document of the given types for one bill, permission-filtered, newest first, no collapse. */
  listByBill(billKey: string, docTypes: DocType[], principal: Principal, size?: number): Promise<SearchDoc[]>;
  index(docs: SearchDoc[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  removeWhere(filter: { bill_key?: string; doc_type?: DocType; note_id?: string }): Promise<void>;
  refresh(): Promise<void>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

/** Permission clause inputs derived from the principal; the client never supplies these. */
export function permissionTerms(p: Principal): { roles: string[]; userId: string } {
  return { roles: p.roles, userId: p.userId };
}
