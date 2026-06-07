import type { JobsDb } from './db';
import type { ApprovalRow, IncidentRow, JobRow, RecommendationRow } from './types';

// In-memory JobsDb for unit tests. The claim path models the same conditional-
// update CAS the PostgREST adapter performs, so the lease / lost-update / abandon
// tests exercise real claim semantics rather than a rubber stamp.

const ms = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : NaN);

let counter = 0;
const id = (prefix: string) => `${prefix}-${++counter}`;

export class FakeDb implements JobsDb {
  jobs = new Map<string, JobRow>();
  incidents = new Map<string, IncidentRow>();
  recommendations = new Map<string, RecommendationRow>();
  approvals = new Map<string, ApprovalRow>();
  workspaces = new Map<string, { id: string }>();
  members = new Set<string>(); // `${workspaceId}:${userId}`

  seedJob(job: Partial<JobRow>): JobRow {
    const row: JobRow = {
      id: job.id ?? id('job'),
      workspace_id: job.workspace_id ?? 'ws-1',
      job_type: job.job_type ?? 'incident_investigation',
      state: job.state ?? 'queued',
      target_type: job.target_type ?? 'incident',
      target_id: job.target_id ?? 'inc-1',
      target_step_key: job.target_step_key ?? null,
      idempotency_key: job.idempotency_key ?? id('idem'),
      created_by: job.created_by ?? null,
      safe_to_retry: job.safe_to_retry ?? true,
      attempt_count: job.attempt_count ?? 0,
      max_attempts: job.max_attempts ?? 3,
      retry_policy: job.retry_policy ?? {},
      phases: job.phases ?? [],
      attempts: job.attempts ?? [],
      audit_events: job.audit_events ?? [],
      trigger_summary: job.trigger_summary ?? {},
      next_run_at: job.next_run_at ?? null,
      locked_by: job.locked_by ?? null,
      locked_at: job.locked_at ?? null,
      lease_expires_at: job.lease_expires_at ?? null,
      heartbeat_at: job.heartbeat_at ?? null,
      failure_integration_id: job.failure_integration_id ?? null,
      failure_source: job.failure_source ?? null,
      error_code: job.error_code ?? null,
      error_summary: job.error_summary ?? null,
      progress_version: job.progress_version ?? 1,
      queued_at: job.queued_at ?? null,
      started_at: job.started_at ?? null,
      completed_at: job.completed_at ?? null,
    };
    this.jobs.set(row.id, row);
    return row;
  }

  seedIncident(i: Partial<IncidentRow>): IncidentRow {
    const row: IncidentRow = {
      id: i.id ?? id('inc'),
      workspace_id: i.workspace_id ?? 'ws-1',
      incident_state: i.incident_state ?? 'active',
      service_name: i.service_name ?? null,
      investigation_job_id: i.investigation_job_id ?? null,
      investigation_start_mode_snapshot: i.investigation_start_mode_snapshot ?? null,
      hypotheses: i.hypotheses ?? [],
      timeline: i.timeline ?? [],
    };
    this.incidents.set(row.id, row);
    return row;
  }

  seedRecommendation(r: Partial<RecommendationRow>): RecommendationRow {
    const row: RecommendationRow = {
      id: r.id ?? id('rec'),
      workspace_id: r.workspace_id ?? 'ws-1',
      state: r.state ?? 'active',
      lifecycle_events: r.lifecycle_events ?? [],
      dismissed_at: r.dismissed_at ?? null,
      accepted_at: r.accepted_at ?? null,
    };
    this.recommendations.set(row.id, row);
    return row;
  }

  seedApproval(a: Partial<ApprovalRow>): ApprovalRow {
    const row: ApprovalRow = {
      id: a.id ?? id('appr'),
      workspace_id: a.workspace_id ?? 'ws-1',
      action_type: a.action_type ?? 'generate_pr',
      target_type: a.target_type ?? 'recommendation',
      target_id: a.target_id ?? 'rec-1',
      target_step_key: a.target_step_key ?? null,
      requested_by: a.requested_by ?? null,
      approved_by: a.approved_by ?? null,
      state: a.state ?? 'requested',
      approval_summary: a.approval_summary ?? 'summary',
      approved_payload_hash: a.approved_payload_hash ?? null,
      idempotency_key: a.idempotency_key ?? id('aidem'),
    };
    this.approvals.set(row.id, row);
    return row;
  }

  seedWorkspace(workspaceId = 'ws-1', userId = 'user-1'): void {
    this.workspaces.set(workspaceId, { id: workspaceId });
    this.members.add(`${workspaceId}:${userId}`);
  }

  // --- JobsDb ---------------------------------------------------------------

  async selectDueJobs(nowIso: string, max: number): Promise<JobRow[]> {
    const now = ms(nowIso);
    return [...this.jobs.values()]
      .filter(
        (j) =>
          (j.state === 'queued' || j.state === 'retrying') &&
          j.next_run_at != null &&
          ms(j.next_run_at) <= now &&
          ms(j.lease_expires_at) < now,
      )
      .sort((a, b) => ms(a.next_run_at) - ms(b.next_run_at))
      .slice(0, max)
      .map((j) => ({ ...j }));
  }

