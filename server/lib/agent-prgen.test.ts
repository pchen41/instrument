import { describe, expect, it, vi } from 'vitest';
import { makePrGenExecutor, prGenJobContext, type LoadedPatch, type PrGenMcp, type PrGenPlan, type PrGenStore } from './agent-prgen';
import { type AgentInvoker, type ModelCallStore } from './model-call';
import type { JobRow } from './types';

function job(over: Partial<JobRow> = {}): JobRow {
  return { id: 'pg-1', workspace_id: 'ws-1', job_type: 'recommendation_pr_generation', target_id: 'rec-1', target_type: 'recommendation', target_step_key: 'step-a', trigger_summary: { source: 'approval', approval_id: 'appr-1' }, ...over } as any as JobRow;
}
const REPO = { owner: 'pchen41', name: 'instrument', fullName: 'pchen41/instrument', defaultBranch: 'main' };
function plan(over: Partial<PrGenPlan> = {}): PrGenPlan {
  return { approvalState: 'approved', approvedPayloadHash: 'HASH', repo: REPO, integrationId: null, recommendationTitle: 'Add latency metric', recommendationRationale: 'no metric', proposedNextStep: 'add a timer', filePath: 'src/checkout.ts', ...over };
}

function fakeMcp(): PrGenMcp & { branches: number; files: number; prs: number } {
  const self: any = {
    branches: 0, files: 0, prs: 0,
    readFile: vi.fn(async () => ({ content: 'export function handleCheckout(){}', sha: 'blob1' })),
    createBranch: vi.fn(async () => { self.branches++; }),
    updateFile: vi.fn(async () => { self.files++; }),
    createPr: vi.fn(async () => { self.prs++; return { number: 77, url: 'https://github.com/pchen41/instrument/pull/77', nodeId: 'PR_1' }; }),
  };
  return self;
}

function fakeStore(over: { patch?: LoadedPatch | null; baseline?: { path: string; content: string; sha: string | null } | null; approvalState?: string } = {}) {
  const baselines = new Map<string, { path: string; content: string; sha: string | null }>();
  if (over.baseline) baselines.set('pg-1', over.baseline);
  const patches = new Map<string, LoadedPatch>();
  if (over.patch) patches.set('pg-1', over.patch);
  const writes = new Map<string, { id: string; state: string; externalId: string | null; externalUrl: string | null; key: string }>();
  const events = { stepStates: [] as string[], generatedPr: null as any, inserted: [] as string[] };
  let seq = 0;
  const store: PrGenStore = {
    loadPlan: async () => plan({ approvalState: over.approvalState ?? 'approved' }),
    loadFileBaseline: async (j) => baselines.get(j) ?? null,
    saveFileBaseline: async (j, _w, _r, path, content, sha) => { baselines.set(j, { path, content, sha }); },
    loadPatch: async (j) => patches.get(j) ?? null,
    savePatch: async (j, _w, _r, modelCallId, validationStatus, patch) => { patches.set(j, { modelCallId, validationStatus, patch }); },
    setStepState: async (_r, _s, state) => { events.stepStates.push(state); },
    setGeneratedPr: async (_r, _s, g) => { events.generatedPr = g; },
    findExternalWrite: async (_w, key) => { for (const v of writes.values()) if (v.key === key) return v; return null; },
    insertExternalWrite: async (i) => { const id = `w-${++seq}`; writes.set(id, { id, state: 'planned', externalId: null, externalUrl: null, key: i.idempotencyKey }); events.inserted.push(i.actionKind); return id; },
    markExternalWrite: async (id, p) => { const v = writes.get(id); if (v) writes.set(id, { ...v, state: p.state, externalId: p.externalId ?? v.externalId, externalUrl: p.externalUrl ?? v.externalUrl }); },
  };
  return { store, writes, events };
}

function fakeGateway(json: object): AgentInvoker {
  return { invoke: vi.fn(async () => ({ text: JSON.stringify(json), model: 'm', provider: 'truefoundry', latencyMs: 5 })) };
}
function fakeModelStore(): ModelCallStore {
  return { saveModelCall: vi.fn(async () => ({ id: 'mc-1', deduped: false })), saveEvidence: vi.fn(async () => {}) } as any;
}
const deps = (mcp: PrGenMcp, store: PrGenStore, gw?: AgentInvoker) => ({ mcp, store, gateway: gw ?? fakeGateway({}), modelStore: fakeModelStore() });
const validPatch = (): LoadedPatch => ({ modelCallId: 'mc-1', validationStatus: 'valid', patch: { files: [{ path: 'src/checkout.ts', content: 'instrumented' }], pr_title: 'Add metric', pr_summary: 'adds metric' } });

