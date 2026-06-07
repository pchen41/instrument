import { describe, expect, it, vi } from 'vitest';
import {
  type CoverageSnapshot,
  type LoadedFindings,
  type RecGenMcp,
  type RecGenStore,
  makeRecGenExecutor,
  recGenJobContext,
} from './agent-recgen';
import type { AlertFinding } from './alert-coverage';
import type { AgentInvoker, ModelCallStore } from './model-call';
import type { JobRow } from './types';

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: 'rg-1',
    workspace_id: 'ws-1',
    job_type: 'recommendation_generation',
    target_id: 'repo-1',
    target_type: 'repository',
    trigger_summary: { source: 'alert_coverage', repo: { owner: 'pchen41', name: 'instrument', full_name: 'pchen41/instrument' }, namespace: 'instrument', branch: 'main', head_sha: 'abc1234', scan_job_id: 'scan-1' },
    ...over,
  } as any as JobRow;
}

const newMonitorFinding = (over: Partial<AlertFinding> = {}): AlertFinding => ({ recommendation_type: 'new_monitor', title: 'Alert on errors', rationale: 'no monitor', severity: 'high', metric_name: 'instrument.job.error', monitor_type: 'metric alert', query: 'avg(last_5m):avg:instrument.job.error{*} > 3', ...over }) as AlertFinding;

function fakeMcp(over: { metrics?: string[]; monitors?: any[] } = {}): RecGenMcp & { metricReads: number; monitorReads: number } {
  const self: any = {
    metricReads: 0,
    monitorReads: 0,
    listMetrics: vi.fn(async () => { self.metricReads++; return over.metrics ?? ['instrument.job.retry', 'instrument.job.error']; }),
    listMonitors: vi.fn(async () => { self.monitorReads++; return over.monitors ?? [{ id: 1, name: 'retry rate', query: 'avg(last_5m):avg:instrument.job.retry{*} > 5', type: 'metric alert' }]; }),
  };
  return self;
}

function fakeStore(over: { coverage?: CoverageSnapshot | null; findings?: LoadedFindings | null; scanGaps?: string[] } = {}) {
  const coverageMap = new Map<string, CoverageSnapshot>();
  const findingsMap = new Map<string, LoadedFindings>();
  if (over.coverage) coverageMap.set('rg-1', over.coverage);
  if (over.findings) findingsMap.set('rg-1', over.findings);
  const recs = new Map<string, { id: string; created: boolean }>();
  const events = { upserts: [] as any[] };
  let seq = 0;
  const store: RecGenStore = {
    hasCoverage: async (j) => coverageMap.has(j),
    saveCoverage: async (i) => { coverageMap.set(i.jobId, i.snapshot); },
    loadCoverage: async (j) => coverageMap.get(j) ?? null,
    saveFindings: async (i) => { findingsMap.set(i.jobId, { modelCallId: i.modelCallId, validationStatus: i.validationStatus, findings: i.findings }); },
    loadFindings: async (j) => findingsMap.get(j) ?? null,
    loadScanGaps: async () => over.scanGaps ?? [],
    upsertAlertRecommendation: async (i) => { events.upserts.push(i); const ex = recs.get(i.dedupeFingerprint); if (ex) return { ...ex, created: false }; const r = { id: `rec-${++seq}`, created: true }; recs.set(i.dedupeFingerprint, r); return r; },
  };
  return { store, recs, events, coverageMap, findingsMap };
}

function fakeGateway(json: object): AgentInvoker {
  return { invoke: vi.fn(async () => ({ text: JSON.stringify(json), model: 'instrument/instrument', provider: 'truefoundry', latencyMs: 5 })) };
}
function fakeModelStore(): ModelCallStore {
  return { saveModelCall: vi.fn(async () => ({ id: 'mc-1', deduped: false })), saveEvidence: vi.fn(async () => {}) } as any;
}
const deps = (mcp: RecGenMcp, store: RecGenStore, gw?: AgentInvoker) => ({ mcp, store, gateway: gw ?? fakeGateway({ findings: [] }), modelStore: fakeModelStore() });
const validFindings = (findings: AlertFinding[]): LoadedFindings => ({ modelCallId: 'mc-1', validationStatus: 'valid', findings });

describe('recGenJobContext', () => {
  it('lifts the repo/namespace/scan context from an alert_coverage job', () => {
    expect(recGenJobContext(job())).toMatchObject({ repositoryId: 'repo-1', namespace: 'instrument', scanJobId: 'scan-1', headSha: 'abc1234' });
  });
  it('returns null for a job that is not an alert_coverage trigger', () => {
    expect(recGenJobContext(job({ trigger_summary: { source: 'github_push' } } as any))).toBeNull();
  });
  it('falls back to the repo short name when namespace is absent', () => {
    expect(recGenJobContext(job({ trigger_summary: { source: 'alert_coverage', repo: { owner: 'o', name: 'svc', full_name: 'o/svc' } } } as any))?.namespace).toBe('svc');
  });
});

