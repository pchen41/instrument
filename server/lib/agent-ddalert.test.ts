import { describe, expect, it, vi } from 'vitest';
import { makeDdAlertExecutor, ddAlertJobContext, type DdAlertMcp, type DdAlertPlan, type DdAlertStore } from './agent-ddalert';
import { ddMonitorSpecSchema } from './datadog-alert';
import type { JobRow } from './types';

function job(over: Partial<JobRow> = {}): JobRow {
  return { id: 'dd-1', workspace_id: 'ws-1', job_type: 'datadog_alert_generation', target_id: 'rec-1', target_type: 'recommendation', target_step_key: 'create-monitor', trigger_summary: { source: 'approval', approval_id: 'appr-1' }, ...over } as any as JobRow;
}
const spec = () => ddMonitorSpecSchema.parse({ metric_name: 'instrument.job.retry', monitor_type: 'metric alert', name: 'Retry rate', query: 'avg(last_5m):avg:instrument.job.retry{*} > 5' });
function plan(over: Partial<DdAlertPlan> = {}): DdAlertPlan {
  return { approvalState: 'approved', approvedPayloadHash: 'HASH', recommendationTitle: 'Alert on retry rate', prerequisiteStepDone: false, spec: spec(), ...over };
}

function fakeMcp(over: { exists?: boolean; existing?: { id: number; url: string } | null } = {}): DdAlertMcp & { created: number } {
  const self: any = {
    created: 0,
    metricExists: vi.fn(async () => over.exists ?? true),
    createMonitor: vi.fn(async () => { self.created++; return { id: 4242, url: 'https://us5.datadoghq.com/monitors/4242' }; }),
    findMonitorByTag: vi.fn(async () => over.existing ?? null),
  };
  return self;
}

function fakeStore(over: { approvalState?: string } = {}) {
  const writes = new Map<string, { id: string; state: string; externalId: string | null; externalUrl: string | null; key: string }>();
  const events = { stepStates: [] as string[], verification: [] as string[], monitor: null as any, inserted: [] as string[] };
  let seq = 0;
  const store: DdAlertStore = {
    loadPlan: async () => plan({ approvalState: over.approvalState ?? 'approved' }),
    setStepState: async (_r, _s, state) => { events.stepStates.push(state); },
    setMetricVerification: async (_r, _s, state) => { events.verification.push(state); },
    setGeneratedMonitor: async (_r, _s, m) => { events.monitor = m; },
    findExternalWrite: async (_w, key) => { for (const v of writes.values()) if (v.key === key) return v; return null; },
    insertExternalWrite: async (i) => { const id = `w-${++seq}`; writes.set(id, { id, state: 'planned', externalId: null, externalUrl: null, key: i.idempotencyKey }); events.inserted.push(i.actionKind); return id; },
    markExternalWrite: async (id, p) => { const v = writes.get(id); if (v) writes.set(id, { ...v, state: p.state, externalId: p.externalId ?? v.externalId, externalUrl: p.externalUrl ?? v.externalUrl }); },
  };
  return { store, writes, events };
}

const deps = (mcp: DdAlertMcp, store: DdAlertStore) => ({ mcp, store });

describe('ddAlertJobContext', () => {
  it('lifts the approval + recommendation + step', () => {
    expect(ddAlertJobContext(job())).toMatchObject({ recommendationId: 'rec-1', stepKey: 'create-monitor', approvalId: 'appr-1' });
  });
});

describe('inspect — metric verification gate', () => {
  it('verifies an existing metric and sets the step generating', async () => {
    const mcp = fakeMcp({ exists: true });
    const { store, events } = fakeStore();
    await makeDdAlertExecutor(deps(mcp, store))({ job: job(), phaseKey: 'inspect', attempt: 1 });
    expect(events.verification).toContain('verified_in_datadog');
    expect(events.stepStates).toContain('generating');
  });

  it('REFUSES to proceed when the metric is unverified (no metric, no prerequisite)', async () => {
    const mcp = fakeMcp({ exists: false });
    const { store, events } = fakeStore();
    await expect(makeDdAlertExecutor(deps(mcp, store))({ job: job(), phaseKey: 'inspect', attempt: 1 })).rejects.toThrow(/unverified|does not exist/);
    expect(events.verification).toContain('unverified');
    expect(events.stepStates).toContain('failed');
  });

  it('refuses an unapproved approval before touching Datadog', async () => {
    const mcp = fakeMcp();
    const { store } = fakeStore({ approvalState: 'revoked' });
    await expect(makeDdAlertExecutor(deps(mcp, store))({ job: job(), phaseKey: 'inspect', attempt: 1 })).rejects.toThrow(/approved/);
    expect(mcp.metricExists).not.toHaveBeenCalled();
  });
});

describe('draft_monitor — approval-gated create', () => {
  it('creates one draft monitor, records the external write, and links it on the step', async () => {
    const mcp = fakeMcp();
    const { store, events } = fakeStore();
    await makeDdAlertExecutor(deps(mcp, store))({ job: job(), phaseKey: 'draft_monitor', attempt: 1 });
    expect(mcp.created).toBe(1);
    expect(events.inserted).toEqual(['datadog_create_monitor']);
    expect(events.monitor).toMatchObject({ monitor_id: 4242, draft: true, url: expect.stringContaining('/monitors/4242') });
  });

  it('is idempotent on resume: a succeeded write is not re-created', async () => {
    const mcp = fakeMcp();
    const { store } = fakeStore();
    await makeDdAlertExecutor(deps(mcp, store))({ job: job(), phaseKey: 'draft_monitor', attempt: 1 });
    await makeDdAlertExecutor(deps(mcp, store))({ job: job(), phaseKey: 'draft_monitor', attempt: 2 });
    expect(mcp.created).toBe(1); // not 2
  });

  it('re-enforces the metric gate in draft_monitor too (defense in depth)', async () => {
    const mcp = fakeMcp({ exists: false });
    const { store } = fakeStore();
    await expect(makeDdAlertExecutor(deps(mcp, store))({ job: job(), phaseKey: 'draft_monitor', attempt: 1 })).rejects.toThrow(/unverified|refusing/);
    expect(mcp.created).toBe(0); // never created on an unverified metric
  });

  it('recovers an already-created monitor by marker tag instead of duplicating', async () => {
    const mcp = fakeMcp({ existing: { id: 999, url: 'https://us5.datadoghq.com/monitors/999' } });
    const { store, events } = fakeStore();
    await makeDdAlertExecutor(deps(mcp, store))({ job: job(), phaseKey: 'draft_monitor', attempt: 1 });
    expect(mcp.created).toBe(0); // recovered, not created
    expect(events.monitor).toMatchObject({ monitor_id: 999 });
  });
});

describe('validate', () => {
  it('leaves the step ready (a human publishes the draft)', async () => {
    const { store, events } = fakeStore();
    await makeDdAlertExecutor(deps(fakeMcp(), store))({ job: job(), phaseKey: 'validate', attempt: 1 });
    expect(events.stepStates).toContain('ready');
  });
});
