// Runtime-agnostic recommendation-PR-generation executor (Task 8). A PhaseExecutor
// for `recommendation_pr_generation` jobs. Approval-gated + idempotent: the plan
// phase verifies the approval is `approved`, compose_patch generates the file
// change via the gateway (schema-validated), and handoff executes the GitHub
// writes (branch → file(s) → PR) through the governed MCP path — each as a
// separate external_write_actions row carrying the approval's approved_payload_hash
// as request_hash, reused on retry so a provider failure never duplicates a
// branch/commit/PR. The generated PR step is left `ready` (not `done` — done lands
// only when the github webhook reports the PR merged, Task 6's lifecycle branch).
import type { PhaseExecCtx, PhaseExecutor } from './agent';
import { scrubSecrets } from './redaction';
import { type AgentInvoker, type ModelCallStore, type RunModelCallOutcome, runModelCall } from './model-call';
import {
  type PrGenPatch,
  buildPatchMessages,
  buildPrBody,
  branchWriteKey,
  fileWriteKey,
  parsePatch,
  PR_GEN_SCHEMA_VERSION,
  prGenBranchName,
  prWriteKey,
} from './pr-gen';
import { JobError } from './retry';
import { type SchemaRegistry, schemaRegistry, type ValidationStatus } from './schema-validation';
import type { JobRow } from './types';

const PATCH_PURPOSE = 'recommendation_pr_patch';

export interface PrGenJobContext {
  workspaceId: string;
  recommendationId: string;
  stepKey: string | null;
  approvalId: string | null;
}

export function prGenJobContext(job: JobRow): PrGenJobContext | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ts = job.trigger_summary as Record<string, any> | undefined;
  if (job.target_type !== 'recommendation' || !job.target_id) return null;
  return {
    workspaceId: job.workspace_id,
    recommendationId: job.target_id,
    stepKey: job.target_step_key ?? null,
    approvalId: (ts?.approval_id as string | undefined) ?? null,
  };
}

export interface PrGenPlan {
  approvalState: string;
  approvedPayloadHash: string;
  repo: { owner: string; name: string; fullName: string; defaultBranch: string };
  integrationId: string | null;
  recommendationTitle: string;
  recommendationRationale: string;
  proposedNextStep: string;
  filePath: string;
}
export interface FileRead {
  content: string;
  sha: string | null;
}
export interface CreatedPr {
  number: number;
  url: string;
  nodeId: string | null;
}
export interface PrGenMcp {
  readFile(repo: PrGenPlan['repo'], path: string, ref: string): Promise<FileRead | null>;
  /** Create a branch off `fromBranch`; a no-op if it already exists (idempotent). */
  createBranch(repo: PrGenPlan['repo'], branch: string, fromBranch: string): Promise<void>;
  updateFile(repo: PrGenPlan['repo'], branch: string, path: string, content: string, message: string, sha: string | null): Promise<void>;
  createPr(repo: PrGenPlan['repo'], branch: string, baseBranch: string, title: string, body: string): Promise<CreatedPr>;
}

export interface LoadedPatch {
  modelCallId: string;
  validationStatus: ValidationStatus;
  patch: PrGenPatch | null;
}
export interface ExternalWriteInsert {
  workspaceId: string;
  jobId: string;
  approvalId: string | null;
  actionKind: string;
  idempotencyKey: string;
  targetSummary: string;
  requestHash: string;
  requestRedacted: Record<string, unknown>;
  now: string;
}
export interface PrGenStore {
  loadPlan(ctx: PrGenJobContext): Promise<PrGenPlan | null>;
  loadFileBaseline(jobId: string): Promise<{ path: string; content: string; sha: string | null } | null>;
  saveFileBaseline(jobId: string, workspaceId: string, recommendationId: string, path: string, content: string, sha: string | null, now: string): Promise<void>;
  loadPatch(jobId: string): Promise<LoadedPatch | null>;
  savePatch(jobId: string, workspaceId: string, recommendationId: string, modelCallId: string, validationStatus: ValidationStatus, patch: PrGenPatch | null, now: string): Promise<void>;
  setStepState(recommendationId: string, stepKey: string | null, state: string, now: string): Promise<void>;
  setGeneratedPr(recommendationId: string, stepKey: string | null, generatedPr: { branch: string; url: string; number: number; files: string[] }, now: string): Promise<void>;
  findExternalWrite(workspaceId: string, key: string): Promise<{ id: string; state: string; externalId: string | null; externalUrl: string | null } | null>;
  insertExternalWrite(input: ExternalWriteInsert): Promise<string>;
  markExternalWrite(id: string, patch: { state: string; externalId?: string | null; externalUrl?: string | null; errorCode?: string | null; errorSummary?: string | null; now: string }): Promise<void>;
}

