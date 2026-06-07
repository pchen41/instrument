// Runtime-agnostic Datadog draft-alert executor (Task 9). A PhaseExecutor for
// `datadog_alert_generation` jobs (phases inspect → draft_monitor → validate).
// Approval-gated + idempotent, mirroring the Task 8 PR-generation executor:
//   inspect       — verify the approval is `approved`, load the approved monitor
//                    spec, and GATE on metric existence (an unverified metric must
//                    not produce a creatable alert).
//   draft_monitor — create ONE draft (non-notifying) Datadog monitor via the
//                    governed MCP path, as a single external_write_actions row
//                    carrying the approval's approved_payload_hash; idempotent via
//                    the succeeded-row check + a marker-tag recovery search.
//   validate      — finalize: link the draft monitor on the step, leave it `ready`.
import type { PhaseExecCtx, PhaseExecutor } from './agent';
import {
  type DdMonitorSpec,
  type MetricVerification,
  buildDraftMonitor,
  canCreateAlert,
  metricVerification,
  monitorMarkerTag,
  monitorWriteKey,
} from './datadog-alert';
import { JobError } from './retry';
import type { JobRow } from './types';

export interface DdAlertJobContext {
  workspaceId: string;
  recommendationId: string;
  stepKey: string | null;
  approvalId: string | null;
}

