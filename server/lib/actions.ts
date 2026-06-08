import type { JobsDb } from './db';
import { hashPayload } from './hash';
import { generationKey, investigationKey } from './idempotency';
import { DEFAULT_RETRY_POLICY } from './retry';
import {
  assertApprovalTransition,
  assertRecommendationTransition,
  canRetryJob,
  canStartInvestigation,
  TransitionError,
} from './transitions';
import { isoSeconds, LEASE_FREE, type Clock } from './time';
import type { JobRow, JobType, RecommendationState } from './types';

// User-triggered mutation endpoints (docs/ERD.md: "User-initiated mutations
// should go through small Edge Function endpoints using server-only
// credentials"). Each validates workspace membership against the *target's*
// workspace, then the allowed transition / idempotency key / payload hash, before
// any privileged write. Browser RLS is select-only, so this is the only write path.

export class ActionError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
    this.code = code;
  }
}

export interface ActionContext {
  userId: string;
  clock: Clock;
}

export type ActionRequest =
  | { action: 'start_investigation'; incident_id: string }
  | { action: 'retry_job'; job_id: string }
  | { action: 'set_recommendation_state'; recommendation_id: string; state: 'dismissed' | 'active' }
  | { action: 'set_investigation_mode'; workspace_id: string; mode: 'manual' | 'auto' | 'smart' }
  | {
      action: 'request_approval';
      target_type: string;
      target_id: string;
      target_step_key?: string | null;
      action_type: string;
      approval_summary: string;
      payload: unknown;
    }
  | { action: 'decide_approval'; approval_id: string; decision: 'approved' | 'rejected' | 'revoked'; payload?: unknown }
  | { action: 'enqueue_generation'; approval_id: string };

export interface ActionResult {
  ok: true;
  [key: string]: unknown;
}

export async function handleAction(db: JobsDb, ctx: ActionContext, req: ActionRequest): Promise<ActionResult> {
  try {
    switch (req.action) {
      case 'start_investigation':
        return await startInvestigation(db, ctx, req.incident_id);
      case 'retry_job':
        return await retryJob(db, ctx, req.job_id);
      case 'set_recommendation_state':
        return await setRecommendationState(db, ctx, req.recommendation_id, req.state);
      case 'set_investigation_mode':
        return await setInvestigationMode(db, ctx, req.workspace_id, req.mode);
      case 'request_approval':
        return await requestApproval(db, ctx, req);
      case 'decide_approval':
        return await decideApproval(db, ctx, req);
      case 'enqueue_generation':
        return await enqueueGeneration(db, ctx, req.approval_id);
      default:
        throw new ActionError(400, 'unknown_action', 'Unknown action.');
    }
  } catch (err) {
    if (err instanceof ActionError) throw err;
    if (err instanceof TransitionError) throw new ActionError(409, 'invalid_transition', err.message);
    throw err;
  }
}

// ---- Membership -------------------------------------------------------------

async function assertMember(db: JobsDb, workspaceId: string, userId: string): Promise<void> {
  const ok = await db.isWorkspaceMember(workspaceId, userId);
  if (!ok) throw new ActionError(403, 'not_a_member', 'You are not a member of this workspace.');
}

// ---- Investigations ---------------------------------------------------------

async function startInvestigation(db: JobsDb, ctx: ActionContext, incidentId: string): Promise<ActionResult> {
  if (!incidentId) throw new ActionError(400, 'bad_request', 'incident_id is required.');
  const incident = await db.getIncident(incidentId);
  if (!incident) throw new ActionError(404, 'not_found', 'Incident not found.');
  await assertMember(db, incident.workspace_id, ctx.userId);

  const key = investigationKey(incidentId);
  // Idempotent first: a duplicate click (same idempotency key) collapses onto the
  // same durable job before the "already investigating" guard can reject it.
  const dup = await db.findJobByIdempotency(incident.workspace_id, 'incident_investigation', key);
  if (dup) {
    if (incident.investigation_job_id !== dup.id) {
      await db.updateIncident(incidentId, { investigation_job_id: dup.id });
    }
    return { ok: true, job_id: dup.id, deduped: true };
  }

  // No prior job for this incident: only block if some *other* investigation is
  // already attached (a seeded/in-flight job that isn't ours).
  const existing = incident.investigation_job_id ? await db.getJob(incident.investigation_job_id) : null;
  if (!canStartInvestigation(existing)) {
    throw new ActionError(409, 'already_investigating', 'This incident already has an investigation.');
  }

  const job = await db.insertJob(
    newJob(ctx, {
      workspace_id: incident.workspace_id,
      job_type: 'incident_investigation',
      target_type: 'incident',
      target_id: incidentId,
      idempotency_key: key,
      trigger_summary: { source: 'console' },
    }),
  );
  await db.updateIncident(incidentId, { investigation_job_id: job.id });
  return { ok: true, job_id: job.id, deduped: false };
}

