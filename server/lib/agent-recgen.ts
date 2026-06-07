// Runtime-agnostic Datadog alert-coverage executor (Task 9, slice 2). A
// PhaseExecutor for `recommendation_generation` jobs — the recommendation flow the
// primary-branch scan (Task 7) enqueues for alert coverage. It does NOT mutate
// Datadog; it generates `alert` recommendations whose approved new-monitor steps
// the slice-1 `datadog_alert_generation` executor later creates as drafts.
//
// Phases (PHASE_PLANS.recommendation_generation):
//   gather   — read the namespace's metrics + monitors, compute coverage, persist
//              a coverage evidence snapshot (idempotent).
//   draft    — one model call proposing alert findings (new-monitor specs +
//              improvement diffs); persist the findings as evidence (no re-bill on
//              resume).
//   validate — deterministically verify each finding (coverage + metric-existence
//              gates) and upsert one `alert` recommendation per surviving finding.
import type { PhaseExecCtx, PhaseExecutor } from './agent';
import {
  type AlertFinding,
  type MonitorSnapshot,
  ALERT_FINDINGS_SCHEMA_VERSION,
  buildAlertCoverageMessages,
  metricCoverage,
  parseAlertFindings,
  selectAlertRecommendations,
} from './alert-coverage';
import { type AgentInvoker, type ModelCallStore, type RunModelCallOutcome, runModelCall } from './model-call';
import { JobError } from './retry';
import { type SchemaRegistry, schemaRegistry, type ValidationStatus } from './schema-validation';
import type { JobRow } from './types';

const FINDINGS_PURPOSE = 'alert_coverage_findings';

export interface RecGenJobContext {
  workspaceId: string;
  repositoryId: string;
  integrationId: string | null;
  repo: { owner: string; name: string; fullName: string };
  branch: string;
  namespace: string;
  headSha: string | null;
  scanJobId: string | null;
}

export function recGenJobContext(job: JobRow): RecGenJobContext | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ts = job.trigger_summary as Record<string, any> | undefined;
  if (!ts || ts.source !== 'alert_coverage' || job.target_type !== 'repository' || !job.target_id) return null;
  const repo = ts.repo as { owner?: string; name?: string; full_name?: string } | undefined;
  const namespace = typeof ts.namespace === 'string' && ts.namespace.trim() ? ts.namespace.trim() : repo?.name ?? '';
  return {
    workspaceId: job.workspace_id,
    repositoryId: job.target_id,
    integrationId: (ts.integration_id as string | undefined) ?? null,
    repo: { owner: repo?.owner ?? '', name: repo?.name ?? '', fullName: repo?.full_name ?? `${repo?.owner}/${repo?.name}` },
    branch: typeof ts.branch === 'string' ? ts.branch : 'main',
    namespace,
    headSha: (ts.head_sha as string | undefined) ?? null,
    scanJobId: (ts.scan_job_id as string | undefined) ?? null,
  };
}

// ---- injected interfaces -----------------------------------------------------

export interface CoverageSnapshot {
  metrics: string[];
  monitors: MonitorSnapshot[];
  uncovered: string[];
  covered: string[];
  instrumentationGaps: string[];
}

export interface RecGenMcp {
  /** Metric names in the namespace (search_datadog_metrics name_filter). */
  listMetrics(namespace: string): Promise<string[]>;
  /** Existing monitors matching the namespace, each with its alert query (search_datadog_monitors). */
  listMonitors(namespace: string): Promise<MonitorSnapshot[]>;
}

export interface SaveCoverageInput {
  workspaceId: string;
  jobId: string;
  repositoryId: string;
  namespace: string;
  snapshot: CoverageSnapshot;
  now: string;
}
export interface SaveFindingsInput {
  workspaceId: string;
  jobId: string;
  repositoryId: string;
  modelCallId: string;
  validationStatus: ValidationStatus;
  findings: AlertFinding[];
  now: string;
}
export interface LoadedFindings {
  modelCallId: string;
  validationStatus: ValidationStatus;
  findings: AlertFinding[];
}
export interface UpsertAlertInput {
  workspaceId: string;
  repositoryId: string;
  jobId: string;
  modelCallId: string;
  namespace: string;
  dedupeFingerprint: string;
  title: string;
  rationale: string;
  serviceName: string | null;
  proposedNextStep: string;
  severity: 'low' | 'medium' | 'high';
  step: Record<string, unknown>;
  now: string;
}

export interface RecGenStore {
  hasCoverage(jobId: string): Promise<boolean>;
  saveCoverage(input: SaveCoverageInput): Promise<void>;
  loadCoverage(jobId: string): Promise<CoverageSnapshot | null>;
  saveFindings(input: SaveFindingsInput): Promise<void>;
  loadFindings(jobId: string): Promise<LoadedFindings | null>;
  /** Instrumentation-gap titles the originating scan found (gates expected_after_step). */
  loadScanGaps(scanJobId: string | null): Promise<string[]>;
  upsertAlertRecommendation(input: UpsertAlertInput): Promise<{ id: string; created: boolean }>;
}

export interface RecGenDeps {
  gateway: AgentInvoker;
  modelStore: ModelCallStore;
  mcp: RecGenMcp;
  store: RecGenStore;
  registry?: SchemaRegistry;
  now?: () => Date;
}