describe('gather', () => {
  it('reads metrics + monitors, computes coverage, and persists ONE snapshot; resume does not re-read', async () => {
    const mcp = fakeMcp();
    const { store, coverageMap } = fakeStore({ scanGaps: ['missing error log'] });
    const exec = makeRecGenExecutor(deps(mcp, store));
    await exec({ job: job(), phaseKey: 'gather', attempt: 1 });
    await exec({ job: job(), phaseKey: 'gather', attempt: 2 });
    expect(mcp.metricReads).toBe(1);
    const snap = coverageMap.get('rg-1')!;
    expect(snap.uncovered).toEqual(['instrument.job.error']);
    expect(snap.covered).toEqual(['instrument.job.retry']);
    expect(snap.instrumentationGaps).toEqual(['missing error log']);
  });
});

describe('draft', () => {
  it('runs the model over the coverage snapshot and persists valid findings', async () => {
    const snapshot: CoverageSnapshot = { metrics: ['instrument.job.error'], monitors: [], uncovered: ['instrument.job.error'], covered: [], instrumentationGaps: [] };
    const { store, findingsMap } = fakeStore({ coverage: snapshot });
    const gw = fakeGateway({ findings: [newMonitorFinding()] });
    await makeRecGenExecutor(deps(fakeMcp(), store, gw))({ job: job(), phaseKey: 'draft', attempt: 1 });
    expect(findingsMap.get('rg-1')?.findings).toHaveLength(1);
  });

  it('does not re-invoke the gateway when findings already exist (resume / no re-bill)', async () => {
    const snapshot: CoverageSnapshot = { metrics: [], monitors: [], uncovered: [], covered: [], instrumentationGaps: [] };
    const { store } = fakeStore({ coverage: snapshot, findings: validFindings([]) });
    const gw = fakeGateway({ findings: [] });
    await makeRecGenExecutor(deps(fakeMcp(), store, gw))({ job: job(), phaseKey: 'draft', attempt: 2 });
    expect(gw.invoke).not.toHaveBeenCalled();
  });
});

describe('validate', () => {
  const snapshot: CoverageSnapshot = { metrics: ['instrument.job.retry', 'instrument.job.error'], monitors: [{ id: 1, name: 'retry rate', query: 'avg(last_5m):avg:instrument.job.retry{*} > 5' }], uncovered: ['instrument.job.error'], covered: ['instrument.job.retry'], instrumentationGaps: [] };

  it('upserts an alert recommendation for a verified uncovered metric', async () => {
    const { store, events } = fakeStore({ coverage: snapshot, findings: validFindings([newMonitorFinding()]) });
    await makeRecGenExecutor(deps(fakeMcp(), store))({ job: job(), phaseKey: 'validate', attempt: 1 });
    expect(events.upserts).toHaveLength(1);
    expect(events.upserts[0].step).toMatchObject({ kind: 'datadog_new_monitor', state: 'available', metric_verification_state: 'verified_in_datadog' });
  });

  it('does not upsert anything for an already-covered metric', async () => {
    const { store, events } = fakeStore({ coverage: snapshot, findings: validFindings([newMonitorFinding({ metric_name: 'instrument.job.retry', query: 'avg(last_5m):avg:instrument.job.retry{*} > 9' })]) });
    await makeRecGenExecutor(deps(fakeMcp(), store))({ job: job(), phaseKey: 'validate', attempt: 1 });
    expect(events.upserts).toHaveLength(0);
  });

  it('is idempotent on resume: a re-run upserts onto the same dedupe fingerprint (no new rec)', async () => {
    const { store, recs } = fakeStore({ coverage: snapshot, findings: validFindings([newMonitorFinding()]) });
    const exec = makeRecGenExecutor(deps(fakeMcp(), store));
    await exec({ job: job(), phaseKey: 'validate', attempt: 1 });
    await exec({ job: job(), phaseKey: 'validate', attempt: 2 });
    expect(recs.size).toBe(1);
  });

  it('upserts nothing when the findings validation status is not valid', async () => {
    const { store, events } = fakeStore({ coverage: snapshot, findings: { modelCallId: 'mc-1', validationStatus: 'invalid', findings: [] } });
    await makeRecGenExecutor(deps(fakeMcp(), store))({ job: job(), phaseKey: 'validate', attempt: 1 });
    expect(events.upserts).toHaveLength(0);
  });
});
