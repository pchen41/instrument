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
