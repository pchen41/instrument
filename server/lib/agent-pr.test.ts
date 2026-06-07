import { describe, expect, it, vi } from 'vitest';
import { makePrReviewExecutor, prJobContext, type ClaimResult, type LoadedFindings, type PrMcp, type PrReviewStore } from './agent-pr';
import { type AgentInvoker, type ModelCallStore } from './model-call';
import { type PrFinding, prFindingsSchema } from './pr-review';
import { JobError } from './retry';
import type { JobRow } from './types';

const REPO = 'pchen41/instrument';
const SHA = 'headaaa111';

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1',
    workspace_id: 'ws-1',
    job_type: 'github_pr_review_analysis',
    target_id: 'pr-1',
    target_type: 'pull_request',
    trigger_summary: { source: 'github_webhook', action: 'opened', repo: { owner: 'pchen41', name: 'instrument', full_name: REPO }, pr_number: 42, head_sha: SHA, base_branch: 'main', head_branch: 'feat/x', title: 'Add checkout timing', html_url: 'https://github.com/pchen41/instrument/pull/42' },
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as JobRow;
}

function finding(over: Partial<PrFinding> = {}): PrFinding {
  return prFindingsSchema.parse({ findings: [{ issue_type: 'missing_latency_metric', file_path: 'src/checkout.ts', line_number: 42, side: 'RIGHT', code_anchor: 'checkoutHandler', severity: 'medium', body: 'No latency metric on the new external call.', suggested_code: null, fix_summary: 'add p95 latency histogram around checkout handler', ...over }] }).findings[0];
}

function fakeMcp(over: Partial<PrMcp> = {}): PrMcp & { reads: number; posts: number } {
  const self: any = {
    reads: 0,
    posts: 0,
    readDiff: vi.fn(async () => { self.reads++; return { diffText: '+ un-instrumented call', files: [{ path: 'src/checkout.ts' }], externalId: 'pr-read-1', liveHeadSha: SHA, payload: {} }; }),
    postReviewComment: vi.fn(async () => { self.posts++; return { externalId: `cmt-${self.posts}`, url: 'https://x#c' }; }),
    findExistingComment: vi.fn(async () => null),
    ...over,
  };
  return self;
}

// In-memory store modelling the claim/partial-unique semantics.
function fakeStore(over: { findings?: LoadedFindings | null; diff?: { diffText: string; superseded: boolean } } = {}) {
  type Row = { id: string; semantic: string; revision: string; status: string; suggested_code: string | null; external_comment_id: string | null; external_write_action_id: string | null };
  const diffs = new Map<string, { diffText: string; superseded: boolean }>();
  const findingsMap = new Map<string, LoadedFindings>();
  if (over.findings) findingsMap.set('job-1', over.findings);
  const comments: Row[] = [];
  const writes = new Map<string, { id: string; state: string; externalId: string | null; externalUrl: string | null; key: string }>();
  const events = { recs: 0, outdated: [] as string[], refreshed: [] as string[], finalized: [] as string[], skipped: 0, planned: 0 };
  let cseq = 0;
  let wseq = 0;
  const store: PrReviewStore = {
    hasDiff: async (j) => diffs.has(j),
    saveDiff: async (i) => { diffs.set(i.jobId, { diffText: i.diffText, superseded: i.superseded }); },
    loadDiff: async (j) => over.diff ?? diffs.get(j) ?? null,
    saveFindings: async (i) => { findingsMap.set(i.jobId, { modelCallId: i.modelCallId, validationStatus: i.validationStatus, findings: i.findings }); },
    loadFindings: async (j) => findingsMap.get(j) ?? null,
    upsertRecommendation: async () => { events.recs++; return 'rec-1'; },
    claimPostedComment: async (i): Promise<ClaimResult> => {
      const sameRev = comments.find((c) => c.revision === i.revisionFingerprint);
      if (sameRev) return { state: 'resumed', id: sameRev.id, externalCommentId: sameRev.external_comment_id };
      const posted = comments.find((c) => c.semantic === i.semanticFingerprint && c.status === 'posted');
      if (posted) return { state: 'exists', existing: { id: posted.id } };
      const id = `c-${++cseq}`;
      comments.push({ id, semantic: i.semanticFingerprint, revision: i.revisionFingerprint, status: 'posted', suggested_code: i.finding.suggested_code ?? null, external_comment_id: null, external_write_action_id: null });
      return { state: 'claimed', id };
    },
    outdateComment: async (id) => { const c = comments.find((x) => x.id === id); if (c) c.status = 'outdated'; events.outdated.push(id); },
    refreshCommentPlacement: async (i) => { const c = comments.find((x) => x.id === i.id); if (c) c.revision = i.revisionFingerprint; events.refreshed.push(i.id); },
    finalizeComment: async (i) => { const c = comments.find((x) => x.id === i.id); if (c) { c.external_comment_id = i.externalCommentId; c.external_write_action_id = i.externalWriteActionId; } events.finalized.push(i.id); },
    findExternalWrite: async (_w, key) => { for (const v of writes.values()) if (v.key === key) return v; return null; },
    insertExternalWrite: async (i) => { const id = `w-${++wseq}`; writes.set(id, { id, state: i.state, externalId: null, externalUrl: null, key: i.idempotencyKey }); if (i.state === 'planned') events.planned++; if (i.state === 'skipped_duplicate') events.skipped++; return id; },
    markExternalWrite: async (id, p) => { const v = writes.get(id); if (v) writes.set(id, { ...v, state: p.state, externalId: p.externalId ?? v.externalId, externalUrl: p.externalUrl ?? v.externalUrl }); },
  };
  return { store, comments, writes, events };
}

