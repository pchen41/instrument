import type { JobsDb } from '../../lib/db';
import type { ApprovalRow, IncidentRow, JobRow, RecommendationRow } from '../../lib/types';

// PostgREST-backed JobsDb over the InsForge admin (service-role) client. The
// admin client bypasses RLS, which is exactly what these privileged server paths
// need — browser RLS is select-only, so all writes funnel through here.
//
// The claim path is the only subtle bit: a *conditional* update guarded by the
// same predicate that made the row a candidate. Under Postgres READ COMMITTED the
// guard is re-checked against the freshly-locked row, so two concurrent ticks
// cannot both win — the loser's update matches zero rows and returns null.

// Loosely typed: this file isn't type-checked by the app tsc (it targets Deno +
// npm:@insforge/sdk). `any` keeps the PostgREST builder ergonomic here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

const INCIDENT_COLS =
  'id, workspace_id, incident_state, service_name, investigation_job_id, investigation_start_mode_snapshot, hypotheses, timeline';
const REC_COLS = 'id, workspace_id, state, steps, lifecycle_events, dismissed_at, accepted_at';
const APPROVAL_COLS =
  'id, workspace_id, action_type, target_type, target_id, target_step_key, requested_by, approved_by, state, approval_summary, approved_payload_hash, idempotency_key';

export function createPgDb(admin: Admin): JobsDb {
  const db = admin.database;
  const jobs = () => db.from('jobs');

  return {
    async selectDueJobs(nowIso, max) {
      const { data } = await jobs()
        .select('*')
        .in('state', ['queued', 'retrying'])
        .lte('next_run_at', nowIso)
        .lt('lease_expires_at', nowIso)
        .order('next_run_at', { ascending: true })
        .limit(max);
      return (data ?? []) as JobRow[];
    },

    async selectAbandonedJobs(nowIso, max) {
      const { data } = await jobs()
        .select('*')
        .eq('state', 'running')
        .lt('lease_expires_at', nowIso)
        .limit(max);
      return (data ?? []) as JobRow[];
    },

    async claimJob(id, kind, nowIso, patch) {
      let q = jobs().update(patch).eq('id', id).lt('lease_expires_at', nowIso);
      q = kind === 'due'
        ? q.in('state', ['queued', 'retrying']).lte('next_run_at', nowIso)
        : q.eq('state', 'running');
      const { data } = await q.select('*');
      const rows = (data ?? []) as JobRow[];
      return rows[0] ?? null;
    },

    async getJob(id) {
      const { data } = await jobs().select('*').eq('id', id).maybeSingle();
      return (data as JobRow) ?? null;
    },

    async findJobByIdempotency(workspaceId, jobType, key) {
      const { data } = await jobs()
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('job_type', jobType)
        .eq('idempotency_key', key)
        .maybeSingle();
      return (data as JobRow) ?? null;
    },

    async insertJob(row) {
      const { data, error } = await jobs().insert([row]).select('*');
      if (error) {
        // Lost an enqueue race on the unique (workspace, type, idempotency) key:
        // re-fetch the winner so the caller still gets the durable job.
        const existing = await this.findJobByIdempotency(row.workspace_id!, row.job_type!, row.idempotency_key!);
        if (existing) return existing;
        throw error;
      }
      return (data as JobRow[])[0];
    },

    async updateJob(id, patch) {
      const { data, error } = await jobs().update(patch).eq('id', id).select('*');
      if (error) throw error;
      return (data as JobRow[])[0];
    },

    async updateOwnedJob(id, workerId, patch) {
      // Guard on locked_by: if a later tick reclaimed the lease, this matches zero
      // rows and returns null, so the original worker stops touching the job.
      const { data, error } = await jobs().update(patch).eq('id', id).eq('locked_by', workerId).select('*');
      if (error) throw error;
      return (data as JobRow[])[0] ?? null;
    },

    async getIncident(id) {
      const { data } = await db.from('incidents').select(INCIDENT_COLS).eq('id', id).maybeSingle();
      return (data as IncidentRow) ?? null;
    },

    async updateIncident(id, patch) {
      const { error } = await db.from('incidents').update(patch).eq('id', id);
      if (error) throw error;
    },

    async getRecommendation(id) {
      const { data } = await db.from('recommendations').select(REC_COLS).eq('id', id).maybeSingle();
      return (data as RecommendationRow) ?? null;
    },

    async updateRecommendation(id, patch, expectedState) {
      let q = db.from('recommendations').update(patch).eq('id', id);
      if (expectedState) q = q.eq('state', expectedState);
      const { data, error } = await q.select('id');
      if (error) throw error;
      return (data ?? []).length > 0;
    },

    async getApproval(id) {
      const { data } = await db.from('approvals').select(APPROVAL_COLS).eq('id', id).maybeSingle();
      return (data as ApprovalRow) ?? null;
    },

    async findActiveApproval(workspaceId, targetType, targetId, actionType) {
      const { data } = await db
        .from('approvals')
        .select(APPROVAL_COLS)
        .eq('workspace_id', workspaceId)
        .eq('target_type', targetType)
        .eq('target_id', targetId)
        .eq('action_type', actionType)
        .in('state', ['requested', 'approved'])
        .limit(1)
        .maybeSingle();
      return (data as ApprovalRow) ?? null;
    },

    async insertApproval(row) {
      const { data, error } = await db.from('approvals').insert([row]).select(APPROVAL_COLS);
      if (error) throw error;
      return (data as ApprovalRow[])[0];
    },

    async updateApproval(id, patch, expectedState) {
      let q = db.from('approvals').update(patch).eq('id', id);
      if (expectedState) q = q.eq('state', expectedState);
      const { data, error } = await q.select('id');
      if (error) throw error;
      return (data ?? []).length > 0;
    },

    async getWorkspaceById(id) {
      const { data } = await db.from('workspaces').select('id').eq('id', id).maybeSingle();
      return (data as { id: string }) ?? null;
    },

    async updateWorkspaceSettings(id, patch) {
      const { error } = await db.from('workspaces').update(patch).eq('id', id);
      if (error) throw error;
    },

    async isWorkspaceMember(workspaceId, userId) {
      const { data } = await db
        .from('workspace_members')
        .select('user_id')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();
      return !!data;
    },
  };
}