export function ddAlertJobContext(job: JobRow): DdAlertJobContext | null {
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

export interface DdAlertPlan {
  approvalState: string;
  approvedPayloadHash: string;
  recommendationTitle: string;
  /** Whether a prerequisite metric-instrumentation step is already done. */
  prerequisiteStepDone: boolean;
  spec: DdMonitorSpec;
}
export interface CreatedMonitor {
  id: number;
  url: string;
}
export interface DdAlertMcp {
  /** True if the named metric currently exists in Datadog (search_datadog_metrics). */
  metricExists(metricName: string): Promise<boolean>;
  /** Create a draft (non-notifying) monitor; returns its Datadog id + link. */
  createMonitor(payload: ReturnType<typeof buildDraftMonitor>): Promise<CreatedMonitor>;
  /** Recover an already-created monitor by its deterministic marker tag (crash-resume). */
  findMonitorByTag(markerTag: string): Promise<CreatedMonitor | null>;
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
export interface DdAlertStore {
  loadPlan(ctx: DdAlertJobContext): Promise<DdAlertPlan | null>;
  setStepState(recommendationId: string, stepKey: string | null, state: string, now: string): Promise<void>;
  setMetricVerification(recommendationId: string, stepKey: string | null, state: MetricVerification, now: string): Promise<void>;
  setGeneratedMonitor(recommendationId: string, stepKey: string | null, monitor: { monitor_id: number; name: string; url: string; draft: boolean }, now: string): Promise<void>;
  findExternalWrite(workspaceId: string, key: string): Promise<{ id: string; state: string; externalId: string | null; externalUrl: string | null } | null>;
  insertExternalWrite(input: ExternalWriteInsert): Promise<string>;
  markExternalWrite(id: string, patch: { state: string; externalId?: string | null; externalUrl?: string | null; errorCode?: string | null; errorSummary?: string | null; now: string }): Promise<void>;
}

export interface DdAlertDeps {
  mcp: DdAlertMcp;
  store: DdAlertStore;
  now?: () => Date;
}

export function makeDdAlertExecutor(deps: DdAlertDeps): PhaseExecutor {
  const now = deps.now ?? (() => new Date());
  return async ({ job, phaseKey }: PhaseExecCtx) => {
    if (job.job_type !== 'datadog_alert_generation') return; // not ours
    const ctx = ddAlertJobContext(job);
    if (!ctx || !ctx.approvalId) throw new JobError({ retryable: false, code: 'ddalert_context_missing', summary: 'Datadog alert job is missing its approval/recommendation context.', source: 'worker' });
    switch (phaseKey) {
      case 'inspect':
        await inspect(deps, ctx, now);
        break;
      case 'draft_monitor':
        await draftMonitor(deps, ctx, job.id, now);
        break;
      case 'validate':
        await validate(deps, ctx, now);
        break;
    }
  };
}

/** Load the approval/recommendation; refuse unless it's approved with a payload hash. */
async function loadApprovedPlan(deps: DdAlertDeps, ctx: DdAlertJobContext): Promise<DdAlertPlan> {
  const plan = await deps.store.loadPlan(ctx);
  if (!plan) throw new JobError({ retryable: false, code: 'ddalert_plan_missing', summary: 'The approval/recommendation for the Datadog alert was not found.', source: 'worker' });
  if (plan.approvalState !== 'approved') throw new JobError({ retryable: false, code: 'approval_not_approved', summary: `Approval is ${plan.approvalState}, not approved — refusing to create a monitor.`, source: 'worker' });
  if (!plan.approvedPayloadHash) throw new JobError({ retryable: false, code: 'approval_hash_missing', summary: 'Approval has no approved_payload_hash — refusing to create a monitor.', source: 'worker' });
  return plan;
}

async function inspect(deps: DdAlertDeps, ctx: DdAlertJobContext, now: () => Date): Promise<void> {
  const p = await loadApprovedPlan(deps, ctx);
  // Metric-verification GATE: an alert is only creatable on a metric that exists
  // now (verified_in_datadog). expected_after_step / unverified must not create.
  const exists = await deps.mcp.metricExists(p.spec.metric_name);
  const verification = metricVerification(exists, p.prerequisiteStepDone);
  await deps.store.setMetricVerification(ctx.recommendationId, ctx.stepKey, verification, now().toISOString());
  if (!canCreateAlert(verification)) {
    await deps.store.setStepState(ctx.recommendationId, ctx.stepKey, 'failed', now().toISOString());
    throw new JobError({ retryable: false, code: 'metric_unverified', summary: `Metric ${p.spec.metric_name} is ${verification} — refusing to create an alert on a metric that does not exist.`, source: 'datadog' });
  }
  await deps.store.setStepState(ctx.recommendationId, ctx.stepKey, 'generating', now().toISOString());
}

async function draftMonitor(deps: DdAlertDeps, ctx: DdAlertJobContext, jobId: string, now: () => Date): Promise<void> {
  const p = await loadApprovedPlan(deps, ctx); // re-verify approved at execution time
  const payload = buildDraftMonitor(p.spec, p.recommendationTitle, ctx.recommendationId, ctx.stepKey);
  const requestHash = p.approvedPayloadHash;
  const key = `${monitorWriteKey(ctx.recommendationId, ctx.stepKey)}:${requestHash.slice(0, 12)}`;
  const markerTag = monitorMarkerTag(ctx.recommendationId, ctx.stepKey);

  const prior = await deps.store.findExternalWrite(ctx.workspaceId, key);
  if (prior && prior.state === 'succeeded' && prior.externalId) {
    await deps.store.setGeneratedMonitor(ctx.recommendationId, ctx.stepKey, { monitor_id: Number(prior.externalId), name: payload.name, url: prior.externalUrl ?? '', draft: true }, now().toISOString());
    return;
  }
  // Re-enforce the metric-verification GATE here too (not only in inspect): this
  // phase can run on its own (resume / direct dispatch), and a monitor must NEVER
  // be created on a metric that isn't verified to exist now.
  const verification = metricVerification(await deps.mcp.metricExists(p.spec.metric_name), p.prerequisiteStepDone);
  if (!canCreateAlert(verification)) {
    await deps.store.setMetricVerification(ctx.recommendationId, ctx.stepKey, verification, now().toISOString());
    await deps.store.setStepState(ctx.recommendationId, ctx.stepKey, 'failed', now().toISOString());
    throw new JobError({ retryable: false, code: 'metric_unverified', summary: `Metric ${p.spec.metric_name} is ${verification} — refusing to create an alert.`, source: 'datadog' });
  }
  // Re-assert approval immediately before the write, bound to the SAME payload hash
  // we're about to write — so a swapped/re-hashed approval can't authorize this spec.
  const fresh = await deps.store.loadPlan(ctx);
  if (!fresh || fresh.approvalState !== 'approved' || fresh.approvedPayloadHash !== requestHash) {
    throw new JobError({ retryable: false, code: 'approval_invalidated', summary: 'The approval is no longer approved, or its payload hash changed — refusing to create a monitor.', source: 'worker' });
  }

  const id = prior?.id ?? (await deps.store.insertExternalWrite({ workspaceId: ctx.workspaceId, jobId, approvalId: ctx.approvalId, actionKind: 'datadog_create_monitor', idempotencyKey: key, targetSummary: payload.name, requestHash, requestRedacted: { metric: p.spec.metric_name, query: p.spec.query, type: payload.type }, now: now().toISOString() }));
  let monitor: CreatedMonitor;
  try {
    // Crash-resume: a previous attempt may have created the monitor but failed
    // before marking the write succeeded — recover it by its marker tag instead
    // of creating a duplicate.
    monitor = (await deps.mcp.findMonitorByTag(markerTag)) ?? (await deps.mcp.createMonitor(payload));
  } catch (err) {
    const code = err instanceof JobError ? err.code : 'datadog_monitor_failed';
    const summary = err instanceof JobError ? err.summary : 'Creating the Datadog monitor failed.';
    await deps.store.markExternalWrite(id, { state: 'failed', errorCode: code, errorSummary: summary, now: now().toISOString() });
    throw err;
  }
  await deps.store.markExternalWrite(id, { state: 'succeeded', externalId: String(monitor.id), externalUrl: monitor.url, now: now().toISOString() });
  await deps.store.setGeneratedMonitor(ctx.recommendationId, ctx.stepKey, { monitor_id: monitor.id, name: payload.name, url: monitor.url, draft: true }, now().toISOString());
}

async function validate(deps: DdAlertDeps, ctx: DdAlertJobContext, now: () => Date): Promise<void> {
  // The draft monitor exists in Datadog (external_state 'draft'); leave the step
  // `ready` — a human publishes/tunes it, which is out of first-slice scope.
  await deps.store.setStepState(ctx.recommendationId, ctx.stepKey, 'ready', now().toISOString());
}