export function makeRecGenExecutor(deps: RecGenDeps): PhaseExecutor {
  const now = deps.now ?? (() => new Date());
  const registry = deps.registry ?? schemaRegistry;
  return async ({ job, phaseKey }: PhaseExecCtx) => {
    if (job.job_type !== 'recommendation_generation') return; // not ours
    const ctx = recGenJobContext(job);
    if (!ctx) throw new JobError({ retryable: false, code: 'recgen_context_missing', summary: 'Recommendation-generation job is missing its alert-coverage context.', source: 'worker' });
    switch (phaseKey) {
      case 'gather':
        await gather(deps, ctx, job.id, now);
        break;
      case 'draft':
        await draft(deps, ctx, job.id, registry, now);
        break;
      case 'validate':
        await validate(deps, ctx, job.id, now);
        break;
    }
  };
}

async function gather(deps: RecGenDeps, ctx: RecGenJobContext, jobId: string, now: () => Date): Promise<void> {
  if (await deps.store.hasCoverage(jobId)) return; // resume: snapshot already taken
  const [metrics, monitors, instrumentationGaps] = await Promise.all([
    deps.mcp.listMetrics(ctx.namespace),
    deps.mcp.listMonitors(ctx.namespace),
    deps.store.loadScanGaps(ctx.scanJobId),
  ]);
  const { covered, uncovered } = metricCoverage(metrics, monitors);
  await deps.store.saveCoverage({
    workspaceId: ctx.workspaceId,
    jobId,
    repositoryId: ctx.repositoryId,
    namespace: ctx.namespace,
    snapshot: { metrics, monitors, covered, uncovered, instrumentationGaps },
    now: now().toISOString(),
  });
}

async function draft(deps: RecGenDeps, ctx: RecGenJobContext, jobId: string, registry: SchemaRegistry, now: () => Date): Promise<void> {
  if (await deps.store.loadFindings(jobId)) return; // resume: don't re-invoke (re-bill) the gateway
  const coverage = await deps.store.loadCoverage(jobId);
  if (!coverage) throw new JobError({ retryable: true, code: 'recgen_coverage_unavailable', summary: 'The coverage snapshot was not available to draft from.', source: 'worker' });
  const outcome: RunModelCallOutcome = await runModelCall(
    { gateway: deps.gateway, store: deps.modelStore, registry, now },
    {
      workspaceId: ctx.workspaceId,
      integrationId: ctx.integrationId ?? null,
      jobId,
      purpose: FINDINGS_PURPOSE,
      request: {
        apiSurface: 'agent_chat_completions',
        messages: buildAlertCoverageMessages({
          repoFullName: ctx.repo.fullName,
          namespace: ctx.namespace,
          uncoveredMetrics: coverage.uncovered,
          coveredMetrics: coverage.covered,
          existingMonitors: coverage.monitors,
          instrumentationGaps: coverage.instrumentationGaps,
        }),
        maxTokens: 3000,
      },
      requestSchemaVersion: 'alert_coverage_request.v1',
      outputSchemaVersion: ALERT_FINDINGS_SCHEMA_VERSION,
      parseStructured: parseAlertFindings,
      gatewayBaseUrlName: 'truefoundry',
      subjectType: 'repository',
      subjectId: ctx.repositoryId,
    },
  );
  const findings = outcome.validation.status === 'valid' ? ((outcome.validation.value as { findings?: AlertFinding[] } | undefined)?.findings ?? []) : [];
  await deps.store.saveFindings({ workspaceId: ctx.workspaceId, jobId, repositoryId: ctx.repositoryId, modelCallId: outcome.modelCallId, validationStatus: outcome.validation.status, findings, now: now().toISOString() });
}

async function validate(deps: RecGenDeps, ctx: RecGenJobContext, jobId: string, now: () => Date): Promise<void> {
  const loaded = await deps.store.loadFindings(jobId);
  if (!loaded) throw new JobError({ retryable: true, code: 'recgen_findings_unavailable', summary: 'Alert findings were not available to validate.', source: 'worker' });
  if (loaded.validationStatus !== 'valid') return; // nothing creatable from invalid/empty output
  const coverage = await deps.store.loadCoverage(jobId);
  if (!coverage) throw new JobError({ retryable: true, code: 'recgen_coverage_unavailable', summary: 'The coverage snapshot was not available to validate against.', source: 'worker' });

  const upserts = selectAlertRecommendations({
    namespace: ctx.namespace,
    findings: loaded.findings,
    liveMetrics: coverage.metrics,
    coveredMetrics: coverage.covered,
    existingMonitors: coverage.monitors,
    hasInstrumentationGaps: coverage.instrumentationGaps.length > 0,
  });
  for (const u of upserts) {
    await deps.store.upsertAlertRecommendation({
      workspaceId: ctx.workspaceId,
      repositoryId: ctx.repositoryId,
      jobId,
      modelCallId: loaded.modelCallId,
      namespace: ctx.namespace,
      dedupeFingerprint: u.dedupeFingerprint,
      title: u.title,
      rationale: u.rationale,
      serviceName: u.serviceName,
      proposedNextStep: u.proposedNextStep,
      severity: u.severity,
      step: u.step,
      now: now().toISOString(),
    });
  }
}
