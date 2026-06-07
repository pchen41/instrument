import { describe, expect, it, vi } from 'vitest';
import { makeScanExecutor, scanJobContext, type LoadedScanFindings, type ScanMcp, type ScanStore } from './agent-scan';
import { type AgentInvoker, type ModelCallStore } from './model-call';
import { type ScanFinding, scanFindingsSchema } from './scan';
import type { JobRow } from './types';

const REPO = 'pchen41/instrument';
const SHA = 'after111';

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: 'scan-1',
    workspace_id: 'ws-1',
    job_type: 'proactive_scan',
    target_id: 'repo-1',
    target_type: 'repository',
    trigger_summary: { source: 'github_push', repo: { owner: 'pchen41', name: 'instrument', full_name: REPO }, branch: 'main', after_sha: SHA, before_sha: 'b0', pending_sha: null },
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as JobRow;
}
function finding(over: Partial<ScanFinding> = {}): ScanFinding {
  return scanFindingsSchema.parse({ findings: [{ issue_type: 'missing_metric', file_path: 'src/a.ts', code_anchor: 'handleA', title: 'Add metric', rationale: 'no metric', proposed_next_step: 'add timer', severity: 'medium', ...over }] }).findings[0];
}

function fakeMcp(): ScanMcp & { reads: number } {
  const self: any = { reads: 0, readChangedCode: vi.fn(async () => { self.reads++; return { changedCode: '+ un-instrumented code', files: [{ path: 'src/a.ts' }], externalId: 'scan:x', payload: {} }; }) };
  return self;
}
function fakeStore(over: { findings?: LoadedScanFindings | null; code?: string } = {}) {
  const codes = new Map<string, string>();
  const findingsMap = new Map<string, LoadedScanFindings>();
  if (over.findings) findingsMap.set('scan-1', over.findings);
  const recs = new Map<string, { id: string; created: boolean }>();
  const events = { followups: 0, upserts: 0 };
  let seq = 0;
  const store: ScanStore = {
    hasCode: async (j) => codes.has(j),
    saveCode: async (i) => { codes.set(i.jobId, i.changedCode); },
    loadCode: async (j) => over.code ?? codes.get(j) ?? null,
    saveFindings: async (i) => { findingsMap.set(i.jobId, { modelCallId: i.modelCallId, validationStatus: i.validationStatus, findings: i.findings }); },
    loadFindings: async (j) => findingsMap.get(j) ?? null,
    upsertInstrumentationRecommendation: async (i) => { events.upserts++; const ex = recs.get(i.dedupeFingerprint); if (ex) return { ...ex, created: false }; const r = { id: `rec-${++seq}`, created: true }; recs.set(i.dedupeFingerprint, r); return r; },
    enqueueFollowupScan: async () => { events.followups++; },
  };
  return { store, recs, events };
}
function fakeGateway(json: object): AgentInvoker {
  return { invoke: vi.fn(async () => ({ text: JSON.stringify(json), model: 'instrument/instrument', provider: 'truefoundry', latencyMs: 5 })) };
}
function fakeModelStore(): ModelCallStore {
  return { saveModelCall: vi.fn(async () => ({ id: 'mc-1', deduped: false })), saveEvidence: vi.fn(async () => {}) } as any;
}
const deps = (mcp: ScanMcp, store: ScanStore, gw?: AgentInvoker) => ({ mcp, store, gateway: gw ?? fakeGateway({ findings: [] }), modelStore: fakeModelStore() });
const valid = (findings: ScanFinding[]): LoadedScanFindings => ({ modelCallId: 'mc-1', validationStatus: 'valid', findings });

describe('scanJobContext', () => {
  it('lifts repo/branch/sha from a github_push job', () => {
    expect(scanJobContext(job())).toMatchObject({ repositoryId: 'repo-1', branch: 'main', headSha: SHA });
  });
  it('returns null for a non-push job', () => {
    expect(scanJobContext(job({ trigger_summary: { source: 'github_webhook' } } as any))).toBeNull();
  });
});

describe('enumerate', () => {
  it('reads the changed code once; resume does not re-read', async () => {
    const mcp = fakeMcp();
    const { store } = fakeStore();
    const exec = makeScanExecutor(deps(mcp, store));
    await exec({ job: job(), phaseKey: 'enumerate', attempt: 1 });
    await exec({ job: job(), phaseKey: 'enumerate', attempt: 2 });
    expect(mcp.reads).toBe(1);
  });
});

describe('analyze', () => {
  it('runs the model over the changed code and persists valid findings', async () => {
    const { store } = fakeStore({ code: 'diff' });
    const gw = fakeGateway({ findings: [{ issue_type: 'missing_metric', file_path: 'a.ts', code_anchor: 'f', title: 't', rationale: 'r', proposed_next_step: 'n' }] });
    await makeScanExecutor({ mcp: fakeMcp(), store, gateway: gw, modelStore: fakeModelStore() })({ job: job(), phaseKey: 'analyze', attempt: 1 });
    expect((await store.loadFindings('scan-1'))!.findings).toHaveLength(1);
  });
});

describe('rank', () => {
  it('upserts one recommendation per gap, deduped by fingerprint', async () => {
    const { store, recs, events } = fakeStore({ findings: valid([finding({ code_anchor: 'handleA' }), finding({ code_anchor: 'handleB' }), finding({ code_anchor: 'handleA', issue_type: 'rephrased no latency metric' })]) });
    await makeScanExecutor(deps(fakeMcp(), store))({ job: job(), phaseKey: 'rank', attempt: 1 });
    // handleA twice (reworded → same kind+anchor → one rec) + handleB = 2 distinct recs
    expect(recs.size).toBe(2);
    expect(events.upserts).toBe(3); // upsert called per finding; the 3rd folds onto handleA
  });
  it('enqueues a coalesced follow-up when a newer sha is pending', async () => {
    const { store, events } = fakeStore({ findings: valid([]) });
    await makeScanExecutor(deps(fakeMcp(), store))({ job: job({ trigger_summary: { source: 'github_push', repo: { owner: 'pchen41', name: 'instrument', full_name: REPO }, branch: 'main', after_sha: SHA, pending_sha: 'newer999' } } as any), phaseKey: 'rank', attempt: 1 });
    expect(events.followups).toBe(1);
  });
  it('no follow-up when pending sha equals the scanned sha', async () => {
    const { store, events } = fakeStore({ findings: valid([]) });
    await makeScanExecutor(deps(fakeMcp(), store))({ job: job({ trigger_summary: { source: 'github_push', repo: { full_name: REPO }, branch: 'main', after_sha: SHA, pending_sha: SHA } } as any), phaseKey: 'rank', attempt: 1 });
    expect(events.followups).toBe(0);
  });
});
