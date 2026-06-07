// React data hooks for the console. Every hook reads through the authenticated
// @insforge/sdk client (RLS-scoped) and resumes from durable server state on
// mount, so a browser refresh restores what was on screen without re-running any
// job — these hooks only ever read. While active work is visible (an
// investigation in flight, a step generating) usePolling re-reads on an
// interval; otherwise it loads once and refetches when the tab regains focus.
import { useCallback, useEffect, useRef, useState } from 'react';
import { insforge } from '../lib/insforge';
import {
  getIncidentDetail,
  getWorkspaceSettings,
  isActiveJobState,
  listIntegrations,
  loadActiveRecommendations,
  loadArchivedRecommendations,
  loadIncidentsView,
  type IncidentDetail,
  type IncidentWithState,
  type IntegrationHealth,
  type JobSummary,
  type EvidenceItem,
  type RecommendationCard,
  type WorkspaceSettings,
} from './reads';

type Client = typeof insforge;

// Default poll cadence while work is active. Fast enough that a running
// investigation feels live, only active while there is in-flight work to watch.
export const DEFAULT_POLL_MS = 2000;

export interface PollResult<T> {
  /** Latest successful payload, or null before the first load resolves. */
  data: T | null;
  error: unknown;
  /** True only during the first load (no data yet) — gate skeletons on this. */
  loading: boolean;
  /** True while a poll/refetch runs over already-rendered data. */
  refreshing: boolean;
  /** Wall-clock ms of the last successful load (drives the "Updated" flash). */
  lastUpdatedAt: number | null;
  /** Re-read now; resolves once the load settles (so callers can sequence on it). */
  refetch: () => Promise<void>;
}

export interface PollOptions<T> {
  intervalMs?: number;
  /** Re-poll only while this returns true for the latest data. */
  isActive?: (data: T) => boolean;
  enabled?: boolean;
  /** Changing this restarts the resource from a fresh loading state. */
  resetKey?: string;
}

/**
 * Generic poll-while-active resource. `loader` returns `{ data, error }`; it is
 * read through a ref so callers can pass an inline closure without resubscribing.
 */
export function usePolling<T>(loader: () => Promise<{ data: T; error: unknown }>, options: PollOptions<T> = {}): PollResult<T> {
  const { intervalMs = DEFAULT_POLL_MS, isActive, enabled = true, resetKey } = options;

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const hasData = useRef(false);
  // Last known "is there active work" answer from a *successful* load, so a
  // transient poll error keeps the live view refreshing instead of freezing.
  const wasActive = useRef(false);

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const run = useCallback(async () => {
    clearTimer(); // cancel any pending tick so a manual refetch/focus doesn't double-fire
    const id = ++seq.current;
    if (hasData.current) setRefreshing(true);
    let res: { data: T; error: unknown };
    try {
      res = await loaderRef.current();
    } catch (err) {
      res = { data: undefined as unknown as T, error: err };
    }
    if (!mounted.current || id !== seq.current) return; // stale or unmounted

    let active: boolean;
    if (res.error) {
      setError(res.error);
      // Keep polling through a transient blip only if work was active before.
      active = wasActive.current;
    } else {
      setError(null);
      setData(res.data);
      hasData.current = true;
      setLastUpdatedAt(Date.now());
      active = !!isActiveRef.current?.(res.data);
      wasActive.current = active;
    }
    setLoading(false);
    setRefreshing(false);

    clearTimer();
    if (enabled && active) {
      timer.current = setTimeout(() => void run(), intervalMs);
    }
  }, [enabled, intervalMs]);

  useEffect(() => {
    mounted.current = true;
    hasData.current = false;
    wasActive.current = false;
    seq.current++; // invalidate any in-flight load from a previous resetKey
    setLoading(true);
    setData(null);
    setError(null); // don't carry a previous scope's error into the new resource
    if (enabled) void run();
    return () => {
      mounted.current = false;
      clearTimer();
    };
    // resetKey deliberately restarts the resource (scope / id changed).
  }, [run, enabled, resetKey]);

  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [run, enabled]);

  const refetch = useCallback(() => run(), [run]);
  return { data, error, loading, refreshing, lastUpdatedAt, refetch };
}

// ---- View hooks -------------------------------------------------------------

// The list views poll continuously so new incidents / recommendations created in
// the background (alerts, proactive scans) appear without a manual refresh.
const ALWAYS_ACTIVE = () => true;

/** Active or resolved incidents joined to investigation job state; polls for new items. */
export function useIncidentsView(scope: 'active' | 'resolved', client: Client = insforge) {
  const loader = useCallback(() => loadIncidentsView(scope, client), [scope, client]);
  return usePolling<IncidentWithState[]>(loader, { isActive: ALWAYS_ACTIVE, resetKey: scope });
}

export interface IncidentDetailData {
  incident: IncidentDetail;
  job: JobSummary | null;
  evidence: EvidenceItem[];
}

/** Incident detail (incident + investigation job + evidence); polls while the job is in flight. */
export function useIncidentDetail(id: string, client: Client = insforge) {
  const loader = useCallback(() => getIncidentDetail(id, client), [id, client]);
  return usePolling<IncidentDetailData | null>(loader, {
    isActive: (d) => isActiveJobState(d?.job?.state ?? null),
    resetKey: id,
  });
}

/** Active (Open) or archived recommendations with steps; polls for new items + step updates. */
export function useRecommendationsView(scope: 'active' | 'archive', client: Client = insforge) {
  const loader = useCallback(
    () => (scope === 'active' ? loadActiveRecommendations(client) : loadArchivedRecommendations(client)),
    [scope, client],
  );
  return usePolling<RecommendationCard[]>(loader, { isActive: ALWAYS_ACTIVE, resetKey: scope });
}

/** Integration health. Loaded once and refetched on focus; not polled. */
export function useIntegrations(client: Client = insforge) {
  const loader = useCallback(async () => {
    const res = await listIntegrations(client);
    return { data: (res.data as unknown as IntegrationHealth[]) ?? [], error: res.error };
  }, [client]);
  return usePolling<IntegrationHealth[]>(loader, { isActive: () => false });
}

/** The caller's workspace settings (investigation-start mode). Loaded once. */
export function useWorkspaceSettings(client: Client = insforge) {
  const loader = useCallback(() => getWorkspaceSettings(client), [client]);
  return usePolling<WorkspaceSettings | null>(loader, { isActive: () => false });
}
