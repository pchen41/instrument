// Runtime-agnostic PR-review phase executor (Task 6, slice 2 + review fixes). A
// PhaseExecutor for `github_pr_review_analysis` jobs, wired alongside the
// investigation executor in the worker tick. Pure TS: every side effect (github
// MCP read/write, gateway, persistence) is injected, so the whole
// fetch->analyze->compose flow runs under Vitest with fakes and bundled into the
// Edge Function with the real MCP client + TrueFoundry gateway + PostgREST stores.
//
// Resumable + exactly-once by construction:
//  - fetch_diff persists the diff (+ a supersession check) as an evidence_item.
//  - analyze persists schema-validated findings as a dedicated evidence row
//    (NOT the truncated ai_model_calls.output_redacted), so compose reads them back exactly.
//  - compose CLAIMS the posted pr_review_comments row by semantic fingerprint
//    BEFORE the GitHub write. The partial-unique (pull_request_id,
//    semantic_fingerprint) WHERE status='posted' is the serialization point: a
//    fresh insert means "we own this gap" and a conflict means "already posted"
//    (earlier revision or a concurrent job) — so two overlapping ticks can't
//    double-post. A crash between the GitHub post and the DB commit is closed by
//    reconciling the embedded comment marker on resume. A single un-commentable
//    line is isolated to that finding, not the whole job.
import type { PhaseExecCtx, PhaseExecutor } from './agent';
import { hashPayload } from './hash';
import { type AgentInvoker, type ModelCallStore, type RunModelCallOutcome, runModelCall } from './model-call';
import {
  type PrFinding,
  type PrFindings,
  buildFindingsMessages,
  formatCommentBody,
  parseFindings,
  PR_FINDINGS_SCHEMA_VERSION,
  prFindingsSchema,
  prReviewDedupeFingerprint,
  reviewCommentWriteKey,
  revisionFingerprint,
  semanticFingerprint,
} from './pr-review';
import { JobError } from './retry';
import { type SchemaRegistry, schemaRegistry, type ValidationStatus } from './schema-validation';
import type { JobRow } from './types';

const FINDINGS_PURPOSE = 'pr_review_findings';

/** PR/repo context the phases need, lifted from the job's trigger_summary + target. */
export interface PrJobContext {
  workspaceId: string;
  pullRequestId: string;
  integrationId: string | null;
  repo: { owner: string; name: string; fullName: string };
  prNumber: number;
  prNodeId: string | null;
  title: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  htmlUrl: string | null;
}

export function prJobContext(job: JobRow): PrJobContext | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ts = job.trigger_summary as Record<string, any> | undefined;
  const repo = ts?.repo as { owner?: string; name?: string; full_name?: string } | undefined;
  if (!ts || ts.source !== 'github_webhook' || !repo?.owner || !repo?.name || typeof ts.pr_number !== 'number' || typeof ts.head_sha !== 'string') return null;
  return {
    workspaceId: job.workspace_id,
    pullRequestId: job.target_id,
    integrationId: (ts.integration_id as string | undefined) ?? null,
    repo: { owner: repo.owner, name: repo.name, fullName: repo.full_name ?? `${repo.owner}/${repo.name}` },
    prNumber: ts.pr_number,
    prNodeId: (ts.pr_node_id as string | undefined) ?? null,
    title: typeof ts.title === 'string' ? ts.title : `PR #${ts.pr_number}`,
    baseBranch: typeof ts.base_branch === 'string' ? ts.base_branch : 'main',
    headBranch: typeof ts.head_branch === 'string' ? ts.head_branch : '',
    headSha: ts.head_sha,
    htmlUrl: (ts.html_url as string | undefined) ?? null,
  };
}

// ---- Injected IO interfaces --------------------------------------------------