export interface PrGenDeps {
  gateway: AgentInvoker;
  modelStore: ModelCallStore;
  mcp: PrGenMcp;
  store: PrGenStore;
  registry?: SchemaRegistry;
  now?: () => Date;
}

export function makePrGenExecutor(deps: PrGenDeps): PhaseExecutor {
  const now = deps.now ?? (() => new Date());
  const registry = deps.registry ?? schemaRegistry;
  return async ({ job, phaseKey }: PhaseExecCtx) => {
    if (job.job_type !== 'recommendation_pr_generation') return; // not ours
    const ctx = prGenJobContext(job);
    if (!ctx || !ctx.approvalId) throw new JobError({ retryable: false, code: 'prgen_context_missing', summary: 'PR generation job is missing its approval/recommendation context.', source: 'worker' });
    switch (phaseKey) {
      case 'plan':
        await plan(deps, ctx, job.id, now);
        break;
      case 'compose_patch':
        await composePatch(deps, ctx, job.id, registry, now);
        break;
      case 'handoff':
        await handoff(deps, ctx, job.id, now);
        break;
    }
  };
}

/** Load the approval/recommendation, verify it's approved, snapshot the target file. */
async function loadApprovedPlan(deps: PrGenDeps, ctx: PrGenJobContext): Promise<PrGenPlan> {
  const plan = await deps.store.loadPlan(ctx);
  if (!plan) throw new JobError({ retryable: false, code: 'prgen_plan_missing', summary: 'The approval/recommendation for PR generation was not found.', source: 'worker' });
  // Governance: never write to GitHub for an approval that isn't approved + unrevoked.
  if (plan.approvalState !== 'approved') throw new JobError({ retryable: false, code: 'approval_not_approved', summary: `Approval is ${plan.approvalState}, not approved — refusing to generate.`, source: 'worker' });
  return plan;
}

async function plan(deps: PrGenDeps, ctx: PrGenJobContext, jobId: string, now: () => Date): Promise<void> {
  const p = await loadApprovedPlan(deps, ctx);
  if (await deps.store.loadFileBaseline(jobId)) return; // resume: already snapshotted
  const file = await deps.mcp.readFile(p.repo, p.filePath, `refs/heads/${p.repo.defaultBranch}`);
  if (!file) throw new JobError({ retryable: false, code: 'prgen_file_missing', summary: `Target file ${p.filePath} not found on ${p.repo.defaultBranch}.`, source: 'github' });
  await deps.store.saveFileBaseline(jobId, ctx.workspaceId, ctx.recommendationId, p.filePath, file.content, file.sha, now().toISOString());
  await deps.store.setStepState(ctx.recommendationId, ctx.stepKey, 'generating', now().toISOString());
}