function fakeGateway(findingsJson: object): AgentInvoker {
  return { invoke: vi.fn(async () => ({ text: JSON.stringify(findingsJson), model: 'instrument/instrument', provider: 'truefoundry', latencyMs: 5 })) };
}
function fakeModelStore(): ModelCallStore & { saved: any[] } {
  const saved: any[] = [];
  return { saved, saveModelCall: vi.fn(async (r) => { saved.push(r); return { id: 'mc-1', deduped: false }; }), saveEvidence: vi.fn(async () => {}) } as any;
}
const deps = (mcp: PrMcp, store: PrReviewStore, gw?: AgentInvoker) => ({ mcp, store, gateway: gw ?? fakeGateway({ findings: [] }), modelStore: fakeModelStore() });
const valid = (findings: PrFinding[]): LoadedFindings => ({ modelCallId: 'mc-1', validationStatus: 'valid', findings });

describe('prJobContext', () => {
  it('lifts repo/pr context from a github_webhook job', () => {
    expect(prJobContext(job())).toMatchObject({ workspaceId: 'ws-1', pullRequestId: 'pr-1', prNumber: 42, headSha: SHA });
  });
  it('returns null for a non-webhook job', () => {
    expect(prJobContext(job({ trigger_summary: { mode: 'viability' } } as any))).toBeNull();
  });
});

describe('fetch_diff', () => {
  it('reads once, persists, and a resume does not re-read', async () => {
    const mcp = fakeMcp();
    const { store } = fakeStore();
    const exec = makePrReviewExecutor(deps(mcp, store));
    await exec({ job: job(), phaseKey: 'fetch_diff', attempt: 1 });
    await exec({ job: job(), phaseKey: 'fetch_diff', attempt: 2 });
    expect(mcp.reads).toBe(1);
  });
  it('flags supersession when the live head moved past the job head', async () => {
    const mcp = fakeMcp({ readDiff: vi.fn(async () => ({ diffText: 'd', files: [], externalId: 'x', liveHeadSha: 'newsha999', payload: {} })) as any });
    const { store } = fakeStore();
    await makePrReviewExecutor(deps(mcp, store))({ job: job(), phaseKey: 'fetch_diff', attempt: 1 });
    expect((await store.loadDiff('job-1'))!.superseded).toBe(true);
  });
});

describe('analyze', () => {
  it('runs the model and persists valid findings', async () => {
    const mcp = fakeMcp();
    const { store } = fakeStore({ diff: { diffText: 'diff', superseded: false } });
    const modelStore = fakeModelStore();
    const exec = makePrReviewExecutor({ mcp, store, gateway: fakeGateway({ findings: [{ issue_type: 'x', file_path: 'a.ts', line_number: 1, body: 'b', fix_summary: 'f' }] }), modelStore });
    await exec({ job: job(), phaseKey: 'analyze', attempt: 1 });
    expect(modelStore.saved[0]).toMatchObject({ purpose: 'pr_review_findings', validationStatus: 'valid' });
    expect((await store.loadFindings('job-1'))!.findings).toHaveLength(1);
  });
  it('superseded diff → no model call, empty findings', async () => {
    const gw = fakeGateway({ findings: [{ issue_type: 'x', file_path: 'a.ts', line_number: 1, body: 'b', fix_summary: 'f' }] });
    const mcp = fakeMcp();
    const { store } = fakeStore({ diff: { diffText: 'd', superseded: true } });
    await makePrReviewExecutor({ mcp, store, gateway: gw, modelStore: fakeModelStore() })({ job: job(), phaseKey: 'analyze', attempt: 1 });
    expect(gw.invoke).not.toHaveBeenCalled();
    expect((await store.loadFindings('job-1'))!.findings).toHaveLength(0);
  });
});