export interface DiffRead {
  diffText: string;
  files: { path: string }[];
  externalId: string;
  uri?: string | null;
  /** The PR's live head SHA (for supersession detection); null if unknown. */
  liveHeadSha: string | null;
  /** Bounded, redacted snapshot for the evidence payload. */
  payload: unknown;
}
export interface PostedComment {
  externalId: string;
  url: string | null;
}
export interface PrMcp {
  /** Governed github MCP read of the PR's changed files/diff + live head. Throws JobError on failure. */
  readDiff(ctx: PrJobContext): Promise<DiffRead>;
  /** Governed github MCP write of ONE scoped review comment. Throws JobError on failure. */
  postReviewComment(ctx: PrJobContext, finding: PrFinding, body: string): Promise<PostedComment>;
  /** Reconcile: find an already-posted Instrument comment for this finding (marker + path + line). */
  findExistingComment(ctx: PrJobContext, finding: PrFinding): Promise<PostedComment | null>;
}

export interface SaveDiffInput {
  workspaceId: string;
  jobId: string;
  pullRequestId: string;
  externalId: string;
  uri: string | null;
  title: string;
  summary: string;
  diffText: string;
  superseded: boolean;
  payload: unknown;
  contentHash: string;
  now: string;
}
export interface LoadedDiff {
  diffText: string;
  /** True when the PR advanced past this job's head SHA — analyze/compose no-op. */
  superseded: boolean;
}
export interface SaveFindingsInput {
  workspaceId: string;
  jobId: string;
  pullRequestId: string;
  modelCallId: string;
  validationStatus: ValidationStatus;
  findings: PrFinding[];
  now: string;
}
export interface LoadedFindings {
  modelCallId: string;
  validationStatus: ValidationStatus;
  findings: PrFinding[];
}
export interface UpsertRecommendationInput {
  workspaceId: string;
  jobId: string;
  pullRequestId: string;
  repo: PrJobContext['repo'];
  prNumber: number;
  title: string;
  headBranch: string;
  htmlUrl: string | null;
  findingCount: number;
  dedupeFingerprint: string;
  modelCallId: string;
  now: string;
}
export interface ClaimCommentInput {
  workspaceId: string;
  pullRequestId: string;
  jobId: string;
  recommendationId: string;
  modelCallId: string;
  eventAction: string | null;
  headSha: string;
  semanticFingerprint: string;
  revisionFingerprint: string;
  finding: PrFinding;
  now: string;
}
export type ClaimResult =
  | { state: 'claimed'; id: string }
  | { state: 'resumed'; id: string; externalCommentId: string | null }
  | { state: 'exists'; existing: { id: string } }
  | { state: 'lost' };
export interface RefreshPlacementInput {
  id: string;
  revisionFingerprint: string;
  headSha: string;
  lineNumber: number;
  now: string;
}
export interface FinalizeCommentInput {
  id: string;
  externalCommentId: string;
  externalWriteActionId: string;
  now: string;
}
export interface ExternalWriteInsert {
  workspaceId: string;
  jobId: string;
  actionKind: string;
  idempotencyKey: string;
  targetSummary: string;
  requestHash: string;
  requestRedacted: Record<string, unknown>;
  state: 'planned' | 'skipped_duplicate';
  now: string;
}
export interface PrReviewStore {
  hasDiff(jobId: string): Promise<boolean>;
  saveDiff(input: SaveDiffInput): Promise<void>;
  loadDiff(jobId: string): Promise<LoadedDiff | null>;
  saveFindings(input: SaveFindingsInput): Promise<void>;
  loadFindings(jobId: string): Promise<LoadedFindings | null>;
  upsertRecommendation(input: UpsertRecommendationInput): Promise<string>;
  claimPostedComment(input: ClaimCommentInput): Promise<ClaimResult>;
  outdateComment(id: string, now: string): Promise<void>;
  refreshCommentPlacement(input: RefreshPlacementInput): Promise<void>;
  finalizeComment(input: FinalizeCommentInput): Promise<void>;
  findExternalWrite(workspaceId: string, key: string): Promise<{ id: string; state: string; externalId: string | null; externalUrl: string | null } | null>;
  insertExternalWrite(input: ExternalWriteInsert): Promise<string>;
  markExternalWrite(id: string, patch: { state: string; externalId?: string | null; externalUrl?: string | null; responseSummary?: Record<string, unknown>; errorCode?: string | null; errorSummary?: string | null; now: string }): Promise<void>;
}