async function composePatch(deps: PrGenDeps, ctx: PrGenJobContext, jobId: string, registry: SchemaRegistry, now: () => Date): Promise<void> {
  if (await deps.store.loadPatch(jobId)) return; // resume guard: don't re-bill the gateway
  const p = await loadApprovedPlan(deps, ctx);
  const baseline = await deps.store.loadFileBaseline(jobId);
  if (!baseline) throw new JobError({ retryable: true, code: 'prgen_baseline_unavailable', summary: 'The target file baseline was not available.', source: 'worker' });
  const outcome: RunModelCallOutcome = await runModelCall(
    { gateway: deps.gateway, store: deps.modelStore, registry, now },
    {
      workspaceId: ctx.workspaceId,
      integrationId: p.integrationId ?? null,
      jobId,
      purpose: PATCH_PURPOSE,
      request: {
        apiSurface: 'agent_chat_completions',
        messages: buildPatchMessages({ repoFullName: p.repo.fullName, recommendationTitle: p.recommendationTitle, recommendationRationale: p.recommendationRationale, proposedNextStep: p.proposedNextStep, filePath: baseline.path, currentContent: baseline.content }),
        maxTokens: 4000,
      },
      requestSchemaVersion: 'pr_gen_request.v1',
      outputSchemaVersion: PR_GEN_SCHEMA_VERSION,
      parseStructured: parsePatch,
      gatewayBaseUrlName: 'truefoundry',
      subjectType: 'recommendation',
      subjectId: ctx.recommendationId,
    },
  );
  const patch = outcome.validation.status === 'valid' ? ((outcome.validation.value as PrGenPatch | undefined) ?? null) : null;
  await deps.store.savePatch(jobId, ctx.workspaceId, ctx.recommendationId, outcome.modelCallId, outcome.validation.status, patch, now().toISOString());
}

async function handoff(deps: PrGenDeps, ctx: PrGenJobContext, jobId: string, now: () => Date): Promise<void> {
  const p = await loadApprovedPlan(deps, ctx); // re-verify approved at execution time
  const loaded = await deps.store.loadPatch(jobId);
  if (!loaded) throw new JobError({ retryable: true, code: 'prgen_patch_unavailable', summary: 'The generated patch was not available.', source: 'worker' });
  if (loaded.validationStatus !== 'valid' || !loaded.patch) {
    // The model couldn't produce a valid patch — mark the step failed, don't write.
    await deps.store.setStepState(ctx.recommendationId, ctx.stepKey, 'failed', now().toISOString());
    return;
  }
  const patch = loaded.patch;
  // GOVERNANCE: only ever write the SINGLE approved target file (the recommendation's
  // affected file). A model (or prompt injection) returning extra/other paths is
  // ignored — we write exactly the baseline path, nothing else.
  const baseline = await deps.store.loadFileBaseline(jobId);
  if (!baseline) throw new JobError({ retryable: true, code: 'prgen_baseline_unavailable', summary: 'The target file baseline was not available.', source: 'worker' });
  const targetFile = patch.files.find((f) => f.path === baseline.path);
  if (!targetFile) {
    await deps.store.setStepState(ctx.recommendationId, ctx.stepKey, 'failed', now().toISOString());
    return;
  }
  const branch = prGenBranchName(ctx.recommendationId, ctx.stepKey);
  const requestHash = p.approvedPayloadHash; // ALL writes for this approval share its hash (ERD)
  // Bind the idempotency keys to the approval hash so a DIFFERENT approval (new
  // hash) for the same step can't reuse an old approval's write rows.
  const hk = (k: string) => `${k}:${requestHash.slice(0, 12)}`;
  const commitMsg = scrubSecrets(`instrument: ${targetFile.path}`).slice(0, 72);
  // Re-assert the approval is still approved+unrevoked before each provider write.
  const assertApproved = async () => {
    const fresh = await deps.store.loadPlan(ctx);
    if (!fresh || fresh.approvalState !== 'approved') throw new JobError({ retryable: false, code: 'approval_revoked', summary: 'The approval is no longer approved — stopping further writes.', source: 'worker' });
  };

  // 1. branch
  await execWrite(deps, ctx, jobId, hk(branchWriteKey(ctx.recommendationId, ctx.stepKey)), 'github_create_branch', `${p.repo.fullName} ${branch}`, requestHash, { branch }, assertApproved, now, async () => {
    await deps.mcp.createBranch(p.repo, branch, p.repo.defaultBranch);
    return { externalId: branch, externalUrl: null };
  });

  // 2. the single approved file — idempotent: skip the write if the branch already has the content
  await execWrite(deps, ctx, jobId, hk(fileWriteKey(ctx.recommendationId, ctx.stepKey, targetFile.path)), 'github_update_file', `${p.repo.fullName} ${targetFile.path}`, requestHash, { path: targetFile.path }, assertApproved, now, async () => {
    const existing = await deps.mcp.readFile(p.repo, targetFile.path, `refs/heads/${branch}`);
    if (existing && existing.content === targetFile.content) return { externalId: targetFile.path, externalUrl: null }; // already written (crash-resume)
    await deps.mcp.updateFile(p.repo, branch, targetFile.path, targetFile.content, commitMsg, existing?.sha ?? null);
    return { externalId: targetFile.path, externalUrl: null };
  });

  // 3. PR
  const body = buildPrBody({ summary: patch.pr_summary, recommendationTitle: p.recommendationTitle, rationale: p.recommendationRationale });
  let prNumber = 0;
  let prUrl = '';
  const prTitle = scrubSecrets(patch.pr_title).slice(0, 160);
  const prWrite = await execWrite(deps, ctx, jobId, hk(prWriteKey(ctx.recommendationId, ctx.stepKey)), 'github_create_pr', `${p.repo.fullName} PR for ${ctx.recommendationId}`, requestHash, { branch, title: prTitle }, assertApproved, now, async () => {
    const pr = await deps.mcp.createPr(p.repo, branch, p.repo.defaultBranch, prTitle, body);
    prNumber = pr.number;
    prUrl = pr.url;
    return { externalId: String(pr.number), externalUrl: pr.url };
  });
  // On resume (PR already created), recover number/url from the audit row.
  if (!prNumber && prWrite.externalId) prNumber = Number(prWrite.externalId) || 0;
  if (!prUrl && prWrite.externalUrl) prUrl = prWrite.externalUrl;

  // github_pull_requests is upserted by the Task 6 webhook when GitHub fires
  // `pull_request opened` for this generated PR; here we just link it on the step.
  if (prNumber) {
    await deps.store.setGeneratedPr(ctx.recommendationId, ctx.stepKey, { branch, url: prUrl, number: prNumber, files: [targetFile.path] }, now().toISOString());
  }
  // 'ready', NOT 'done' — a generated PR step completes only when the PR merges.
  await deps.store.setStepState(ctx.recommendationId, ctx.stepKey, 'ready', now().toISOString());
}

