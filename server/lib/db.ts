import type { ApprovalRow, ApprovalState, IncidentRow, JobRow, RecommendationRow, RecommendationState } from './types';

// Storage interface the engine + action handlers depend on. The Deno functions
// implement it over the InsForge admin (service-role) client; tests implement it
// in-memory. Keeping every DB touch behind this interface is what makes the
// claim/lease, retry, idempotency, and transition logic unit-testable without a
// live Postgres — and keeps the engine identical in both environments.
export interface JobsDb {
  // --- claiming -------------------------------------------------------------
  /** Queued/retrying jobs whose backoff has elapsed and whose lease is free. */
  selectDueJobs(nowIso: string, max: number): Promise<JobRow[]>;
  /** Running jobs whose lease expired (a worker died mid-run) — reclaimable. */
  selectAbandonedJobs(nowIso: string, max: number): Promise<JobRow[]>;
  /**
   * Atomically claim a candidate: a conditional update guarded by the same
   * predicate that made it a candidate, so two concurrent ticks cannot both win.
   * Returns the claimed row, or null if another worker took it first.
   */
  claimJob(
    id: string,
    kind: 'due' | 'abandoned',
    nowIso: string,
    patch: Partial<JobRow>,
  ): Promise<JobRow | null>;

  // --- reads / writes -------------------------------------------------------
  getJob(id: string): Promise<JobRow | null>;
  findJobByIdempotency(workspaceId: string, jobType: string, idempotencyKey: string): Promise<JobRow | null>;
  insertJob(row: Partial<JobRow>): Promise<JobRow>;
  updateJob(id: string, patch: Partial<JobRow>): Promise<JobRow>;
  /**
   * Owner-guarded job update: applies the patch only while `locked_by` still
   * equals `workerId` (the worker that holds the lease). Returns null if the lease
   * was reclaimed by another tick — the caller must then stop touching the job so
   * it cannot clobber the new owner's progress.
   */
  updateOwnedJob(id: string, workerId: string, patch: Partial<JobRow>): Promise<JobRow | null>;

  getIncident(id: string): Promise<IncidentRow | null>;
  updateIncident(id: string, patch: Partial<IncidentRow>): Promise<void>;

  getRecommendation(id: string): Promise<RecommendationRow | null>;
  /**
   * Conditional transition: applies the patch only while the row's `state` still
   * equals `expectedState`. Returns false if a concurrent change moved it first
   * (the caller raises a 409) — prevents last-write-wins on the state machine.
   */
  updateRecommendation(
    id: string,
    patch: Partial<RecommendationRow>,
    expectedState?: RecommendationState,
  ): Promise<boolean>;

  getApproval(id: string): Promise<ApprovalRow | null>;
  findActiveApproval(
    workspaceId: string,
    targetType: string,
    targetId: string,
    actionType: string,
  ): Promise<ApprovalRow | null>;
  insertApproval(row: Partial<ApprovalRow>): Promise<ApprovalRow>;
  /** Conditional transition (see updateRecommendation); false on a concurrent change. */
  updateApproval(id: string, patch: Partial<ApprovalRow>, expectedState?: ApprovalState): Promise<boolean>;

  getWorkspaceById(id: string): Promise<{ id: string } | null>;
  updateWorkspaceSettings(
    id: string,
    patch: { investigation_start_mode?: string; settings_updated_by?: string | null; settings_updated_at?: string },
  ): Promise<void>;

  // --- membership -----------------------------------------------------------
  isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean>;
}
