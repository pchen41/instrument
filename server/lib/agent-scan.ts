// Runtime-agnostic primary-branch scan executor (Task 7, slice B). A PhaseExecutor
// for `proactive_scan` jobs, dispatched alongside the investigation + PR-review
// executors. Pure TS, every side effect injected. Resumable by re-derivation:
// enumerate persists the changed code as evidence, analyze persists schema-valid
// findings as an evidence row, rank reads both back and upserts one
// category-`instrumentation` recommendation per gap (deduped by a stable
// dedupe_fingerprint, so a recurring gap folds onto the existing row across
// scans). On completion it runs one coalesced follow-up scan for the newest SHA.
import type { PhaseExecCtx, PhaseExecutor } from './agent';
import { type AgentInvoker, type ModelCallStore, type RunModelCallOutcome, runModelCall } from './model-call';
import { JobError } from './retry';
import { type SchemaRegistry, schemaRegistry, type ValidationStatus } from './schema-validation';
import {
  type ScanFinding,
  type ScanFindings,
  buildScanMessages,
  parseScanFindings,
  recommendationFields,
  SCAN_FINDINGS_SCHEMA_VERSION,
  scanDedupeFingerprint,
} from './scan';
import type { JobRow } from './types';

const FINDINGS_PURPOSE = 'instrumentation_findings';

export interface ScanJobContext {
  workspaceId: string;
  repositoryId: string;
  integrationId: string | null;
  repo: { owner: string; name: string; fullName: string };
  branch: string;
  headSha: string;
  beforeSha: string | null;
  pendingSha: string | null;
}

export function scanJobContext(job: JobRow): ScanJobContext | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ts = job.trigger_summary as Record<string, any> | undefined;
  const repo = ts?.repo as { owner?: string; name?: string; full_name?: string } | undefined;
  if (!ts || ts.source !== 'github_push' || typeof ts.after_sha !== 'string') return null;
  return {
    workspaceId: job.workspace_id,
    repositoryId: job.target_id,
    integrationId: (ts.integration_id as string | undefined) ?? null,
    repo: { owner: repo?.owner ?? '', name: repo?.name ?? '', fullName: repo?.full_name ?? `${repo?.owner}/${repo?.name}` },
    branch: typeof ts.branch === 'string' ? ts.branch : 'main',
    headSha: ts.after_sha,
    beforeSha: (ts.before_sha as string | undefined) ?? null,
    pendingSha: (ts.pending_sha as string | undefined) ?? null,
  };
}

export interface ChangedCodeRead {
  changedCode: string;
  files: { path: string }[];
  externalId: string;
  payload: unknown;
}
export interface ScanMcp {
  readChangedCode(ctx: ScanJobContext): Promise<ChangedCodeRead>;
}

