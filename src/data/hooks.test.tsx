import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePolling } from './hooks';
import { loadIncidentsView, type IncidentWithState } from './reads';

// A chainable, awaitable mock of the SDK query builder. It records every method
// call (including any write methods) so a test can prove the console only ever
// reads — never enqueues a job — when it resumes from server state.
type Resp = { data: unknown; error: unknown };
function makeClient(responses: (table: string) => Resp) {
  const calls: { table: string; method: string }[] = [];
  const writeMethods = new Set<string>();
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'maybeSingle', 'insert', 'update', 'delete']) {
      chain[m] = (..._args: unknown[]) => {
        calls.push({ table, method: m });
        if (m === 'insert' || m === 'update' || m === 'delete') writeMethods.add(m);
        return chain;
      };
    }
    (chain as { then: unknown }).then = (resolve: (r: Resp) => void) => resolve(responses(table));
    return chain;
  }
  const client = {
    database: {
      from(table: string) {
        calls.push({ table, method: 'from' });
        return builder(table);
      },
    },
  } as never;
  return { client, calls, writeMethods };
}

const RUNNING_INCIDENTS = [
  {
    id: 'inc-1',
    title: 'github-webhook error rate climbing',
    service_name: 'github-webhook',
    alert_state: 'firing',
    incident_state: 'active',
    started_automatically: true,
    investigation_job_id: 'job-1',
    started_at: '2026-06-06T14:44:00Z',
    resolved_at: null,
    updated_at: '2026-06-06T14:45:00Z',
  },
];
const RUNNING_JOB = [
  { id: 'job-1', job_type: 'incident_investigation', state: 'running', progress_version: 2, phases: [], attempts: [] },
];

function incidentsResponder(table: string): Resp {
  if (table === 'incidents') return { data: RUNNING_INCIDENTS, error: null };
  if (table === 'jobs') return { data: RUNNING_JOB, error: null };
  return { data: [], error: null };
}

const anyInvestigating = (rows: IncidentWithState[]) => rows.some((r) => r.display === 'investigating');

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
});

describe('usePolling — resume from durable state without enqueueing', () => {
  it('reads the persisted running job state and never issues a write', async () => {
    const { client, calls, writeMethods } = makeClient(incidentsResponder);
    const { result, unmount } = renderHook(() =>
      usePolling(() => loadIncidentsView('active', client), { isActive: anyInvestigating, intervalMs: 25 }),
    );
    cleanup = unmount;

    await waitFor(() => expect(result.current.loading).toBe(false));

    // The incident resumed as "investigating" purely from the stored job state.
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].display).toBe('investigating');

    // Critically: loading the view enqueued nothing — only reads were issued.
    expect(writeMethods.size).toBe(0);
    expect(calls.some((c) => c.table === 'incidents' && c.method === 'from')).toBe(true);
    expect(calls.some((c) => c.table === 'jobs' && c.method === 'from')).toBe(true);
  });

  it('keeps polling while work is active, still without any write', async () => {
    const { client, calls, writeMethods } = makeClient(incidentsResponder);
    const { result, unmount } = renderHook(() =>
      usePolling(() => loadIncidentsView('active', client), { isActive: anyInvestigating, intervalMs: 20 }),
    );
    cleanup = unmount;

    await waitFor(() => expect(result.current.loading).toBe(false));
    const firstReads = calls.filter((c) => c.table === 'incidents' && c.method === 'from').length;

    // A second poll cycle fires because the job is still running.
    await waitFor(() => {
      const reads = calls.filter((c) => c.table === 'incidents' && c.method === 'from').length;
      expect(reads).toBeGreaterThan(firstReads);
    });
    expect(writeMethods.size).toBe(0);
  });

  it('keeps polling through a transient error while work is active', async () => {
    let calls = 0;
    const loader = vi.fn(async () => {
      calls += 1;
      if (calls === 2) return { data: undefined as unknown as string[], error: 'boom' };
      return { data: ['active'] as string[], error: null };
    });
    const isActive = (d: string[]) => Array.isArray(d) && d.includes('active');
    const { result, unmount } = renderHook(() => usePolling(loader, { isActive, intervalMs: 12 }));
    cleanup = unmount;

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(['active']);

    // A failed poll must NOT freeze the live view — it keeps scheduling ticks.
    await waitFor(() => expect(loader.mock.calls.length).toBeGreaterThanOrEqual(3));
    // The last good data is retained across the transient error.
    expect(result.current.data).toEqual(['active']);
  });

  it('does not poll again once work is no longer active', async () => {
    const idleResponder = (table: string): Resp =>
      table === 'incidents'
        ? { data: [{ ...RUNNING_INCIDENTS[0], investigation_job_id: null }], error: null }
        : { data: [], error: null };
    const { client, calls } = makeClient(idleResponder);
    const { result, unmount } = renderHook(() =>
      usePolling(() => loadIncidentsView('active', client), { isActive: anyInvestigating, intervalMs: 15 }),
    );
    cleanup = unmount;

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.[0].display).toBe('new');
    const reads = calls.filter((c) => c.table === 'incidents' && c.method === 'from').length;

    await new Promise((r) => setTimeout(r, 60));
    // No further polls: an incident with no job is not "active work".
    expect(calls.filter((c) => c.table === 'incidents' && c.method === 'from').length).toBe(reads);
  });
});