async function retryJob(db: JobsDb, ctx: ActionContext, jobId: string): Promise<ActionResult> {
  if (!jobId) throw new ActionError(400, 'bad_request', 'job_id is required.');
  const job = await db.getJob(jobId);
  if (!job) throw new ActionError(404, 'not_found', 'Job not found.');
  await assertMember(db, job.workspace_id, ctx.userId);
  if (!canRetryJob(job)) {
    throw new ActionError(409, 'not_retryable', 'This job is not in a safe, retryable failed state.');
  }
  const at = isoSeconds(ctx.clock.now());
  await requeueFailedJob(db, job, at, 'Manual retry requested by a workspace member.');
  await markStepGenerating(db, job);
  return { ok: true, job_id: jobId };
}

/**
 * Re-queue a safely-failed job in place: the SAME durable row, preserved phases, a
 * fresh attempt budget (the configured per-retry budget added on top of attempts
 * already spent, so retries grow 3 → 6 → 9, never double), cleared error. Shared by
 * manual retry and re-generation so neither duplicates the job or its provider writes.
 */
async function requeueFailedJob(db: JobsDb, job: JobRow, at: string, note: string): Promise<void> {
  const retryBudget = job.retry_policy?.max_attempts ?? DEFAULT_RETRY_POLICY.max_attempts;
  await db.updateJob(job.id, {
    state: 'queued',
    next_run_at: at,
    queued_at: at,
    lease_expires_at: LEASE_FREE,
    locked_by: null,
    error_code: null,
    error_summary: null,
    failure_source: null,
    completed_at: null,
    max_attempts: job.attempt_count + retryBudget,
    audit_events: [...(job.audit_events ?? []), { at, kind: 'manual_retry', summary: note }],
    progress_version: job.progress_version + 1,
  });
}

/**
 * Flip a recommendation step back to `generating` so the card reflects a (re)started
 * generation immediately. The worker skips already-`succeeded` phases on resume, so
 * the executor's own plan-phase step-set never re-runs on a retry — hence we set it
 * here. No-op for non-recommendation jobs (e.g. incident investigations).
 */
async function markStepGenerating(
  db: JobsDb,
  t: { target_type: string; target_id?: string | null; target_step_key?: string | null },
): Promise<void> {
  if (t.target_type !== 'recommendation' || !t.target_id || !t.target_step_key) return;
  const rec = await db.getRecommendation(t.target_id);
  if (!rec?.steps) return;
  const steps = rec.steps.map((s) => (s.key === t.target_step_key ? { ...s, state: 'generating' } : s));
  await db.updateRecommendation(rec.id, { steps });
}

// ---- Recommendations --------------------------------------------------------

async function setRecommendationState(
  db: JobsDb,
  ctx: ActionContext,
  recommendationId: string,
  to: 'dismissed' | 'active',
): Promise<ActionResult> {
  const rec = await db.getRecommendation(recommendationId);
  if (!rec) throw new ActionError(404, 'not_found', 'Recommendation not found.');
  await assertMember(db, rec.workspace_id, ctx.userId);
  assertRecommendationTransition(rec.state, to as RecommendationState);

  const at = isoSeconds(ctx.clock.now());
  const event = to === 'dismissed' ? 'dismissed' : 'restored';
  // Conditional on the state we validated against — a concurrent change → 409.
  const ok = await db.updateRecommendation(
    recommendationId,
    {
      state: to,
      dismissed_at: to === 'dismissed' ? at : null,
      lifecycle_events: [
        ...(rec.lifecycle_events ?? []),
        { at, event, detail: `${event} by a workspace member` },
      ],
    },
    rec.state,
  );
  if (!ok) throw new ActionError(409, 'conflict', 'The recommendation changed before this could be applied. Please retry.');
  return { ok: true, state: to };
}