export interface PrReviewDeps {
  gateway: AgentInvoker;
  modelStore: ModelCallStore;
  mcp: PrMcp;
  store: PrReviewStore;
  registry?: SchemaRegistry;
  now?: () => Date;
}

// ---- Executor ----------------------------------------------------------------

export function makePrReviewExecutor(deps: PrReviewDeps): PhaseExecutor {
  const now = deps.now ?? (() => new Date());
  const registry = deps.registry ?? schemaRegistry;
  return async ({ job, phaseKey }: PhaseExecCtx) => {
    if (job.job_type !== 'github_pr_review_analysis') return; // not ours — leave to the investigation executor
    const ctx = prJobContext(job);
    if (!ctx) throw new JobError({ retryable: false, code: 'pr_context_missing', summary: 'PR review job is missing its trigger context.', source: 'worker' });

    switch (phaseKey) {
      case 'fetch_diff':
        await fetchDiff(deps, ctx, job.id, now);
        break;
      case 'analyze':
        await analyze(deps, ctx, job.id, registry, now);
        break;
      case 'compose':
        await compose(deps, ctx, job, now);
        break;
    }
  };
}

async function fetchDiff(deps: PrReviewDeps, ctx: PrJobContext, jobId: string, now: () => Date): Promise<void> {
  if (await deps.store.hasDiff(jobId)) return; // resume: already read
  const read = await deps.mcp.readDiff(ctx);
  // Supersession: the PR advanced past this job's head SHA, so a newer
  // github_pr_review_analysis job covers the current head — this one no-ops.
  const superseded = !!read.liveHeadSha && read.liveHeadSha !== ctx.headSha;
  await deps.store.saveDiff({
    workspaceId: ctx.workspaceId,
    jobId,
    pullRequestId: ctx.pullRequestId,
    externalId: read.externalId,
    uri: read.uri ?? ctx.htmlUrl,
    title: `PR #${ctx.prNumber} changed files`,
    summary: `${read.files.length} changed file(s) at ${ctx.headSha.slice(0, 7)}${superseded ? ' (superseded)' : ''}`,
    diffText: read.diffText,
    superseded,
    payload: read.payload,
    contentHash: hashPayload(read.payload),
    now: now().toISOString(),
  });
}

async function analyze(deps: PrReviewDeps, ctx: PrJobContext, jobId: string, registry: SchemaRegistry, now: () => Date): Promise<void> {
  const diff = await deps.store.loadDiff(jobId);
  if (!diff) throw new JobError({ retryable: true, code: 'diff_unavailable', summary: 'The fetched PR diff was not available for analysis.', source: 'worker' });

  // Superseded job: skip the model call, persist empty findings → compose no-ops.
  if (diff.superseded) {
    await deps.store.saveFindings({ workspaceId: ctx.workspaceId, jobId, pullRequestId: ctx.pullRequestId, modelCallId: '', validationStatus: 'valid', findings: [], now: now().toISOString() });
    return;
  }

  // runModelCall is idempotent on (job_id, purpose). A gateway error is re-thrown
  // (after a failed audit row) → the worker retries. A schema-INVALID output is
  // persisted (validation_status='invalid') and NOT thrown — a malformed model
  // answer must not loop; compose simply posts nothing.
  const outcome: RunModelCallOutcome = await runModelCall(
    { gateway: deps.gateway, store: deps.modelStore, registry, now },
    {
      workspaceId: ctx.workspaceId,
      integrationId: ctx.integrationId ?? null,
      jobId,
      purpose: FINDINGS_PURPOSE,
      request: {
        apiSurface: 'agent_chat_completions',
        messages: buildFindingsMessages({ repoFullName: ctx.repo.fullName, prNumber: ctx.prNumber, title: ctx.title, baseBranch: ctx.baseBranch, headBranch: ctx.headBranch, diffText: diff.diffText }),
        // The gateway model is a reasoning model (gemini-3.5-flash) that spends
        // most of its budget on hidden reasoning tokens, so the JSON needs ample
        // room or it truncates at finish_reason 'length'.
        maxTokens: 3000,
      },
      requestSchemaVersion: 'pr_review_request.v1',
      outputSchemaVersion: PR_FINDINGS_SCHEMA_VERSION,
      parseStructured: parseFindings,
      gatewayBaseUrlName: 'truefoundry',
      subjectType: 'pull_request',
      subjectId: ctx.pullRequestId,
    },
  );

  // Persist the VALIDATED structured findings durably (not the 4000-char-bounded
  // output_redacted text) so compose reads them back exactly even on resume.
  const findings = outcome.validation.status === 'valid' ? ((outcome.validation.value as PrFindings | undefined)?.findings ?? []) : [];
  await deps.store.saveFindings({
    workspaceId: ctx.workspaceId,
    jobId,
    pullRequestId: ctx.pullRequestId,
    modelCallId: outcome.modelCallId,
    validationStatus: outcome.validation.status,
    findings,
    now: now().toISOString(),
  });
}