export interface SaveCodeInput {
  workspaceId: string;
  jobId: string;
  repositoryId: string;
  externalId: string;
  title: string;
  summary: string;
  changedCode: string;
  payload: unknown;
  contentHash: string;
  now: string;
}
export interface SaveScanFindingsInput {
  workspaceId: string;
  jobId: string;
  repositoryId: string;
  modelCallId: string;
  validationStatus: ValidationStatus;
  findings: ScanFinding[];
  now: string;
}
export interface LoadedScanFindings {
  modelCallId: string;
  validationStatus: ValidationStatus;
  findings: ScanFinding[];
}
export interface UpsertInstrumentationInput {
  workspaceId: string;
  repositoryId: string;
  jobId: string;
  modelCallId: string;
  dedupeFingerprint: string;
  title: string;
  rationale: string;
  proposedNextStep: string;
  affectedCodePath: string;
  severity: string;
  now: string;
}
export interface ScanStore {
  hasCode(jobId: string): Promise<boolean>;
  saveCode(input: SaveCodeInput): Promise<void>;
  loadCode(jobId: string): Promise<string | null>;
  saveFindings(input: SaveScanFindingsInput): Promise<void>;
  loadFindings(jobId: string): Promise<LoadedScanFindings | null>;
  upsertInstrumentationRecommendation(input: UpsertInstrumentationInput): Promise<{ id: string; created: boolean }>;
  enqueueFollowupScan(workspaceId: string, repositoryId: string, repo: ScanJobContext['repo'], branch: string, sha: string, now: string): Promise<void>;
  /** Enqueue ONE recommendation_generation job for Datadog alert coverage (idempotent per repo+sha). */
  enqueueAlertCoverage(ctx: ScanJobContext, scanJobId: string, now: string): Promise<void>;
  /** The LIVE pending_sha from the job row (a push may have coalesced AFTER this scan was claimed). */
  loadPendingSha(jobId: string): Promise<string | null>;
  /** The changed file paths this scan examined (for invalidating stale recommendations). */
  loadChangedFiles(jobId: string): Promise<string[]>;
  /** Active category-`instrumentation` recommendations for the repo (for the outdating sweep). */
  listActiveInstrumentation(repositoryId: string): Promise<{ id: string; dedupeFingerprint: string; affectedCodePath: string }[]>;
  /** Mark a recommendation `outdated` with a reason (lifecycle invalidation). */
  outdateRecommendation(id: string, reason: string, now: string): Promise<void>;
}

export interface ScanDeps {
  gateway: AgentInvoker;
  modelStore: ModelCallStore;
  mcp: ScanMcp;
  store: ScanStore;
  registry?: SchemaRegistry;
  now?: () => Date;
}

export function makeScanExecutor(deps: ScanDeps): PhaseExecutor {
  const now = deps.now ?? (() => new Date());
  const registry = deps.registry ?? schemaRegistry;
  return async ({ job, phaseKey }: PhaseExecCtx) => {
    if (job.job_type !== 'proactive_scan') return; // not ours
    const ctx = scanJobContext(job);
    if (!ctx) throw new JobError({ retryable: false, code: 'scan_context_missing', summary: 'Scan job is missing its push trigger context.', source: 'worker' });
    switch (phaseKey) {
      case 'enumerate':
        await enumerate(deps, ctx, job.id, now);
        break;
      case 'analyze':
        await analyze(deps, ctx, job.id, registry, now);
        break;
      case 'rank':
        await rank(deps, ctx, job.id, now);
        break;
    }
  };
}

async function enumerate(deps: ScanDeps, ctx: ScanJobContext, jobId: string, now: () => Date): Promise<void> {
  if (await deps.store.hasCode(jobId)) return;
  const read = await deps.mcp.readChangedCode(ctx);
  await deps.store.saveCode({
    workspaceId: ctx.workspaceId,
    jobId,
    repositoryId: ctx.repositoryId,
    externalId: read.externalId,
    title: `Primary-branch push ${ctx.headSha.slice(0, 7)}`,
    summary: `${read.files.length} changed file(s) on ${ctx.branch}`,
    changedCode: read.changedCode,
    payload: read.payload,
    contentHash: read.externalId,
    now: now().toISOString(),
  });
}

