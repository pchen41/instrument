// Console mutation calls. Browser RLS is select-only, so every write goes through
// the `console-actions` edge function (Task 5A), which validates the caller's
// session, workspace membership, the allowed transition, and idempotency before
// touching the database with server-only credentials. The SDK attaches the
// signed-in user's access token automatically.
import { insforge } from '../lib/insforge';
import type { InvestigationStartMode } from './reads';

export interface ActionOutcome {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

async function invoke(body: Record<string, unknown>): Promise<ActionOutcome> {
  try {
    const { data, error } = await insforge.functions.invoke('console-actions', { body });
    if (error) return { ok: false, error: messageFrom(error) };
    const payload = (data ?? {}) as Record<string, unknown>;
    // The function returns a 4xx body as `{ error, message }`; the SDK may surface
    // that as data rather than error depending on status handling.
    if (payload.ok === false || (payload.error && payload.ok !== true)) {
      return { ok: false, error: messageFrom(payload) };
    }
    return { ok: true, data: payload };
  } catch (err) {
    return { ok: false, error: messageFrom(err) };
  }
}

function messageFrom(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as { message?: string; error?: string };
    if (e.message) return e.message;
    if (e.error) return e.error;
  }
  return 'Something went wrong. Please try again.';
}

/** Start a durable investigation for an incident (idempotent on repeat). */
export function startInvestigation(incidentId: string): Promise<ActionOutcome> {
  return invoke({ action: 'start_investigation', incident_id: incidentId });
}

/** Retry a safely-failed investigation job (reuses the same durable job). */
export function retryInvestigation(jobId: string): Promise<ActionOutcome> {
  return invoke({ action: 'retry_job', job_id: jobId });
}

/** Dismiss (active → dismissed) or restore (dismissed → active) a recommendation. */
export function setRecommendationState(
  recommendationId: string,
  state: 'dismissed' | 'active',
): Promise<ActionOutcome> {
  return invoke({ action: 'set_recommendation_state', recommendation_id: recommendationId, state });
}

/** Change the workspace investigation-start setting. */
export function setInvestigationMode(
  workspaceId: string,
  mode: InvestigationStartMode,
): Promise<ActionOutcome> {
  return invoke({ action: 'set_investigation_mode', workspace_id: workspaceId, mode });
}

// ---- Approval-gated external writes (Task 8) --------------------------------

export interface ApprovalRequest {
  targetType: 'recommendation';
  targetId: string;
  targetStepKey?: string | null;
  actionType: 'generate_pr' | 'create_monitor' | 'monitor_change';
  approvalSummary: string;
  payload: unknown;
}

/** Open (or reuse, idempotent) an approval for an external-write operation. */
export function requestApproval(req: ApprovalRequest): Promise<ActionOutcome> {
  return invoke({
    action: 'request_approval',
    target_type: req.targetType,
    target_id: req.targetId,
    target_step_key: req.targetStepKey ?? null,
    action_type: req.actionType,
    approval_summary: req.approvalSummary,
    payload: req.payload,
  });
}

/** Approve / reject / revoke an approval; approving re-checks the payload hash. */
export function decideApproval(
  approvalId: string,
  decision: 'approved' | 'rejected' | 'revoked',
  payload?: unknown,
): Promise<ActionOutcome> {
  return invoke({ action: 'decide_approval', approval_id: approvalId, decision, payload });
}

/** Enqueue the durable generation job for an approved external-write operation. */
export function enqueueGeneration(approvalId: string): Promise<ActionOutcome> {
  return invoke({ action: 'enqueue_generation', approval_id: approvalId });
}

/**
 * Explicit-approval shortcut behind a single confirm: open the approval, approve
 * it, then enqueue generation. The server makes each step idempotent — a duplicate
 * request reuses the active approval and a duplicate enqueue reuses the existing
 * job — and surfaces any failure (e.g. a stale-payload or transition conflict)
 * rather than generating without a clean approval. The caller guards against
 * concurrent double-submit; after enqueue the step advances out of `available`,
 * so the button is no longer offered.
 */
export async function approveAndGenerate(req: ApprovalRequest): Promise<ActionOutcome> {
  const opened = await requestApproval(req);
  if (!opened.ok) return opened;
  const approvalId = opened.data?.approval_id as string | undefined;
  if (!approvalId) return { ok: false, error: 'The approval could not be opened.' };

  const decided = await decideApproval(approvalId, 'approved', req.payload);
  if (!decided.ok) return decided;

  return enqueueGeneration(approvalId);
}