async function compose(deps: PrReviewDeps, ctx: PrJobContext, job: JobRow, now: () => Date): Promise<void> {
  const loaded = await deps.store.loadFindings(job.id);
  if (!loaded) throw new JobError({ retryable: true, code: 'findings_unavailable', summary: 'Validated findings were not available to compose.', source: 'worker' });
  // Gate (ERD): only schema-VALID output is posted. Invalid/absent/empty → no comments.
  if (loaded.validationStatus !== 'valid' || loaded.findings.length === 0) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eventAction = (job.trigger_summary as Record<string, any>)?.action ?? null;
  const dedupeFp = prReviewDedupeFingerprint(ctx.repo.fullName, ctx.prNumber);
  const recommendationId = await deps.store.upsertRecommendation({
    workspaceId: ctx.workspaceId,
    jobId: job.id,
    pullRequestId: ctx.pullRequestId,
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    title: ctx.title,
    headBranch: ctx.headBranch,
    htmlUrl: ctx.htmlUrl,
    findingCount: loaded.findings.length,
    dedupeFingerprint: dedupeFp,
    modelCallId: loaded.modelCallId,
    now: now().toISOString(),
  });

  for (const finding of loaded.findings) {
    await handleFinding(deps, ctx, job.id, finding, recommendationId, loaded.modelCallId, eventAction, now);
  }
}

async function handleFinding(deps: PrReviewDeps, ctx: PrJobContext, jobId: string, finding: PrFinding, recommendationId: string, modelCallId: string, eventAction: string | null, now: () => Date): Promise<void> {
  const semantic = semanticFingerprint(ctx.repo.fullName, finding);
  const revision = revisionFingerprint(semantic, ctx.headSha, finding);
  const claimInput: ClaimCommentInput = {
    workspaceId: ctx.workspaceId,
    pullRequestId: ctx.pullRequestId,
    jobId,
    recommendationId,
    modelCallId,
    eventAction,
    headSha: ctx.headSha,
    semanticFingerprint: semantic,
    revisionFingerprint: revision,
    finding,
    now: now().toISOString(),
  };

  const claim = await deps.store.claimPostedComment(claimInput);

  if (claim.state === 'exists') {
    // The gap is already posted (an earlier revision OR a concurrent job won the
    // claim). We NEVER repost the same semantic gap: the model rewords the
    // suggested fix / issue_type between runs, so a "material change" repost would
    // just create a duplicate comment for the same gap (observed live). A later
    // revision with the same unresolved gap refreshes the row's placement + audits
    // a skipped write, with no new GitHub comment (PR-6).
    await deps.store.refreshCommentPlacement({ id: claim.existing.id, revisionFingerprint: revision, headSha: ctx.headSha, lineNumber: finding.line_number, now: now().toISOString() });
    await recordSkippedWrite(deps, ctx, jobId, finding, revision, now);
    return;
  }

  if (claim.state === 'lost') {
    await recordSkippedWrite(deps, ctx, jobId, finding, revision, now);
    return;
  }

  if (claim.state === 'resumed' && claim.externalCommentId) return; // already finalized on a prior attempt
  await postAndFinalize(deps, ctx, jobId, finding, claim.id, revision, claim.state === 'resumed', now);
}

