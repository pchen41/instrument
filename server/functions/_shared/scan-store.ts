// Deno-side IO for the primary-branch scan worker (Task 7, slice B): the github
// MCP changed-code reader (get_commit patches) and the PostgREST persistence for
// the code evidence, findings read-back, and category-`instrumentation`
// recommendation upsert (deduped by dedupe_fingerprint, which the
// recommendations_dedupe_uniq index makes once-only). Follow-up scans are enqueued
// idempotently on scan:repo:sha.
import { isUniqueViolation } from './agent-runtime.ts';
import { createMcpClient, type McpClient } from './mcp-client.ts';
import { JobError } from '../../lib/retry.ts';
import { scrubSecrets } from '../../lib/redaction.ts';
import { scanFindingsSchema, parseScanFindings } from '../../lib/scan.ts';
import { scanJobKey } from '../../lib/github-webhook.ts';
import type {
  ChangedCodeRead,
  LoadedScanFindings,
  SaveCodeInput,
  SaveScanFindingsInput,
  ScanJobContext,
  ScanMcp,
  ScanStore,
  UpsertInstrumentationInput,
} from '../../lib/agent-scan.ts';
import type { ScanFinding } from '../../lib/scan.ts';

// deno-lint-ignore no-explicit-any
declare const Deno: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

const MAX_CODE_CHARS = 24_000;
const codeKey = (jobId: string) => `scan_code:${jobId}`;
const findingsKey = (jobId: string) => `scan_findings:${jobId}`;
const LEASE_FREE = '1970-01-01T00:00:00.000Z';

// ---- github MCP changed-code reader ------------------------------------------

export function createScanMcp(admin: Admin): ScanMcp {
  const cache = new Map<string, { client: McpClient; read: Set<string> }>();
  async function io(workspaceId: string): Promise<{ client: McpClient; read: Set<string> }> {
    const hit = cache.get(workspaceId);
    if (hit) return hit;
    const { data, error } = await admin.database.from('integrations').select('config').eq('provider', 'github').eq('workspace_id', workspaceId).limit(1).maybeSingle();
    if (error) throw new JobError({ retryable: true, code: 'github_integration_read_failed', summary: 'Could not read the GitHub integration config.', source: 'worker' });
    const mcp = data?.config?.mcp;
    const url = Deno.env.get('GITHUB_MCP_URL') ?? mcp?.server_url;
    const bearer = Deno.env.get('TRUEFOUNDRY_API_KEY');
    if (!url || !bearer) throw new JobError({ retryable: false, code: 'github_mcp_misconfigured', summary: 'GitHub MCP URL or gateway key is not configured.', source: 'github' });
    const resolved = { client: createMcpClient(url, bearer, 'github', 'github'), read: new Set<string>(mcp?.allowed_tools?.read ?? []) };
    cache.set(workspaceId, resolved);
    return resolved;
  }

  return {
    async readChangedCode(ctx: ScanJobContext): Promise<ChangedCodeRead> {
      const { client, read } = await io(ctx.workspaceId);
      if (read.size > 0 && !read.has('get_commit')) throw new JobError({ retryable: false, code: 'tool_not_allowlisted', summary: 'MCP read tool "get_commit" is not allowlisted.', source: 'github' });
      const res = await client.call('get_commit', { owner: ctx.repo.owner, repo: ctx.repo.name, sha: ctx.headSha });
      if (res.isError) throw new JobError({ retryable: true, code: 'github_commit_read_failed', summary: 'GitHub commit read failed.', source: 'github' });
      const { files, text } = extractCommitFiles(res.text);
      return {
        changedCode: scrubSecrets(text).slice(0, MAX_CODE_CHARS),
        files,
        externalId: `scan:${ctx.repo.fullName}@${ctx.headSha.slice(0, 7)}`,
        payload: { files: files.map((f) => f.path).slice(0, 100), head_sha: ctx.headSha },
      };
    },
  };
}

function extractCommitFiles(text: string): { files: { path: string }[]; text: string } {
  try {
    const j = JSON.parse(text);
    const arr: any[] = Array.isArray(j?.files) ? j.files : [];
    const files = arr.map((f) => ({ path: f?.filename ?? f?.path })).filter((f: { path?: string }) => !!f.path);
    const patches = arr
      .filter((f) => typeof f?.patch === 'string')
      .map((f) => `--- ${f.filename}\n${f.patch}`)
      .join('\n\n');
    return { files, text: patches || text };
  } catch {
    return { files: [], text };
  }
}

// ---- persistence -------------------------------------------------------------