// ---- Workspace settings -----------------------------------------------------

async function setInvestigationMode(
  db: JobsDb,
  ctx: ActionContext,
  workspaceId: string,
  mode: 'manual' | 'auto' | 'smart',
): Promise<ActionResult> {
  if (!['manual', 'auto', 'smart'].includes(mode)) {
    throw new ActionError(400, 'bad_request', 'Invalid investigation-start mode.');
  }
  const ws = await db.getWorkspaceById(workspaceId);
  if (!ws) throw new ActionError(404, 'not_found', 'Workspace not found.');
  await assertMember(db, workspaceId, ctx.userId);
  await db.updateWorkspaceSettings(workspaceId, {
    investigation_start_mode: mode,
    settings_updated_by: ctx.userId,
    settings_updated_at: isoSeconds(ctx.clock.now()),
  });
  return { ok: true, investigation_start_mode: mode };
}

// ---- Approvals + generation enqueue -----------------------------------------

// action_type → the durable generation job it enqueues once approved.
const GENERATION_JOB_TYPE: Record<string, JobType> = {
  generate_pr: 'recommendation_pr_generation',
  create_monitor: 'datadog_alert_generation',
  monitor_change: 'datadog_alert_generation',
};

// action_type → the recommendation step kind it may act on. A provided
// target_step_key must name an existing step of this kind, so a crafted client
// can't approve an action against an arbitrary or incompatible step key (the
// executor would otherwise materialize it).
const ACTION_STEP_KIND: Record<string, string> = {
  generate_pr: 'code_pr',
  create_monitor: 'datadog_new_monitor',
  monitor_change: 'datadog_monitor_change',
};

async function requestApproval(
  db: JobsDb,
  ctx: ActionContext,
  req: Extract<ActionRequest, { action: 'request_approval' }>,
): Promise<ActionResult> {
  if (req.target_type !== 'recommendation') {
    throw new ActionError(400, 'unsupported_target', 'Only recommendation approvals are supported.');
  }
  const rec = await db.getRecommendation(req.target_id);
  if (!rec) throw new ActionError(404, 'not_found', 'Approval target not found.');
  await assertMember(db, rec.workspace_id, ctx.userId);

  // Bind the approval to a real, kind-compatible step. The client supplies
  // target_step_key, so a forged/incompatible key must be rejected here rather
  // than silently materialized by the executor.
  if (req.target_step_key) {
    const step = (rec.steps ?? []).find((s) => s.key === req.target_step_key);
    if (!step) throw new ActionError(404, 'step_not_found', 'The recommendation has no such step.');
    const expectedKind = ACTION_STEP_KIND[req.action_type];
    if (expectedKind && step.kind !== expectedKind) {
      throw new ActionError(409, 'step_kind_mismatch', `Step "${req.target_step_key}" does not support ${req.action_type}.`);
    }
  }

  // Idempotent: an existing active approval for the same target+action is reused.
  const active = await db.findActiveApproval(rec.workspace_id, req.target_type, req.target_id, req.action_type);
  if (active) {
    return { ok: true, approval_id: active.id, approved_payload_hash: active.approved_payload_hash, deduped: true };
  }

  const hash = hashPayload(req.payload);
  const approval = await db.insertApproval({
    workspace_id: rec.workspace_id,
    action_type: req.action_type,
    target_type: req.target_type,
    target_id: req.target_id,
    target_step_key: req.target_step_key ?? null,
    requested_by: ctx.userId,
    state: 'requested',
    approval_summary: req.approval_summary,
    approved_payload_hash: hash,
    idempotency_key: `${req.action_type}:${req.target_id}:${req.target_step_key ?? ''}`,
  });
  return { ok: true, approval_id: approval.id, approved_payload_hash: hash, deduped: false };
}

