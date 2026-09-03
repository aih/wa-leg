import { useEffect, useState } from 'react';
import type { AmendmentDocument, BillDocument, VersionDiff } from '@wa-leg/bill-document/browser';
import { api, type ApiError } from '../lib/api';

export interface VersionRow {
  code: string;
  label: string;
  shortLabel: string;
  seq: number;
  status: string;
  date?: string;
  amendmentIds: string[];
  sourceUrls: { xml?: string; pdf?: string; htm?: string };
}

export interface HearingRow {
  id: string;
  billKey: string;
  versionCode?: string;
  committee: string;
  chamber?: string;
  kind: string;
  hearingAt: string;
  location?: string;
  description?: string;
  cancelled: boolean;
}

export interface BillSummary {
  billKey: string;
  biennium: string;
  id: string;
  type: string;
  number: number;
  chamber: string;
  title: string;
  description?: string;
  status?: string;
  statusDate?: string;
  sponsors: { name?: string; role?: string; party?: string; district?: string; committee_sponsor?: number }[];
  committee?: { name?: string; chamber?: string };
  currentVersionCode: string;
  versions: VersionRow[];
  hearings: HearingRow[];
  priorFiscalNotes: { id: string; packageId?: number; label: string; versionLabel?: string; kind?: string; url: string; publishedAt?: string }[];
  companion?: { billKey: string; id: string; title?: string } | null;
  rcwAffected: unknown[];
  history: { date: string; action: string; chamber: string }[];
  updatedAt: string;
}

export interface Loaded<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
}

export function useResource<T>(key: string | null, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null, loading: !!key });
  useEffect(() => {
    if (!key) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    load().then(
      (data) => !cancelled && setState({ data, error: null, loading: false }),
      (error) => !cancelled && setState({ data: null, error, loading: false }),
    );
    return () => {
      cancelled = true;
    };
  }, [key]);
  return state;
}

export function fetchBill(biennium: string, id: string): Promise<BillSummary> {
  return api<BillSummary>(`/bills/${biennium}/${id}`);
}

export function fetchVersion(biennium: string, id: string, code: string): Promise<BillDocument & { resolvedCode: string }> {
  return api<BillDocument & { resolvedCode: string }>(`/bills/${biennium}/${id}/versions/${encodeURIComponent(code)}`);
}

export function fetchDiff(biennium: string, id: string, from: string, to: string, mode: 'as-printed' | 'effect' = 'as-printed'): Promise<VersionDiff> {
  return api<VersionDiff>(`/bills/${biennium}/${id}/diff`, { query: { from, to, mode } });
}

export function fetchAmendment(biennium: string, id: string, amendmentId: string): Promise<AmendmentDocument> {
  return api<AmendmentDocument>(`/bills/${biennium}/${id}/amendments/${encodeURIComponent(amendmentId)}`);
}

export function useBill(biennium: string | undefined, id: string | undefined): Loaded<BillSummary> {
  return useResource(biennium && id ? `${biennium}/${id}` : null, () => fetchBill(biennium!, id!));
}

export function useVersion(biennium: string | undefined, id: string | undefined, code: string | undefined): Loaded<BillDocument & { resolvedCode: string }> {
  return useResource(biennium && id && code ? `${biennium}/${id}/${code}` : null, () => fetchVersion(biennium!, id!, code!));
}
