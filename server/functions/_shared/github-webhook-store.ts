// Deno-side persistence for GitHub webhook ingestion (Task 6). The pure decisions
// (verify, parse, bound/redact, idempotency keys) live in server/lib/github-webhook.ts;
// this is the PostgREST IO edge: record the delivery, resolve the allowlisted repo,
// upsert the PR, and (verified analysis actions only) enqueue the analysis job.
//
// Repo allowlist = the `repositories` table. A delivery for a repo not present
// there is recorded and ignored — never creating downstream rows ("limited to
// configured repositories"). Unverified deliveries are recorded with
// signature_valid=false and a minimal, non-forgeable note, never their payload.
import { isUniqueViolation } from './agent-runtime.ts';
import { prReviewDedupeFingerprint } from '../../lib/pr-review.ts';
import type { LatestScan, NormalizedPr, NormalizedRepo } from '../../lib/github-webhook.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export interface RepoContext {
  id: string;
  workspaceId: string;
  integrationId: string | null;
  /** repositories.pr_review_enabled — per-repo scope. */
  prReviewEnabled: boolean;
  /** workspaces.pr_review_enabled — workspace-wide scope; BOTH must be true to enqueue. */
  workspacePrReviewEnabled: boolean;
  /** repositories.default_branch — the configured primary branch for scans. */
  defaultBranch: string;
  /** workspaces.primary_branch_scan_cooldown_seconds. */
  scanCooldownSeconds: number;
}

export interface InboundInsert {
  workspaceId: string;
  integrationId: string | null;
  eventType: string;
  eventAction: string | null;
  externalDeliveryId: string;
  providerCorrelationKey: string | null;
  signatureValid: boolean;
  headersRedacted: Record<string, unknown>;
  payloadRedacted: Record<string, unknown>;
  receivedAt: string;
  processingStatus: 'received' | 'ignored' | 'processed' | 'failed';
}