describe('prGenJobContext', () => {
  it('lifts the approval + recommendation + step', () => {
    expect(prGenJobContext(job())).toMatchObject({ recommendationId: 'rec-1', stepKey: 'step-a', approvalId: 'appr-1' });
  });
  it('returns null for a non-recommendation target', () => {
    expect(prGenJobContext(job({ target_type: 'incident' } as any))).toBeNull();
  });
});

describe('plan', () => {
  it('reads the file baseline + sets the step generating; refuses an unapproved approval', async () => {
    const mcp = fakeMcp();
    const { store, events } = fakeStore();
    await makePrGenExecutor(deps(mcp, store))({ job: job(), phaseKey: 'plan', attempt: 1 });
    expect(mcp.readFile).toHaveBeenCalled();
    expect(events.stepStates).toContain('generating');

    const rejected = fakeStore({ approvalState: 'revoked' });
    await expect(makePrGenExecutor(deps(fakeMcp(), rejected.store))({ job: job(), phaseKey: 'plan', attempt: 1 })).rejects.toThrow(/approved/);
  });
});

describe('compose_patch', () => {
  it('generates + persists a valid patch', async () => {
    const gw = fakeGateway({ files: [{ path: 'src/checkout.ts', content: 'instrumented' }], pr_title: 'Add metric', pr_summary: 'adds metric' });
    const { store } = fakeStore({ baseline: { path: 'src/checkout.ts', content: 'old', sha: 'b1' } });
    await makePrGenExecutor({ mcp: fakeMcp(), store, gateway: gw, modelStore: fakeModelStore() })({ job: job(), phaseKey: 'compose_patch', attempt: 1 });
    const loaded = await store.loadPatch('pg-1');
    expect(loaded!.validationStatus).toBe('valid');
    expect(loaded!.patch!.files[0].path).toBe('src/checkout.ts');
  });
});

describe('handoff', () => {
  const baseline = { path: 'src/checkout.ts', content: 'export function handleCheckout(){}', sha: 'b1' };

  it('creates branch + file + PR exactly once and links the generated PR on the step', async () => {
    const mcp = fakeMcp();
    const { store, events } = fakeStore({ patch: validPatch(), baseline });
    await makePrGenExecutor(deps(mcp, store))({ job: job(), phaseKey: 'handoff', attempt: 1 });
    expect([mcp.branches, mcp.files, mcp.prs]).toEqual([1, 1, 1]);
    expect(events.inserted).toEqual(['github_create_branch', 'github_update_file', 'github_create_pr']);
    expect(events.generatedPr).toMatchObject({ number: 77, branch: expect.stringContaining('instrument/instr-') });
    expect(events.stepStates).toContain('ready'); // NOT done — done lands on merge
    expect(events.stepStates).not.toContain('done');
  });

  it('does not re-create writes that already succeeded (idempotent resume)', async () => {
    const mcp = fakeMcp();
    const { store } = fakeStore({ patch: validPatch(), baseline });
    await makePrGenExecutor(deps(mcp, store))({ job: job(), phaseKey: 'handoff', attempt: 1 });
    // second run (resume): all writes already succeeded → no new GitHub calls
    await makePrGenExecutor(deps(mcp, store))({ job: job(), phaseKey: 'handoff', attempt: 2 });
    expect([mcp.branches, mcp.files, mcp.prs]).toEqual([1, 1, 1]);
  });

  it('marks the step failed and writes nothing when the patch is invalid', async () => {
    const mcp = fakeMcp();
    const { store, events } = fakeStore({ patch: { modelCallId: 'mc', validationStatus: 'invalid', patch: null } });
    await makePrGenExecutor(deps(mcp, store))({ job: job(), phaseKey: 'handoff', attempt: 1 });
    expect([mcp.branches, mcp.files, mcp.prs]).toEqual([0, 0, 0]);
    expect(events.stepStates).toContain('failed');
  });

  it('refuses to write a path the patch returns that is NOT the approved target file', async () => {
    const mcp = fakeMcp();
    // valid patch but for a DIFFERENT file than the approved baseline
    const evil: LoadedPatch = { modelCallId: 'mc', validationStatus: 'valid', patch: { files: [{ path: '.github/workflows/evil.yml', content: 'x' }], pr_title: 't', pr_summary: 's' } };
    const { store, events } = fakeStore({ patch: evil, baseline });
    await makePrGenExecutor(deps(mcp, store))({ job: job(), phaseKey: 'handoff', attempt: 1 });
    expect([mcp.branches, mcp.files, mcp.prs]).toEqual([0, 0, 0]); // nothing written
    expect(events.stepStates).toContain('failed');
  });
});
