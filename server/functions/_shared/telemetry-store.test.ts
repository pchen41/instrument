// Deterministic contract tests for the Deno-edge telemetry store (Task 5D review
// fix). Codex/Claude flagged that the unique-conflict→lookup branch and the NOT
// NULL insert payload were only exercised by the one-off live smoke. This fakes
// the PostgREST surface (insert returns {error:{code:'23505'}} on conflict; a
// follow-up select returns the existing row) so both reserve branches + the
// finish error path are covered without a live DB.
import { describe, expect, it, vi } from 'vitest';
import { createTelemetryStore } from './telemetry-store';
import { buildEmission, type EmissionRecord } from '../../lib/telemetry';

const REC: EmissionRecord = buildEmission(
  { service: 'instrument', environment: 'production' },
  {
    kind: 'retry',
    workspaceId: 'ws-1',
    jobId: 'job-1',
    jobType: 'incident_investigation',
    attempt: 1,
    error: { retryable: true, code: 'rate_limited', summary: 'rate limited', source: 'truefoundry' },
    source: 'truefoundry',
    traceId: 'tr-1',
    requestId: 'rq-1',
  },
);

interface MockOpts {
  insertError?: { code: string } | null;
  existingRow?: { id: string; emission_state: string } | null;
  integrationId?: string | null;
  updateError?: { code: string } | null;
  onInsert?: (row: Record<string, unknown>) => void;
  onUpdate?: (patch: Record<string, unknown>, id: string) => void;
}

// Minimal thenable PostgREST builder covering exactly the call shapes the store uses.
function mockAdmin(opts: MockOpts) {
  function builder(table: string) {
    const state: { op?: string; patch?: Record<string, unknown>; id?: string } = {};
    const b: Record<string, unknown> = {};
    b.insert = (rows: Record<string, unknown>[]) => { state.op = 'insert'; opts.onInsert?.(rows[0]); return b; };
    b.update = (patch: Record<string, unknown>) => { state.op = 'update'; state.patch = patch; return b; };
    b.select = () => { if (state.op !== 'insert') state.op = 'select'; return b; };
    b.eq = (k: string, v: string) => { if (k === 'id') state.id = v; return b; };
    b.limit = () => b;
    b.maybeSingle = () => b;
    b.then = (resolve: (r: { data: unknown; error: unknown }) => unknown) => {
      if (state.op === 'insert') return resolve({ data: opts.insertError ? null : [{ id: 'new-1' }], error: opts.insertError ?? null });
      if (state.op === 'update') { opts.onUpdate?.(state.patch ?? {}, state.id ?? ''); return resolve({ data: null, error: opts.updateError ?? null }); }
      if (table === 'integrations') return resolve({ data: opts.integrationId ? { id: opts.integrationId } : null, error: null });
      return resolve({ data: opts.existingRow ?? null, error: null }); // telemetry_emissions conflict lookup
    };
    return b;
  }
  return { database: { from: (t: string) => builder(t) } };
}

describe('createTelemetryStore.reserve', () => {
  it('fresh insert: resolves integration_id and writes a schema-complete running row', async () => {
    let inserted: Record<string, unknown> | undefined;
    const admin = mockAdmin({ integrationId: 'int-tf', onInsert: (r) => (inserted = r) });
    const res = await createTelemetryStore(admin).reserve(REC);
    expect(res).toEqual({ id: 'new-1', alreadySucceeded: false });
    // NOT NULL columns all present; integration resolved from the truefoundry tag.
    expect(inserted).toMatchObject({
      workspace_id: 'ws-1',
      metric_name: 'instrument.job.retry',
      value: 1,
      emission_state: 'running',
      idempotency_key: 'job-1:attempt-1',
      integration_id: 'int-tf',
    });
    expect(inserted!.tags).toBeTruthy();
    expect(inserted!.created_at).toBeTruthy();
  });

  it('unique conflict on an already-succeeded row → alreadySucceeded:true (skip Datadog)', async () => {
    const admin = mockAdmin({ insertError: { code: '23505' }, existingRow: { id: 'old-1', emission_state: 'succeeded' }, integrationId: 'int-tf' });
    expect(await createTelemetryStore(admin).reserve(REC)).toEqual({ id: 'old-1', alreadySucceeded: true });
  });

  it('unique conflict on a non-succeeded row → alreadySucceeded:false (re-attempt allowed)', async () => {
    const admin = mockAdmin({ insertError: { code: '23505' }, existingRow: { id: 'old-1', emission_state: 'running' }, integrationId: 'int-tf' });
    expect(await createTelemetryStore(admin).reserve(REC)).toEqual({ id: 'old-1', alreadySucceeded: false });
  });

  it('integration tag that resolves to no row → integration_id null (column is nullable)', async () => {
    let inserted: Record<string, unknown> | undefined;
    const admin = mockAdmin({ integrationId: null, onInsert: (r) => (inserted = r) });
    await createTelemetryStore(admin).reserve(REC);
    expect(inserted!.integration_id).toBeNull();
  });
});

describe('createTelemetryStore.finish', () => {
  it('applies the update', async () => {
    const onUpdate = vi.fn();
    const admin = mockAdmin({ onUpdate });
    await createTelemetryStore(admin).finish('row-9', 'succeeded', '2026-06-06T00:00:00.000Z');
    expect(onUpdate).toHaveBeenCalledWith({ emission_state: 'succeeded', emitted_at: '2026-06-06T00:00:00.000Z' }, 'row-9');
  });

  it('does not throw when the update errors (stuck-running is logged, not fatal)', async () => {
    const admin = mockAdmin({ updateError: { code: 'PGRST500' } });
    await expect(createTelemetryStore(admin).finish('row-9', 'succeeded', null)).resolves.toBeUndefined();
  });
});