  async selectAbandonedJobs(nowIso: string, max: number): Promise<JobRow[]> {
    const now = ms(nowIso);
    return [...this.jobs.values()]
      .filter((j) => j.state === 'running' && j.lease_expires_at != null && ms(j.lease_expires_at) < now)
      .slice(0, max)
      .map((j) => ({ ...j }));
  }

  async claimJob(
    jobId: string,
    kind: 'due' | 'abandoned',
    nowIso: string,
    patch: Partial<JobRow>,
  ): Promise<JobRow | null> {
    const row = this.jobs.get(jobId);
    if (!row) return null;
    const now = ms(nowIso);
    const leaseFree = ms(row.lease_expires_at) < now;
    const claimable =
      kind === 'due'
        ? (row.state === 'queued' || row.state === 'retrying') &&
          row.next_run_at != null &&
          ms(row.next_run_at) <= now &&
          leaseFree
        : row.state === 'running' && row.lease_expires_at != null && leaseFree;
    if (!claimable) return null;
    const next = { ...row, ...patch };
    this.jobs.set(jobId, next);
    return { ...next };
  }

  async getJob(jobId: string): Promise<JobRow | null> {
    const j = this.jobs.get(jobId);
    return j ? { ...j } : null;
  }

  async findJobByIdempotency(workspaceId: string, jobType: string, key: string): Promise<JobRow | null> {
    for (const j of this.jobs.values()) {
      if (j.workspace_id === workspaceId && j.job_type === jobType && j.idempotency_key === key) return { ...j };
    }
    return null;
  }

  async insertJob(row: Partial<JobRow>): Promise<JobRow> {
    // Enforce the (workspace_id, job_type, idempotency_key) unique constraint.
    const existing = await this.findJobByIdempotency(
      row.workspace_id!,
      row.job_type!,
      row.idempotency_key!,
    );
    if (existing) throw new Error('duplicate idempotency key');
    return this.seedJob({ ...row, id: id('job') });
  }

  async updateJob(jobId: string, patch: Partial<JobRow>): Promise<JobRow> {
    const row = this.jobs.get(jobId);
    if (!row) throw new Error('job not found');
    const next = { ...row, ...patch };
    this.jobs.set(jobId, next);
    return { ...next };
  }

  async updateOwnedJob(jobId: string, workerId: string, patch: Partial<JobRow>): Promise<JobRow | null> {
    const row = this.jobs.get(jobId);
    if (!row || row.locked_by !== workerId) return null; // lease reclaimed by another tick
    const next = { ...row, ...patch };
    this.jobs.set(jobId, next);
    return { ...next };
  }

  async getIncident(incidentId: string): Promise<IncidentRow | null> {
    const i = this.incidents.get(incidentId);
    return i ? { ...i } : null;
  }

  async updateIncident(incidentId: string, patch: Partial<IncidentRow>): Promise<void> {
    const row = this.incidents.get(incidentId);
    if (row) this.incidents.set(incidentId, { ...row, ...patch });
  }

  async getRecommendation(recId: string): Promise<RecommendationRow | null> {
    const r = this.recommendations.get(recId);
    return r ? { ...r } : null;
  }

  async updateRecommendation(
    recId: string,
    patch: Partial<RecommendationRow>,
    expectedState?: RecommendationRow['state'],
  ): Promise<boolean> {
    const row = this.recommendations.get(recId);
    if (!row || (expectedState && row.state !== expectedState)) return false;
    this.recommendations.set(recId, { ...row, ...patch });
    return true;
  }

  async getApproval(approvalId: string): Promise<ApprovalRow | null> {
    const a = this.approvals.get(approvalId);
    return a ? { ...a } : null;
  }

  async findActiveApproval(
    workspaceId: string,
    targetType: string,
    targetId: string,
    actionType: string,
  ): Promise<ApprovalRow | null> {
    for (const a of this.approvals.values()) {
      if (
        a.workspace_id === workspaceId &&
        a.target_type === targetType &&
        a.target_id === targetId &&
        a.action_type === actionType &&
        (a.state === 'requested' || a.state === 'approved')
      ) {
        return { ...a };
      }
    }
    return null;
  }

  async insertApproval(row: Partial<ApprovalRow>): Promise<ApprovalRow> {
    return this.seedApproval({ ...row, id: id('appr') });
  }

  async updateApproval(
    approvalId: string,
    patch: Partial<ApprovalRow>,
    expectedState?: ApprovalRow['state'],
  ): Promise<boolean> {
    const row = this.approvals.get(approvalId);
    if (!row || (expectedState && row.state !== expectedState)) return false;
    this.approvals.set(approvalId, { ...row, ...patch });
    return true;
  }

  async getWorkspaceById(workspaceId: string): Promise<{ id: string } | null> {
    return this.workspaces.get(workspaceId) ?? null;
  }

  async updateWorkspaceSettings(): Promise<void> {
    // Settings are not asserted structurally in tests beyond the call succeeding.
  }

  async isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
    return this.members.has(`${workspaceId}:${userId}`);
  }
}

/** A fixed clock for deterministic time in tests. */
export function fixedClock(start = '2026-06-06T12:00:00Z') {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (seconds: number) => {
      t += seconds * 1000;
    },
  };
}