/**
 * Post the comment for a claimed row and finalize it. Exactly-once: a prior
 * succeeded write is reused; on a resume the embedded marker is reconciled against
 * GitHub before re-posting. A per-comment (non-retryable) GitHub rejection is
 * isolated — the claim is released and the finding skipped — so sibling findings
 * still post and the job still succeeds; a retryable error propagates to retry.
 */
async function postAndFinalize(deps: PrReviewDeps, ctx: PrJobContext, jobId: string, finding: PrFinding, rowId: string, revision: string, isResume: boolean, now: () => Date): Promise<void> {
  const key = reviewCommentWriteKey(ctx.pullRequestId, revision);
  const targetSummary = `${ctx.repo.fullName}#${ctx.prNumber} ${finding.file_path}:${finding.line_number}`;
  const requestHash = hashPayload({ semantic: revision, body: finding.body, suggested: finding.suggested_code ?? null });

  const prior = await deps.store.findExternalWrite(ctx.workspaceId, key);
  if (prior && prior.state === 'succeeded' && prior.externalId) {
    await deps.store.finalizeComment({ id: rowId, externalCommentId: prior.externalId, externalWriteActionId: prior.id, now: now().toISOString() });
    return;
  }

  // Reconcile only when a prior attempt could have posted (resume / existing write).
  let posted: PostedComment | null = null;
  if (isResume || prior) posted = await deps.mcp.findExistingComment(ctx, finding);

  const writeId =
    prior?.id ??
    (await deps.store.insertExternalWrite({
      workspaceId: ctx.workspaceId,
      jobId,
      actionKind: 'github_review_comment',
      idempotencyKey: key,
      targetSummary,
      requestHash,
      requestRedacted: { file: finding.file_path, line: finding.line_number, side: finding.side, issue_type: finding.issue_type },
      state: 'planned',
      now: now().toISOString(),
    }));

  if (!posted) {
    try {
      posted = await deps.mcp.postReviewComment(ctx, finding, formatCommentBody(finding));
    } catch (err) {
      const retryable = err instanceof JobError ? err.retryable : true;
      const code = err instanceof JobError ? err.code : 'github_post_failed';
      const summary = err instanceof JobError ? err.summary : 'Posting the review comment failed.';
      await deps.store.markExternalWrite(writeId, { state: 'failed', errorCode: code, errorSummary: summary, now: now().toISOString() });
      await deps.store.outdateComment(rowId, now().toISOString()); // release the claim so a retry re-claims
      if (!retryable) return; // per-comment rejection (e.g. line not in diff) → skip this finding, keep going
      throw err; // transient → fail the job so the worker retries
    }
  }

  await deps.store.markExternalWrite(writeId, { state: 'succeeded', externalId: posted.externalId, externalUrl: posted.url, responseSummary: { posted: true }, now: now().toISOString() });
  await deps.store.finalizeComment({ id: rowId, externalCommentId: posted.externalId, externalWriteActionId: writeId, now: now().toISOString() });
}

/** Audit a skipped (duplicate) comment as an external_write_actions row (idempotent). */
async function recordSkippedWrite(deps: PrReviewDeps, ctx: PrJobContext, jobId: string, finding: PrFinding, revision: string, now: () => Date): Promise<void> {
  const key = reviewCommentWriteKey(ctx.pullRequestId, revision);
  if (await deps.store.findExternalWrite(ctx.workspaceId, key)) return; // already recorded
  await deps.store.insertExternalWrite({
    workspaceId: ctx.workspaceId,
    jobId,
    actionKind: 'github_review_comment',
    idempotencyKey: key,
    targetSummary: `${ctx.repo.fullName}#${ctx.prNumber} ${finding.file_path}:${finding.line_number}`,
    requestHash: hashPayload({ semantic: revision, body: finding.body, suggested: finding.suggested_code ?? null }),
    requestRedacted: { reason: 'duplicate_semantic', file: finding.file_path, line: finding.line_number },
    state: 'skipped_duplicate',
    now: now().toISOString(),
  });
}

export { prFindingsSchema };