async function decideApproval(
  db: JobsDb,
  ctx: ActionContext,
  req: Extract<ActionRequest, { action: 'decide_approval' }>,
): Promise<ActionResult> {
  const approval = await db.getApproval(req.approval_id);
  if (!approval) throw new ActionError(404, 'not_found', 'Approval not found.');
  await assertMember(db, approval.workspace_id, ctx.userId);

  // If the approval is already in the target state, treat it as an idempotent no-op,
  // but still validate the payload if approving.
  if (approval.state === req.decision) {
    if (req.decision === 'approved' && req.payload !== undefined) {
      if (hashPayload(req.payload) !== approval.approved_payload_hash) {
        throw new ActionError(409, 'stale_payload', 'The approved payload no longer matches the request.');
      }
    }
    return { ok: true, state: req.decision };
  }

  assertApprovalTransition(approval.state, req.decision);

  // Approving with a payload re-checks the hash so a payload that changed since
  // the request is rejected (stale approval) rather than silently approved.
  if (req.decision === 'approved' && req.payload !== undefined) {
    if (hashPayload(req.payload) !== approval.approved_payload_hash) {
      throw new ActionError(409, 'stale_payload', 'The approved payload no longer matches the request.');
    }
  }
  // Conditional on the state we validated against — a concurrent decision → 409.
  const ok = await db.updateApproval(
    req.approval_id,
    {
      state: req.decision,
      approved_by: req.decision === 'approved' ? ctx.userId : approval.approved_by ?? null,
    },
    approval.state,
  );
  if (!ok) throw new ActionError(409, 'conflict', 'The approval changed before this could be applied. Please retry.');
  return { ok: true, state: req.decision };
}

async function enqueueGeneration(db: JobsDb, ctx: ActionContext, approvalId: string): Promise<ActionResult> {
  const approval = await db.getApproval(approvalId);
  if (!approval) throw new ActionError(404, 'not_found', 'Approval not found.');
  await assertMember(db, approval.workspace_id, ctx.userId);
  if (approval.state !== 'approved') {
    throw new ActionError(409, 'not_approved', 'The approval must be approved before enqueueing.');
  }
  const jobType = GENERATION_JOB_TYPE[approval.action_type];
  if (!jobType) throw new ActionError(400, 'unsupported_action', `No generation job for ${approval.action_type}.`);

  const key = generationKey(approvalId);
  const dup = await db.findJobByIdempotency(approval.workspace_id, jobType, key);
  if (dup) {
    // A prior generation that terminally FAILED (e.g. a provider timeout) must
    // RESUME on a fresh Generate/Retry — not dedupe to an inert dead job the user
    // can never restart from the card. Reuse the durable row (preserved phases,
    // fresh budget, no duplicate provider writes) and flip the step back to
    // `generating` so the card shows progress again.
    if (canRetryJob(dup)) {
      const at = isoSeconds(ctx.clock.now());
      await requeueFailedJob(db, dup, at, 'Re-generation requested by a workspace member.');
      await markStepGenerating(db, approval);
      return { ok: true, job_id: dup.id, resumed: true };
    }
    return { ok: true, job_id: dup.id, deduped: true };
  }

  const job = await db.insertJob(
    newJob(ctx, {
      workspace_id: approval.workspace_id,
      job_type: jobType,
      target_type: approval.target_type,
      target_id: approval.target_id,
      target_step_key: approval.target_step_key ?? null,
      idempotency_key: key,
      trigger_summary: { source: 'approval', approval_id: approvalId },
    }),
  );
  return { ok: true, job_id: job.id, deduped: false };
}

// ---- Job insert defaults ----------------------------------------------------

function newJob(
  ctx: ActionContext,
  fields: Pick<JobRow, 'workspace_id' | 'job_type' | 'target_type' | 'target_id' | 'idempotency_key'> &
    Partial<Pick<JobRow, 'target_step_key' | 'trigger_summary'>>,
): Partial<JobRow> {
  const at = isoSeconds(ctx.clock.now());
  return {
    state: 'queued',
    safe_to_retry: true,
    attempt_count: 0,
    max_attempts: 3,
    retry_policy: {},
    phases: [],
    attempts: [],
    audit_events: [{ at, kind: 'enqueued', summary: 'Job enqueued.' }],
    created_by: ctx.userId,
    queued_at: at,
    next_run_at: at,
    lease_expires_at: LEASE_FREE,
    locked_by: null,
    progress_version: 1,
    ...fields,
    trigger_summary: fields.trigger_summary ?? {},
  };
}
