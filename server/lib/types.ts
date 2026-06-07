// Shared types for the durable job engine + mutation endpoints (Task 5A).
//
// These mirror the relevant columns of the InsForge tables (docs/ERD.md) but
// stay deliberately loose — only the fields the engine and action handlers read
// or write are modelled. Everything here is runtime-agnostic (no Deno, no SDK)
// so it runs identically under Vitest (Node) and bundled into a Deno function.

export type JobType =
  | 'github_pr_review_analysis'
  | 'proactive_scan'
  | 'recommendation_generation'
  | 'datadog_alert_generation'
  | 'incident_investigation'
  | 'recommendation_pr_generation';

export type JobState = 'queued' | 'running' | 'retrying' | 'failed' | 'succeeded';

export type PhaseState = 'pending' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'skipped';

export interface JobPhase {
  key: string;
  label: string;
  state: PhaseState;
  started_at?: string | null;
  completed_at?: string | null;
  detail?: string | null;
}

export interface JobAttempt {
  attempt: number;
  outcome: 'succeeded' | 'failed' | 'retrying';
  started_at: string;
  completed_at?: string | null;
  error_code?: string | null;
  error_summary?: string | null;
  next_run_at?: string | null;
}

export interface JobAuditEvent {
  at: string;
  kind: string;
  summary: string;
}

export interface RetryPolicy {
  max_attempts?: number;
  base_seconds?: number;
  factor?: number;
  max_seconds?: number;
}

/**
 * `trigger_summary.simulate` lets a seeded/enqueued job drive the engine's
 * failure paths deterministically without a real provider. Task 5A ships the
 * engine, not provider workflows, so this is how the retry / terminal-failure
 * behaviour is exercised in tests and manual verification. Absent = run clean.
 */
export interface SimulateConfig {
  fail_phase?: string;
  mode?: 'retryable' | 'terminal';
  // For 'retryable': succeed once attempt_count reaches this value (so a manual
  // retry eventually clears). Omit to fail until max_attempts is exhausted.
  recover_on_attempt?: number;
  error_code?: string;
  error_summary?: string;
  failure_source?: string;
}

export interface JobRow {
  id: string;
  workspace_id: string;
  job_type: JobType;
  state: JobState;
  target_type: string;
  target_id: string;
  target_step_key?: string | null;
  idempotency_key: string;
  created_by?: string | null;
  safe_to_retry: boolean;
  attempt_count: number;
  max_attempts: number;
  retry_policy: RetryPolicy;
  phases: JobPhase[];
  attempts: JobAttempt[];
  audit_events: JobAuditEvent[];
  trigger_summary: Record<string, unknown> & { simulate?: SimulateConfig };
  next_run_at?: string | null;
  locked_by?: string | null;
  locked_at?: string | null;
  lease_expires_at?: string | null;
  heartbeat_at?: string | null;
  failure_integration_id?: string | null;
  failure_source?: string | null;
  error_code?: string | null;
  error_summary?: string | null;
  progress_version: number;
  queued_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface IncidentRow {
  id: string;
  workspace_id: string;
  incident_state: 'active' | 'resolved';
  service_name?: string | null;
  investigation_job_id?: string | null;
  investigation_start_mode_snapshot?: string | null;
}

export type RecommendationState = 'active' | 'accepted' | 'dismissed' | 'outdated';

export interface RecommendationRow {
  id: string;
  workspace_id: string;
  state: RecommendationState;
  lifecycle_events: { at: string; event: string; detail?: string | null; job_id?: string | null }[];
  dismissed_at?: string | null;
  accepted_at?: string | null;
}

export type ApprovalState = 'requested' | 'approved' | 'rejected' | 'revoked' | 'executed';

export interface ApprovalRow {
  id: string;
  workspace_id: string;
  action_type: string;
  target_type: string;
  target_id: string;
  target_step_key?: string | null;
  requested_by?: string | null;
  approved_by?: string | null;
  state: ApprovalState;
  approval_summary: string;
  approved_payload_hash?: string | null;
  idempotency_key: string;
}