export function createScanStore(admin: Admin): ScanStore {
  const db = admin.database;

  async function hasEvidence(jobId: string, key: string): Promise<boolean> {
    const { data, error } = await db.from('evidence_items').select('id').eq('collected_by_job_id', jobId).eq('subject_key', key).limit(1).maybeSingle();
    if (error) throw new JobError({ retryable: true, code: 'evidence_read_failed', summary: 'Could not read scan evidence.', source: 'worker' });
    return !!data;
  }

  return {
    hasCode: (jobId) => hasEvidence(jobId, codeKey(jobId)),

    async saveCode(input: SaveCodeInput) {
      const { error } = await db.from('evidence_items').insert([
        {
          workspace_id: input.workspaceId,
          source_type: 'code_file',
          source_provider: 'github',
          collected_by_job_id: input.jobId,
          subject_type: 'repository',
          subject_id: input.repositoryId,
          subject_key: codeKey(input.jobId),
          claim_type: 'fact',
          external_id: input.externalId,
          title: input.title,
          summary: input.summary,
          payload: { ...(input.payload as Record<string, unknown>), changed_code: input.changedCode },
          content_hash: input.contentHash,
          verification_state: 'verified',
          observed_at: input.now,
          collected_at: input.now,
        },
      ]);
      if (error && !isUniqueViolation(error)) throw new JobError({ retryable: true, code: 'evidence_write_failed', summary: 'Could not persist scanned code.', source: 'worker' });
    },

    async loadCode(jobId) {
      const { data, error } = await db.from('evidence_items').select('payload').eq('collected_by_job_id', jobId).eq('subject_key', codeKey(jobId)).limit(1).maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'evidence_read_failed', summary: 'Could not read scanned code.', source: 'worker' });
      const t = (data?.payload as { changed_code?: string } | undefined)?.changed_code;
      return typeof t === 'string' ? t : null;
    },

    async saveFindings(input: SaveScanFindingsInput) {
      if (await hasEvidence(input.jobId, findingsKey(input.jobId))) return;
      const { error } = await db.from('evidence_items').insert([
        {
          workspace_id: input.workspaceId,
          source_type: 'ai_model_call',
          source_provider: 'truefoundry',
          collected_by_job_id: input.jobId,
          ai_model_call_id: input.modelCallId || null,
          subject_type: 'repository',
          subject_id: input.repositoryId,
          subject_key: findingsKey(input.jobId),
          claim_type: 'inference_support',
          external_id: input.modelCallId || `findings:${input.jobId}`,
          title: 'Instrumentation scan findings',
          summary: `${input.findings.length} finding(s); ${input.validationStatus}`,
          payload: { findings: input.findings, validation_status: input.validationStatus, model_call_id: input.modelCallId || null },
          content_hash: `${input.jobId}:scan-findings`,
          verification_state: 'verified',
          observed_at: input.now,
          collected_at: input.now,
        },
      ]);
      if (error && !isUniqueViolation(error)) throw new JobError({ retryable: true, code: 'findings_write_failed', summary: 'Could not persist scan findings.', source: 'worker' });
    },

    async loadFindings(jobId): Promise<LoadedScanFindings | null> {
      const { data, error } = await db.from('evidence_items').select('payload').eq('collected_by_job_id', jobId).eq('subject_key', findingsKey(jobId)).limit(1).maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'findings_read_failed', summary: 'Could not read scan findings.', source: 'worker' });
      if (!data) return null;
      const p = (data.payload ?? {}) as { findings?: unknown[]; validation_status?: LoadedScanFindings['validationStatus']; model_call_id?: string | null };
      const validationStatus = p.validation_status ?? 'not_applicable';
      let findings: ScanFinding[] = [];
      if (validationStatus === 'valid') {
        try {
          findings = scanFindingsSchema.parse(parseScanFindings(JSON.stringify({ findings: p.findings ?? [] })) ?? { findings: [] }).findings;
        } catch {
          findings = [];
        }
      }
      return { modelCallId: p.model_call_id ?? '', validationStatus, findings };
    },

    async upsertInstrumentationRecommendation(input: UpsertInstrumentationInput): Promise<{ id: string; created: boolean }> {
      const fields = {
        repository_id: input.repositoryId,
        category: 'instrumentation',
        state: 'active',
        title: input.title,
        rationale: input.rationale,
        affected_code_path: input.affectedCodePath,
        proposed_next_step: input.proposedNextStep,
        confidence: input.severity === 'high' ? 'high' : input.severity === 'low' ? 'low' : 'likely',
        dedupe_fingerprint: input.dedupeFingerprint,
        validated_schema_version: 'recommendation.v1',
        last_seen_job_id: input.jobId,
        created_by_model_call_id: input.modelCallId || null,
        updated_at: input.now,
      };
      const { data: existing, error: selErr } = await db.from('recommendations').select('id').eq('workspace_id', input.workspaceId).eq('dedupe_fingerprint', input.dedupeFingerprint).limit(1).maybeSingle();
      if (selErr) throw new JobError({ retryable: true, code: 'recommendation_read_failed', summary: 'Could not read the recommendation.', source: 'worker' });
      if (existing?.id) {
        const { error } = await db.from('recommendations').update({ last_seen_job_id: input.jobId, updated_at: input.now, title: input.title, rationale: input.rationale, proposed_next_step: input.proposedNextStep }).eq('id', existing.id);
        if (error) throw new JobError({ retryable: true, code: 'recommendation_write_failed', summary: 'Could not update the recommendation.', source: 'worker' });
        return { id: existing.id as string, created: false };
      }
      const { data, error } = await db.from('recommendations').insert([{ workspace_id: input.workspaceId, created_by_job_id: input.jobId, created_at: input.now, ...fields }]).select('id');
      if (error) {
        if (isUniqueViolation(error)) {
          const { data: row } = await db.from('recommendations').select('id').eq('workspace_id', input.workspaceId).eq('dedupe_fingerprint', input.dedupeFingerprint).limit(1).maybeSingle();
          if (row?.id) return { id: row.id as string, created: false };
        }
        throw new JobError({ retryable: true, code: 'recommendation_write_failed', summary: 'Could not create the recommendation.', source: 'worker' });
      }
      return { id: (data as { id: string }[])[0].id, created: true };
    },

    async loadChangedFiles(jobId) {
      const { data, error } = await db.from('evidence_items').select('payload').eq('collected_by_job_id', jobId).eq('subject_key', codeKey(jobId)).limit(1).maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'evidence_read_failed', summary: 'Could not read scanned files.', source: 'worker' });
      const files = (data?.payload as { files?: string[] } | undefined)?.files;
      return Array.isArray(files) ? files : [];
    },

    async listActiveInstrumentation(repositoryId) {
      const { data, error } = await db.from('recommendations').select('id, dedupe_fingerprint, affected_code_path').eq('repository_id', repositoryId).eq('category', 'instrumentation').eq('state', 'active');
      if (error) throw new JobError({ retryable: true, code: 'recommendation_read_failed', summary: 'Could not list active recommendations.', source: 'worker' });
      return (data ?? []).map((r: any) => ({ id: r.id as string, dedupeFingerprint: (r.dedupe_fingerprint as string) ?? '', affectedCodePath: (r.affected_code_path as string) ?? '' }));
    },

    async outdateRecommendation(id, reason, now) {
      const { data } = await db.from('recommendations').select('lifecycle_events').eq('id', id).maybeSingle();
      const prior = Array.isArray(data?.lifecycle_events) ? (data!.lifecycle_events as unknown[]) : [];
      const lifecycle = [...prior, { at: now, kind: 'outdated', reason }].slice(-50);
      // state guard makes it idempotent — a re-run won't re-outdate / re-append.
      const { error } = await db.from('recommendations').update({ state: 'outdated', outdated_reason: reason, outdated_at: now, lifecycle_events: lifecycle, updated_at: now }).eq('id', id).eq('state', 'active');
      if (error) throw new JobError({ retryable: true, code: 'recommendation_write_failed', summary: 'Could not outdate the recommendation.', source: 'worker' });
    },

    async loadPendingSha(jobId) {
      const { data, error } = await db.from('jobs').select('trigger_summary').eq('id', jobId).maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'job_read_failed', summary: 'Could not read the scan job.', source: 'worker' });
      return ((data?.trigger_summary ?? {}) as { pending_sha?: string | null }).pending_sha ?? null;
    },

    async enqueueFollowupScan(workspaceId, repositoryId, repo, branch, sha, now) {
      const { error } = await db.from('jobs').insert([
        {
          workspace_id: workspaceId,
          job_type: 'proactive_scan',
          state: 'queued',
          target_type: 'repository',
          target_id: repositoryId,
          idempotency_key: scanJobKey(repositoryId, sha),
          created_by: null,
          safe_to_retry: true,
          attempt_count: 0,
          max_attempts: 3,
          retry_policy: {},
          phases: [],
          attempts: [],
          audit_events: [{ at: now, kind: 'enqueued', summary: `Coalesced follow-up scan ${sha.slice(0, 7)}` }],
          trigger_summary: { source: 'github_push', repo, branch, after_sha: sha, before_sha: null, pending_sha: null, coalesced_followup: true },
          queued_at: now,
          next_run_at: now,
          lease_expires_at: LEASE_FREE,
          locked_by: null,
          progress_version: 1,
        },
      ]);
      if (error && !isUniqueViolation(error)) throw new JobError({ retryable: true, code: 'followup_enqueue_failed', summary: 'Could not enqueue the follow-up scan.', source: 'worker' });
    },
  };
}