/**
 * Idempotently perform one provider write: reuse a prior `succeeded` row, else
 * insert `planned` → run `op` → mark `succeeded` (or `failed` + rethrow). The
 * external_write_actions unique key is the once-only backstop across retries.
 */
async function execWrite(
  deps: PrGenDeps,
  ctx: PrGenJobContext,
  jobId: string,
  key: string,
  actionKind: string,
  targetSummary: string,
  requestHash: string,
  requestRedacted: Record<string, unknown>,
  assertApproved: () => Promise<void>,
  now: () => Date,
  op: () => Promise<{ externalId: string | null; externalUrl: string | null }>,
): Promise<{ id: string; externalId: string | null; externalUrl: string | null }> {
  const prior = await deps.store.findExternalWrite(ctx.workspaceId, key);
  if (prior && prior.state === 'succeeded') return { id: prior.id, externalId: prior.externalId, externalUrl: prior.externalUrl };
  await assertApproved(); // re-verify the approval is still approved BEFORE this write
  const id =
    prior?.id ??
    (await deps.store.insertExternalWrite({ workspaceId: ctx.workspaceId, jobId, approvalId: ctx.approvalId, actionKind, idempotencyKey: key, targetSummary, requestHash, requestRedacted, now: now().toISOString() }));
  let res: { externalId: string | null; externalUrl: string | null };
  try {
    res = await op();
  } catch (err) {
    const code = err instanceof JobError ? err.code : 'github_write_failed';
    const summary = err instanceof JobError ? err.summary : 'A GitHub write failed.';
    await deps.store.markExternalWrite(id, { state: 'failed', errorCode: code, errorSummary: summary, now: now().toISOString() });
    throw err; // retryable per the JobError; the unique key makes the retry safe
  }
  await deps.store.markExternalWrite(id, { state: 'succeeded', externalId: res.externalId, externalUrl: res.externalUrl, now: now().toISOString() });
  return { id, externalId: res.externalId, externalUrl: res.externalUrl };
}

export { prGenPatchSchema } from './pr-gen';