export function createGithubWebhookStore(admin: Admin) {
  const db = admin.database;

  return {
    /**
     * The single configured workspace — home for unattributable (rejected)
     * deliveries. A query error THROWS (→ 500 → GitHub redelivers) rather than
     * returning null, so a transient DB blip never silently drops a delivery.
     */
    async defaultWorkspaceId(): Promise<string | null> {
      const { data, error } = await db.from('workspaces').select('id').order('created_at', { ascending: true }).limit(1).maybeSingle();
      if (error) throw error;
      return (data?.id as string | undefined) ?? null;
    },

    /**
     * Resolve an allowlisted repo by owner/name → workspace + integration + both
     * pr_review flags, or null if not allowlisted. A query error THROWS (a null
     * here would be misread as "not allowlisted" → 200 → GitHub never retries).
     */
    async findRepo(owner: string, name: string): Promise<RepoContext | null> {
      const { data, error } = await db
        .from('repositories')
        .select('id, workspace_id, integration_id, pr_review_enabled, default_branch')
        .eq('github_owner', owner)
        .eq('github_name', name)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const { data: ws, error: wsErr } = await db
        .from('workspaces')
        .select('pr_review_enabled, primary_branch_scan_cooldown_seconds')
        .eq('id', data.workspace_id)
        .maybeSingle();
      if (wsErr) throw wsErr;
      const cooldown = Number(ws?.primary_branch_scan_cooldown_seconds);
      return {
        id: data.id as string,
        workspaceId: data.workspace_id as string,
        integrationId: (data.integration_id as string | null) ?? null,
        prReviewEnabled: data.pr_review_enabled !== false,
        workspacePrReviewEnabled: ws?.pr_review_enabled !== false,
        defaultBranch: (data.default_branch as string | undefined) ?? 'main',
        scanCooldownSeconds: Number.isFinite(cooldown) ? cooldown : 30,
      };
    },

    /**
     * Keep allowlisted repo metadata fresh from the payload. Coalescing: only
     * fields actually present in the payload are written, so a sparse delivery
     * can never null out good values. Errors throw.
     */
    async refreshRepoMeta(repoId: string, repo: NormalizedRepo, now: string): Promise<void> {
      const patch: Record<string, unknown> = { last_synced_at: now, updated_at: now };
      if (repo.externalRepoId != null) patch.external_repo_id = repo.externalRepoId;
      if (repo.defaultBranch) patch.default_branch = repo.defaultBranch;
      if (repo.htmlUrl != null) patch.html_url = repo.htmlUrl;
      if (repo.cloneUrl != null) patch.clone_url = repo.cloneUrl;
      const { error } = await db.from('repositories').update(patch).eq('id', repoId);
      if (error) throw error;
    },

    /**
     * Record the delivery. Returns the row id and `duplicate` = whether the caller
     * should SHORT-CIRCUIT (skip re-processing). The unique (provider,
     * external_delivery_id) index is the idempotency anchor, but a unique hit alone
     * is NOT enough to skip: we only short-circuit a delivery that already reached a
     * terminal good state —
     *   - `processed` (fully handled), or
     *   - `ignored` AND signature_valid (a legitimately ignored valid delivery,
     *     e.g. repo not allowlisted — a re-delivery would just be re-ignored).
     * A row left at `received`/`failed` (a crash mid-processing) or a rejected
     * `ignored`+signature_valid=false row (later re-delivered with a fixed secret)
     * is REFRESHED and re-processed, so a redelivery can complete the work instead
     * of being silently dropped. PR upsert + job enqueue are idempotent, so
     * re-processing is safe.
     */
    async recordDelivery(row: InboundInsert): Promise<{ id: string; duplicate: boolean }> {
      const insert = {
        workspace_id: row.workspaceId,
        provider: 'github',
        integration_id: row.integrationId,
        event_type: row.eventType,
        event_action: row.eventAction,
        external_delivery_id: row.externalDeliveryId,
        provider_correlation_key: row.providerCorrelationKey,
        auth_method: 'github_signature',
        signature_valid: row.signatureValid,
        headers_redacted: row.headersRedacted,
        payload_redacted: row.payloadRedacted,
        received_at: row.receivedAt,
        processing_status: row.processingStatus,
      };
      const { data, error } = await db.from('inbound_webhooks').insert([insert]).select('id');
      if (!error) return { id: (data as { id: string }[])[0].id, duplicate: false };
      if (!isUniqueViolation(error)) throw error;

      const { data: existing, error: selErr } = await db
        .from('inbound_webhooks')
        .select('id, processing_status, signature_valid')
        .eq('provider', 'github')
        .eq('external_delivery_id', row.externalDeliveryId)
        .limit(1)
        .maybeSingle();
      if (selErr) throw selErr;
      if (!existing?.id) throw error; // conflict with no visible row — surface it
      const id = existing.id as string;
      const terminal = existing.processing_status === 'processed' || (existing.processing_status === 'ignored' && existing.signature_valid === true);
      if (terminal) return { id, duplicate: true };

      // Non-terminal (crash mid-flight) or previously-rejected: refresh + re-process.
      const { error: updErr } = await db
        .from('inbound_webhooks')
        .update({ ...insert, processed_at: null, error_summary: null })
        .eq('id', id);
      if (updErr) throw updErr;
      return { id, duplicate: false };
    },

    async markDelivery(id: string, patch: { processingStatus: InboundInsert['processingStatus']; processedAt?: string; errorSummary?: string | null }): Promise<void> {
      const { error } = await db
        .from('inbound_webhooks')
        .update({
          processing_status: patch.processingStatus,
          processed_at: patch.processedAt ?? null,
          error_summary: patch.errorSummary ?? null,
        })
        .eq('id', id);
      if (error) throw error;
    },

    /**
     * Upsert a PR by (repository_id, external_pr_number). Select-then-write with a
     * unique-violation fallback so a rare concurrent insert still resolves to one
     * row. Returns the durable PR id (target_id for the analysis job).
     */
    async upsertPullRequest(workspaceId: string, repositoryId: string, pr: NormalizedPr, now: string): Promise<string> {
      const fields = {
        title: pr.title,
        author_login: pr.authorLogin,
        state: pr.state,
        draft: pr.draft,
        base_branch: pr.baseBranch,
        head_branch: pr.headBranch,
        head_sha: pr.headSha,
        external_node_id: pr.nodeId,
        html_url: pr.htmlUrl,
        opened_at: pr.openedAt,
        updated_at: pr.updatedAt,
        closed_at: pr.closedAt,
        merged_at: pr.mergedAt,
        last_synced_at: now,
      };
      const { data: existing, error: selErr } = await db
        .from('github_pull_requests')
        .select('id')
        .eq('repository_id', repositoryId)
        .eq('external_pr_number', pr.number)
        .limit(1)
        .maybeSingle();
      if (selErr) throw selErr;
      if (existing?.id) {
        const { error: updErr } = await db.from('github_pull_requests').update(fields).eq('id', existing.id);
        if (updErr) throw updErr;
        return existing.id as string;
      }
      const { data, error } = await db
        .from('github_pull_requests')
        .insert([{ workspace_id: workspaceId, repository_id: repositoryId, external_pr_number: pr.number, ...fields }])
        .select('id');
      if (error) {
        if (isUniqueViolation(error)) {
          const { data: row, error: reSelErr } = await db
            .from('github_pull_requests')
            .select('id')
            .eq('repository_id', repositoryId)
            .eq('external_pr_number', pr.number)
            .limit(1)
            .maybeSingle();
          if (reSelErr) throw reSelErr;
          if (row?.id) {
            const { error: updErr } = await db.from('github_pull_requests').update(fields).eq('id', row.id);
            if (updErr) throw updErr;
            return row.id as string;
          }
        }
        throw error;
      }
      return (data as { id: string }[])[0].id;
    },

    /**
     * Merged/closed lifecycle (Task 6 slice 3): mark the PR's category-`pr_review`
     * recommendation `outdated` + archive it, and outdate its posted comment rows.
     * Best-effort + idempotent — no-op if the PR was never analyzed (no rec) or is
     * already outdated. We do NOT detect whether the author applied the suggestion
     * (out of first-slice scope); a closed PR's review is simply stale.
     */
    async outdatePrReviewRecommendation(workspaceId: string, repoFullName: string, prNumber: number, pullRequestId: string, reason: string, now: string): Promise<boolean> {
      // Outdate the posted comments FIRST and ALWAYS (idempotent: WHERE status='posted'
      // matches nothing on a repeat). Doing this independently of the recommendation
      // state means a redelivery after a partial failure still clears them — a
      // state-guarded early-return would otherwise leave them stuck 'posted' and
      // keep the (pull_request_id, semantic_fingerprint) partial-unique locked.
      const { error: cErr } = await db.from('pr_review_comments').update({ status: 'outdated', outdated_at: now, updated_at: now }).eq('pull_request_id', pullRequestId).eq('status', 'posted');
      if (cErr) throw cErr;
      const fingerprint = prReviewDedupeFingerprint(repoFullName, prNumber);
      const { data, error } = await db.from('recommendations').select('id, state, lifecycle_events').eq('workspace_id', workspaceId).eq('dedupe_fingerprint', fingerprint).limit(1).maybeSingle();
      if (error) throw error;
      if (!data?.id) return false;
      if (data.state === 'outdated') return true; // already archived; comments handled above
      const prior = Array.isArray(data.lifecycle_events) ? (data.lifecycle_events as unknown[]) : [];
      const lifecycle = [...prior, { at: now, kind: 'outdated', reason }].slice(-50);
      const { error: updErr } = await db
        .from('recommendations')
        .update({ state: 'outdated', outdated_reason: reason, outdated_at: now, lifecycle_events: lifecycle, updated_at: now })
        .eq('id', data.id);
      if (updErr) throw updErr;
      return true;
    },

    /** The most recent proactive_scan job for a repo (for cooldown/coalescing). */
    async latestScan(repositoryId: string): Promise<LatestScan | null> {
      const { data, error } = await db
        .from('jobs')
        .select('id, state, trigger_summary, completed_at')
        .eq('job_type', 'proactive_scan')
        .eq('target_id', repositoryId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const ts = (data.trigger_summary ?? {}) as { after_sha?: string };
      return { id: data.id as string, state: data.state as string, afterSha: ts.after_sha ?? '', completedAt: (data.completed_at as string | null) ?? null };
    },

    /**
     * Coalesce: stamp the newest head SHA onto an in-flight scan's trigger_summary.
     * Returns false if the job is no longer in-flight (terminal) — the caller then
     * enqueues a fresh scan instead, so a push that races the scan's completion
     * isn't lost. (Re-reads + conditionally updates; the state guard is the lock.)
     */
    async markScanPending(jobId: string, sha: string, now: string): Promise<boolean> {
      const { data } = await db.from('jobs').select('trigger_summary, state').eq('id', jobId).maybeSingle();
      if (!data || !['queued', 'running', 'retrying'].includes(data.state as string)) return false;
      const ts = (data.trigger_summary ?? {}) as Record<string, unknown>;
      const { data: updated, error } = await db
        .from('jobs')
        .update({ trigger_summary: { ...ts, pending_sha: sha, pending_marked_at: now } })
        .eq('id', jobId)
        .in('state', ['queued', 'running', 'retrying'])
        .select('id');
      if (error) throw error;
      return (updated ?? []).length > 0;
    },

    /**
     * Sync a merged GENERATED PR (Task 8): find the recommendation whose code_pr
     * step generated this PR number, mark that step `done`
     * (completion_source 'generated_pr_merged'), and mark the recommendation
     * `accepted` only once every required step is done. Idempotent + a no-op if no
     * step generated this PR (a normal PR merge). Separate from review-rec
     * outdating — a merged PR can hit both independently.
     */
    async markGeneratedPrMerged(workspaceId: string, repositoryId: string | null, prNumber: number, now: string): Promise<boolean> {
      // Fetch candidate recs (only instrumentation/alert generate PRs) and scan in
      // code — a nested-jsonb containment query isn't reliable through PostgREST here.
      // Scope to the repository: a PR number is repo-local, so the same number in
      // another repo must not match a different recommendation.
      let q = db.from('recommendations').select('id, steps, state').eq('workspace_id', workspaceId).in('category', ['instrumentation', 'alert']);
      if (repositoryId) q = q.eq('repository_id', repositoryId);
      const { data: candidates, error } = await q;
      if (error) throw error;
      const data = (candidates ?? []).find((r: { steps?: unknown }) => Array.isArray(r.steps) && (r.steps as Record<string, any>[]).some((s) => s?.generated_pr?.number === prNumber));
      if (!data?.id) return false;
      const steps = (Array.isArray(data.steps) ? (data.steps as Record<string, any>[]) : []).map((s) =>
        s?.generated_pr?.number === prNumber && s?.state !== 'done' ? { ...s, state: 'done', completion_source: 'generated_pr_merged' } : s,
      );
      const allRequiredDone = steps.every((s) => s?.state === 'done' || s?.required === false);
      const patch: Record<string, unknown> = { steps, updated_at: now };
      if (allRequiredDone && data.state !== 'accepted') {
        patch.state = 'accepted';
        patch.accepted_at = now;
      }
      const { error: upErr } = await db.from('recommendations').update(patch).eq('id', data.id);
      if (upErr) throw upErr;
      return true;
    },

    /**
     * A reopened PR un-archives its review recommendation (idempotent; only an
     * `outdated` rec is reactivated). Comments stay `outdated`; a re-analysis on the
     * reopened head posts fresh ones. (A prior physical GitHub comment can't be
     * deleted here, so reopen+push can leave a duplicate comment — documented.)
     */
    async reactivatePrReviewRecommendation(workspaceId: string, repoFullName: string, prNumber: number, now: string): Promise<boolean> {
      const fingerprint = prReviewDedupeFingerprint(repoFullName, prNumber);
      const { data, error } = await db.from('recommendations').select('id, state, lifecycle_events').eq('workspace_id', workspaceId).eq('dedupe_fingerprint', fingerprint).limit(1).maybeSingle();
      if (error) throw error;
      if (!data?.id || data.state !== 'outdated') return false;
      const prior = Array.isArray(data.lifecycle_events) ? (data.lifecycle_events as unknown[]) : [];
      const lifecycle = [...prior, { at: now, kind: 'reopened' }].slice(-50);
      const { error: updErr } = await db.from('recommendations').update({ state: 'active', outdated_reason: null, outdated_at: null, lifecycle_events: lifecycle, updated_at: now }).eq('id', data.id);
      if (updErr) throw updErr;
      return true;
    },
  };
}

export type GithubWebhookStore = ReturnType<typeof createGithubWebhookStore>;