async function analyze(deps: ScanDeps, ctx: ScanJobContext, jobId: string, registry: SchemaRegistry, now: () => Date): Promise<void> {
  // Resume guard: if findings already persisted, don't re-invoke (re-bill) the gateway.
  if (await deps.store.loadFindings(jobId)) return;
  const changedCode = await deps.store.loadCode(jobId);
  if (changedCode === null) throw new JobError({ retryable: true, code: 'scan_code_unavailable', summary: 'The scanned code was not available for analysis.', source: 'worker' });
  const outcome: RunModelCallOutcome = await runModelCall(
    { gateway: deps.gateway, store: deps.modelStore, registry, now },
    {
      workspaceId: ctx.workspaceId,
      integrationId: ctx.integrationId ?? null,
      jobId,
      purpose: FINDINGS_PURPOSE,
      request: {
        apiSurface: 'agent_chat_completions',
        messages: buildScanMessages({ repoFullName: ctx.repo.fullName, branch: ctx.branch, headSha: ctx.headSha, changedCode }),
        maxTokens: 3000,
      },
      requestSchemaVersion: 'instrumentation_request.v1',
      outputSchemaVersion: SCAN_FINDINGS_SCHEMA_VERSION,
      parseStructured: parseScanFindings,
      gatewayBaseUrlName: 'truefoundry',
      subjectType: 'repository', // scan evidence is repository-scoped (subjectId = repositoryId)
      subjectId: ctx.repositoryId,
    },
  );
  const findings = outcome.validation.status === 'valid' ? ((outcome.validation.value as ScanFindings | undefined)?.findings ?? []) : [];
  await deps.store.saveFindings({ workspaceId: ctx.workspaceId, jobId, repositoryId: ctx.repositoryId, modelCallId: outcome.modelCallId, validationStatus: outcome.validation.status, findings, now: now().toISOString() });
}

async function rank(deps: ScanDeps, ctx: ScanJobContext, jobId: string, now: () => Date): Promise<void> {
  const loaded = await deps.store.loadFindings(jobId);
  if (!loaded) throw new JobError({ retryable: true, code: 'scan_findings_unavailable', summary: 'Scan findings were not available to rank.', source: 'worker' });

  if (loaded.validationStatus === 'valid') {
    const currentFingerprints = new Set<string>();
    for (const finding of loaded.findings) {
      const fingerprint = scanDedupeFingerprint(ctx.repo.fullName, finding);
      currentFingerprints.add(fingerprint);
      const fields = recommendationFields(finding);
      await deps.store.upsertInstrumentationRecommendation({
        workspaceId: ctx.workspaceId,
        repositoryId: ctx.repositoryId,
        jobId,
        modelCallId: loaded.modelCallId,
        dedupeFingerprint: fingerprint,
        title: fields.title,
        rationale: fields.rationale,
        proposedNextStep: fields.proposedNextStep,
        affectedCodePath: fields.affectedCodePath,
        severity: finding.severity,
        now: now().toISOString(),
      });
    }

    // Outdating lifecycle: a previously-recommended instrumentation gap in a file
    // THIS scan re-examined (the file was in the changed set) but did NOT re-flag is
    // treated as resolved/removed → mark it `outdated`. Recommendations for files
    // this scan didn't touch are left untouched (not re-evaluated). This is bounded
    // by the scan's changed-file scope, so it won't outdate unrelated findings.
    const changedFiles = new Set(await deps.store.loadChangedFiles(jobId));
    if (changedFiles.size > 0) {
      const active = await deps.store.listActiveInstrumentation(ctx.repositoryId);
      for (const rec of active) {
        const recFile = rec.affectedCodePath.split(':')[0];
        if (changedFiles.has(recFile) && !currentFingerprints.has(rec.dedupeFingerprint)) {
          await deps.store.outdateRecommendation(rec.id, 'code_changed', now().toISOString());
        }
      }
    }
  }

  // Alert-coverage handoff (Task 9 slice 2): enqueue ONE recommendation_generation
  // job to analyze this repo's Datadog monitor/metric coverage and generate `alert`
  // recommendations. Idempotent per repo+sha, and a separate durable job so the
  // scan's own success isn't tied to Datadog availability.
  await deps.store.enqueueAlertCoverage(ctx, jobId, now().toISOString());

  // Coalesced follow-up: read the LIVE pending_sha (a push may have coalesced AFTER
  // this scan was claimed — ctx is the frozen claim-time snapshot). Run ONE more
  // scan for the newest SHA, idempotent on scan:repo:sha so a re-run is a no-op.
  const pendingSha = await deps.store.loadPendingSha(jobId);
  if (pendingSha && pendingSha !== ctx.headSha) {
    await deps.store.enqueueFollowupScan(ctx.workspaceId, ctx.repositoryId, ctx.repo, ctx.branch, pendingSha, now().toISOString());
  }
}