describe('compose', () => {
  it('posts exactly one comment for a fresh gap + records the audit trail', async () => {
    const mcp = fakeMcp();
    const { store, events, writes } = fakeStore({ findings: valid([finding()]) });
    await makePrReviewExecutor(deps(mcp, store))({ job: job(), phaseKey: 'compose', attempt: 1 });
    expect(mcp.posts).toBe(1);
    expect(mcp.findExistingComment).not.toHaveBeenCalled(); // fresh → no reconcile read
    expect(events.recs).toBe(1);
    expect(events.planned).toBe(1);
    expect([...writes.values()][0].state).toBe('succeeded');
    expect(events.finalized).toHaveLength(1);
  });

  it('posts nothing for empty or invalid findings', async () => {
    for (const f of [valid([]), { modelCallId: 'm', validationStatus: 'invalid' as const, findings: [] }]) {
      const mcp = fakeMcp();
      const { store } = fakeStore({ findings: f });
      await makePrReviewExecutor(deps(mcp, store))({ job: job(), phaseKey: 'compose', attempt: 1 });
      expect(mcp.posts).toBe(0);
    }
  });

  it('dedupes two identical findings in one run to a single comment', async () => {
    const mcp = fakeMcp();
    const { store } = fakeStore({ findings: valid([finding(), finding()]) });
    await makePrReviewExecutor(deps(mcp, store))({ job: job(), phaseKey: 'compose', attempt: 1 });
    expect(mcp.posts).toBe(1);
  });

  it('skip_duplicate: same gap, later revision, no repost — refresh placement + skipped write', async () => {
    const mcp = fakeMcp();
    const { store, events } = fakeStore({ findings: valid([finding()]) });
    // seed an existing posted comment for the same semantic at a different revision
    await store.claimPostedComment({ workspaceId: 'ws-1', pullRequestId: 'pr-1', jobId: 'old', recommendationId: 'r', modelCallId: 'm', eventAction: null, headSha: 'oldsha', semanticFingerprint: semanticOf(finding()), revisionFingerprint: 'old-rev', finding: finding(), now: 't' });
    await makePrReviewExecutor(deps(mcp, store))({ job: job(), phaseKey: 'compose', attempt: 1 });
    expect(mcp.posts).toBe(0);
    expect(events.refreshed).toHaveLength(1);
    expect(events.skipped).toBe(1);
  });

  it('never reposts the same gap even when the suggested fix wording changed', async () => {
    const mcp = fakeMcp();
    const { store, events } = fakeStore({ findings: valid([finding({ suggested_code: 'metrics.timing()' })]) });
    await store.claimPostedComment({ workspaceId: 'ws-1', pullRequestId: 'pr-1', jobId: 'old', recommendationId: 'r', modelCallId: 'm', eventAction: null, headSha: 'oldsha', semanticFingerprint: semanticOf(finding()), revisionFingerprint: 'old-rev', finding: finding({ suggested_code: null }), now: 't' });
    await makePrReviewExecutor(deps(mcp, store))({ job: job(), phaseKey: 'compose', attempt: 1 });
    expect(mcp.posts).toBe(0); // no repost — the gap is already posted
    expect(events.outdated).toHaveLength(0);
    expect(events.refreshed).toHaveLength(1); // placement refreshed instead
    expect(events.skipped).toBe(1);
  });

  it('resume: an already-finalized revision posts nothing', async () => {
    const f = finding();
    const mcp = fakeMcp();
    const { store } = fakeStore({ findings: valid([f]) });
    // seed our own revision row, already finalized (external_comment_id set)
    const claim = await store.claimPostedComment({ workspaceId: 'ws-1', pullRequestId: 'pr-1', jobId: 'job-1', recommendationId: 'r', modelCallId: 'm', eventAction: null, headSha: SHA, semanticFingerprint: semanticOf(f), revisionFingerprint: revisionOf(f), finding: f, now: 't' });
    await store.finalizeComment({ id: (claim as any).id, externalCommentId: 'cmt-prior', externalWriteActionId: 'w0', now: 't' });
    await makePrReviewExecutor(deps(mcp, store))({ job: job(), phaseKey: 'compose', attempt: 2 });
    expect(mcp.posts).toBe(0);
  });

  it('H2: a per-comment GitHub rejection skips that finding but still posts the sibling', async () => {
    let n = 0;
    const mcp = fakeMcp({
      postReviewComment: vi.fn(async () => {
        n++;
        if (n === 1) throw new JobError({ retryable: false, code: 'github_comment_rejected', summary: 'line not in diff', source: 'github' });
        return { externalId: 'cmt-ok', url: null };
      }) as any,
    });
    const { store, events } = fakeStore({ findings: valid([finding({ line_number: 1 }), finding({ issue_type: 'unlogged_error', line_number: 2, fix_summary: 'log the error branch' })]) });
    // should NOT throw, and the second finding still posts
    await makePrReviewExecutor(deps(mcp, store))({ job: job(), phaseKey: 'compose', attempt: 1 });
    expect(n).toBe(2);
    expect(events.outdated).toHaveLength(1); // the rejected finding's claim was released
    expect(events.finalized).toHaveLength(1); // only the sibling finalized
  });

  it('retryable post error propagates (job retries)', async () => {
    const mcp = fakeMcp({ postReviewComment: vi.fn(async () => { throw new JobError({ retryable: true, code: 'github_timeout', summary: 't', source: 'github' }); }) as any });
    const { store } = fakeStore({ findings: valid([finding()]) });
    await expect(makePrReviewExecutor(deps(mcp, store))({ job: job(), phaseKey: 'compose', attempt: 1 })).rejects.toThrow();
  });
});

// helpers that mirror the store's fingerprint inputs
import { revisionFingerprint, semanticFingerprint } from './pr-review';
function semanticOf(f: PrFinding) { return semanticFingerprint(REPO, f); }
function revisionOf(f: PrFinding) { return revisionFingerprint(semanticOf(f), SHA, f); }
