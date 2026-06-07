// Deno-side IO for the PR-review worker (Task 6, slice 2 + review fixes): the
// github MCP adapter (deterministic read + the single governed inline-comment
// write + a reconcile read) and the PostgREST persistence for the diff evidence,
// findings read-back, pr_review recommendation, pr_review_comments, and
// external_write_actions audit.
//
// Exactly-once invariant: pr_review_comments has a partial-unique
// (pull_request_id, semantic_fingerprint) WHERE status='posted', so there is at
// most ONE posted row per semantic gap. claimPostedComment inserts that row BEFORE
// the GitHub write — a successful insert means "we own this gap", a conflict means
// "already posted" — which serializes concurrent ticks at the DB.
import { isUniqueViolation } from './agent-runtime.ts';
import { createMcpClient, type McpClient } from './mcp-client.ts';
import { JobError } from '../../lib/retry.ts';
import { scrubSecrets } from '../../lib/redaction.ts';
import { COMMENT_MARKER, parseFindings, prFindingsSchema } from '../../lib/pr-review.ts';
import type {
  ClaimCommentInput,
  ClaimResult,
  ExternalWriteInsert,
  FinalizeCommentInput,
  LoadedDiff,
  LoadedFindings,
  PrJobContext,
  PrMcp,
  PrReviewStore,
  RefreshPlacementInput,
  SaveDiffInput,
  SaveFindingsInput,
  UpsertRecommendationInput,
} from '../../lib/agent-pr.ts';
import type { PrFinding } from '../../lib/pr-review.ts';

// deno-lint-ignore no-explicit-any
declare const Deno: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

const MAX_DIFF_CHARS = 24_000;
const diffKey = (jobId: string) => `pr_diff:${jobId}`;
const findingsKey = (jobId: string) => `pr_findings:${jobId}`;

// ---- github MCP adapter ------------------------------------------------------

export function createPrMcp(admin: Admin): PrMcp {
  // Cache per workspace so a multi-integration / multi-workspace setup resolves
  // the right MCP URL + allowlist (review fix).
  const cache = new Map<string, { client: McpClient; read: Set<string>; write: Set<string> }>();

  async function io(workspaceId: string): Promise<{ client: McpClient; read: Set<string>; write: Set<string> }> {
    const hit = cache.get(workspaceId);
    if (hit) return hit;
    const { data, error } = await admin.database.from('integrations').select('config').eq('provider', 'github').eq('workspace_id', workspaceId).limit(1).maybeSingle();
    if (error) throw new JobError({ retryable: true, code: 'github_integration_read_failed', summary: 'Could not read the GitHub integration config.', source: 'worker' });
    const mcp = data?.config?.mcp;
    const url = Deno.env.get('GITHUB_MCP_URL') ?? mcp?.server_url;
    const bearer = Deno.env.get('TRUEFOUNDRY_API_KEY');
    if (!url || !bearer) throw new JobError({ retryable: false, code: 'github_mcp_misconfigured', summary: 'GitHub MCP URL or gateway key is not configured.', source: 'github' });
    const resolved = { client: createMcpClient(url, bearer, 'github', 'github'), read: new Set<string>(mcp?.allowed_tools?.read ?? []), write: new Set<string>(mcp?.allowed_tools?.write ?? []) };
    cache.set(workspaceId, resolved);
    return resolved;
  }

  // Reads are lenient when the allowlist isn't populated (the gateway still
  // enforces); WRITES fail CLOSED — a write tool must be explicitly allowlisted.
  function assertRead(set: Set<string>, tool: string): void {
    if (set.size > 0 && !set.has(tool)) throw new JobError({ retryable: false, code: 'tool_not_allowlisted', summary: `MCP read tool "${tool}" is not allowlisted.`, source: 'github' });
  }
  function assertWrite(set: Set<string>, tool: string): void {
    if (!set.has(tool)) throw new JobError({ retryable: false, code: 'write_tool_not_allowlisted', summary: `MCP write tool "${tool}" is not allowlisted (write governance).`, source: 'github' });
  }

  return {
    async readDiff(ctx: PrJobContext) {
      const { client, read } = await io(ctx.workspaceId);
      assertRead(read, 'pull_request_read');
      const base = { owner: ctx.repo.owner, repo: ctx.repo.name, pullNumber: ctx.prNumber };
      const meta = await client.call('pull_request_read', { ...base, method: 'get' });
      if (meta.isError) throw new JobError({ retryable: true, code: 'github_pr_read_failed', summary: 'GitHub PR metadata read failed.', source: 'github' });
      const liveHeadSha = extractHeadSha(meta.text);
      const filesRes = await client.call('pull_request_read', { ...base, method: 'get_files', perPage: 100 });
      if (filesRes.isError) throw new JobError({ retryable: true, code: 'github_files_read_failed', summary: 'GitHub changed-files read failed.', source: 'github' });
      const diffRes = await client.call('pull_request_read', { ...base, method: 'get_diff' });
      if (diffRes.isError) throw new JobError({ retryable: true, code: 'github_diff_read_failed', summary: 'GitHub diff read failed.', source: 'github' });
      const files = extractFiles(filesRes.text);
      // Scrub the stored snapshot (a secret committed in a diff must not persist at rest).
      const diffText = scrubSecrets(diffRes.text).slice(0, MAX_DIFF_CHARS);
      return {
        diffText,
        files,
        externalId: `pr_diff:${ctx.repo.fullName}#${ctx.prNumber}@${ctx.headSha.slice(0, 7)}`,
        uri: ctx.htmlUrl,
        liveHeadSha,
        payload: { files: files.map((f) => f.path).slice(0, 100), job_head_sha: ctx.headSha, live_head_sha: liveHeadSha },
      };
    },

    async findExistingComment(ctx: PrJobContext, finding: PrFinding) {
      const { client, read } = await io(ctx.workspaceId);
      assertRead(read, 'pull_request_read');
      const res = await client.call('pull_request_read', { owner: ctx.repo.owner, repo: ctx.repo.name, pullNumber: ctx.prNumber, method: 'get_review_comments', perPage: 100 });
      if (res.isError) return null; // reconcile is best-effort; fall through to (re)post
      return findMarkerComment(res.text, finding);
    },

    async postReviewComment(ctx: PrJobContext, finding: PrFinding, body: string) {
      const { client, write } = await io(ctx.workspaceId);
      assertWrite(write, 'pull_request_review_write');
      assertWrite(write, 'add_comment_to_pending_review');
      const base = { owner: ctx.repo.owner, repo: ctx.repo.name, pullNumber: ctx.prNumber };

      // Create a pending review on the head commit. If one is already pending (a
      // crashed prior attempt), clear it and retry once.
      let create = await client.call('pull_request_review_write', { ...base, method: 'create', commitID: ctx.headSha });
      if (create.isError) {
        await client.call('pull_request_review_write', { ...base, method: 'delete_pending' }).catch(() => {});
        create = await client.call('pull_request_review_write', { ...base, method: 'create', commitID: ctx.headSha });
        if (create.isError) throw new JobError({ retryable: true, code: 'github_review_create_failed', summary: 'Could not create a pending PR review.', source: 'github' });
      }
      const add = await client.call('add_comment_to_pending_review', { ...base, path: finding.file_path, line: finding.line_number, side: finding.side ?? 'RIGHT', subjectType: 'LINE', body });
      if (add.isError) {
        // The model's line often isn't a commentable diff line — terminal per-comment.
        await client.call('pull_request_review_write', { ...base, method: 'delete_pending' }).catch(() => {});
        throw new JobError({ retryable: false, code: 'github_comment_rejected', summary: 'GitHub rejected the inline comment (line may not be in the diff).', source: 'github' });
      }
      const submit = await client.call('pull_request_review_write', { ...base, method: 'submit_pending', event: 'COMMENT', body: 'Instrument observability review' });
      if (submit.isError) throw new JobError({ retryable: true, code: 'github_review_submit_failed', summary: 'Could not submit the PR review.', source: 'github' });
      const externalId = extractId(add.raw) ?? extractId(submit.raw) ?? `review:${ctx.headSha.slice(0, 7)}:${finding.file_path}:${finding.line_number}:${finding.issue_type.slice(0, 16)}`;
      const url = extractUrl(add.raw) ?? extractUrl(submit.raw) ?? ctx.htmlUrl;
      return { externalId, url };
    },
  };
}

function extractHeadSha(text: string): string | null {
  try {
    return deepFind(JSON.parse(text), ['head_sha']) ?? deepFindNested(JSON.parse(text), ['head', 'sha']);
  } catch {
    return null;
  }
}
function extractFiles(text: string): { path: string }[] {
  try {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : Array.isArray(j?.files) ? j.files : [];
    return arr.map((f: any) => ({ path: f?.filename ?? f?.path })).filter((f: { path?: string }) => !!f.path).slice(0, 100);
  } catch {
    return [];
  }
}
function findMarkerComment(text: string, finding: PrFinding): { externalId: string; url: string | null } | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const comments: any[] = [];
  const walk = (v: unknown, depth = 0): void => {
    if (!v || depth > 5) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.body === 'string' && (o.path !== undefined || o.line !== undefined)) comments.push(o);
      for (const val of Object.values(o)) walk(val, depth + 1);
    }
  };
  walk(j);
  const hit = comments.find((c) => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER) && c.path === finding.file_path && Number(c.line) === finding.line_number);
  if (!hit) return null;
  return { externalId: String(hit.node_id ?? hit.id ?? `marker:${finding.file_path}:${finding.line_number}`), url: (hit.html_url as string) ?? null };
}
function deepFind(obj: unknown, keys: string[], depth = 0): string | null {
  if (!obj || depth > 4) return null;
  if (typeof obj === 'object') {
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      if (typeof v === 'string' && v) return v;
      if (typeof v === 'number') return String(v);
    }
    for (const v of Object.values(obj as Record<string, unknown>)) {
      const hit = deepFind(v, keys, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
function deepFindNested(obj: unknown, path: string[]): string | null {
  let cur: any = obj;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[k];
  }
  return typeof cur === 'string' ? cur : null;
}
function extractId(raw: unknown): string | null {
  const r = raw as { content?: { text?: string }[] };
  const text = r?.content?.find?.((c) => c?.text)?.text;
  if (text) {
    try {
      return deepFind(JSON.parse(text), ['node_id', 'id']);
    } catch {
      /* fall through */
    }
  }
  return deepFind(raw, ['node_id', 'id']);
}
function extractUrl(raw: unknown): string | null {
  const r = raw as { content?: { text?: string }[] };
  const text = r?.content?.find?.((c) => c?.text)?.text;
  if (text) {
    try {
      return deepFind(JSON.parse(text), ['html_url', 'url']);
    } catch {
      /* fall through */
    }
  }
  return deepFind(raw, ['html_url', 'url']);
}

// ---- persistence -------------------------------------------------------------

export function createPrReviewStore(admin: Admin): PrReviewStore {
  const db = admin.database;

  return {
    async hasDiff(jobId) {
      const { data, error } = await db.from('evidence_items').select('id').eq('collected_by_job_id', jobId).eq('subject_key', diffKey(jobId)).limit(1).maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'evidence_read_failed', summary: 'Could not read prior diff evidence.', source: 'worker' });
      return !!data;
    },

    async saveDiff(input: SaveDiffInput) {
      const payload = { ...(input.payload as Record<string, unknown>), diff_text: input.diffText, superseded: input.superseded };
      const { error } = await db.from('evidence_items').insert([
        {
          workspace_id: input.workspaceId,
          source_type: 'pr_diff',
          source_provider: 'github',
          collected_by_job_id: input.jobId,
          subject_type: 'pull_request',
          subject_id: input.pullRequestId,
          subject_key: diffKey(input.jobId),
          claim_type: 'fact',
          external_id: input.externalId,
          uri: input.uri,
          title: input.title,
          summary: input.summary,
          payload,
          content_hash: input.contentHash,
          verification_state: 'verified',
          observed_at: input.now,
          collected_at: input.now,
        },
      ]);
      if (error && !isUniqueViolation(error)) throw new JobError({ retryable: true, code: 'evidence_write_failed', summary: 'Could not persist the diff evidence.', source: 'worker' });
    },

    async loadDiff(jobId): Promise<LoadedDiff | null> {
      const { data, error } = await db.from('evidence_items').select('payload').eq('collected_by_job_id', jobId).eq('subject_key', diffKey(jobId)).limit(1).maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'evidence_read_failed', summary: 'Could not read the diff evidence.', source: 'worker' });
      if (!data) return null;
      const p = (data.payload ?? {}) as { diff_text?: string; superseded?: boolean };
      return { diffText: typeof p.diff_text === 'string' ? p.diff_text : '', superseded: p.superseded === true };
    },

    async saveFindings(input: SaveFindingsInput) {
      const { data: existing } = await db.from('evidence_items').select('id').eq('collected_by_job_id', input.jobId).eq('subject_key', findingsKey(input.jobId)).limit(1).maybeSingle();
      if (existing) return; // resume: already saved
      const { error } = await db.from('evidence_items').insert([
        {
          workspace_id: input.workspaceId,
          source_type: 'ai_model_call',
          source_provider: 'truefoundry',
          collected_by_job_id: input.jobId,
          ai_model_call_id: input.modelCallId || null,
          subject_type: 'pull_request',
          subject_id: input.pullRequestId,
          subject_key: findingsKey(input.jobId),
          claim_type: 'inference_support',
          external_id: input.modelCallId || `findings:${input.jobId}`,
          title: 'PR review findings',
          summary: `${input.findings.length} finding(s); ${input.validationStatus}`,
          payload: { findings: input.findings, validation_status: input.validationStatus, model_call_id: input.modelCallId || null },
          content_hash: `${input.jobId}:findings`,
          verification_state: 'verified',
          observed_at: input.now,
          collected_at: input.now,
        },
      ]);
      if (error && !isUniqueViolation(error)) throw new JobError({ retryable: true, code: 'findings_write_failed', summary: 'Could not persist the analysis findings.', source: 'worker' });
    },

    async loadFindings(jobId): Promise<LoadedFindings | null> {
      const { data, error } = await db.from('evidence_items').select('payload').eq('collected_by_job_id', jobId).eq('subject_key', findingsKey(jobId)).limit(1).maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'findings_read_failed', summary: 'Could not read the analysis findings.', source: 'worker' });
      if (!data) return null;
      const p = (data.payload ?? {}) as { findings?: unknown[]; validation_status?: LoadedFindings['validationStatus']; model_call_id?: string | null };
      const validationStatus = p.validation_status ?? 'not_applicable';
      let findings: PrFinding[] = [];
      if (validationStatus === 'valid') {
        try {
          findings = prFindingsSchema.parse({ findings: p.findings ?? [] }).findings;
        } catch {
          findings = [];
        }
      }
      return { modelCallId: p.model_call_id ?? '', validationStatus, findings };
    },

    async upsertRecommendation(input: UpsertRecommendationInput): Promise<string> {
      const { data: pr } = await db.from('github_pull_requests').select('repository_id').eq('id', input.pullRequestId).limit(1).maybeSingle();
      const repositoryId = (pr?.repository_id as string | undefined) ?? null;
      const fields = {
        repository_id: repositoryId,
        category: 'pr_review',
        state: 'active',
        title: `PR #${input.prNumber}: ${input.title}`.slice(0, 200),
        rationale: `${input.findingCount} observability gap(s) found in ${input.repo.fullName}#${input.prNumber}.`,
        affected_runtime_path: input.htmlUrl,
        proposed_next_step: 'Review the inline observability comments Instrument posted on the changed lines.',
        dedupe_fingerprint: input.dedupeFingerprint,
        validated_schema_version: 'pr_review_recommendation.v1',
        last_seen_job_id: input.jobId,
        created_by_model_call_id: input.modelCallId || null,
        updated_at: input.now,
      };
      const { data: existing, error: selErr } = await db.from('recommendations').select('id').eq('workspace_id', input.workspaceId).eq('dedupe_fingerprint', input.dedupeFingerprint).limit(1).maybeSingle();
      if (selErr) throw new JobError({ retryable: true, code: 'recommendation_read_failed', summary: 'Could not read the PR recommendation.', source: 'worker' });
      if (existing?.id) {
        const { error } = await db.from('recommendations').update(fields).eq('id', existing.id);
        if (error) throw new JobError({ retryable: true, code: 'recommendation_write_failed', summary: 'Could not update the PR recommendation.', source: 'worker' });
        return existing.id as string;
      }
      const { data, error } = await db.from('recommendations').insert([{ workspace_id: input.workspaceId, created_by_job_id: input.jobId, created_at: input.now, ...fields }]).select('id');
      if (error) {
        if (isUniqueViolation(error)) {
          const { data: row } = await db.from('recommendations').select('id').eq('workspace_id', input.workspaceId).eq('dedupe_fingerprint', input.dedupeFingerprint).limit(1).maybeSingle();
          if (row?.id) return row.id as string;
        }
        throw new JobError({ retryable: true, code: 'recommendation_write_failed', summary: 'Could not create the PR recommendation.', source: 'worker' });
      }
      return (data as { id: string }[])[0].id;
    },

    async claimPostedComment(input: ClaimCommentInput): Promise<ClaimResult> {
      const f = input.finding;
      const row = {
        workspace_id: input.workspaceId,
        pull_request_id: input.pullRequestId,
        recommendation_id: input.recommendationId,
        job_id: input.jobId,
        created_by_model_call_id: input.modelCallId || null,
        event_action: input.eventAction,
        head_sha: input.headSha,
        semantic_fingerprint: input.semanticFingerprint,
        revision_fingerprint: input.revisionFingerprint,
        issue_type: f.issue_type,
        file_path: f.file_path,
        line_number: f.line_number,
        side: f.side ?? 'RIGHT',
        code_anchor: f.code_anchor ?? null,
        body: f.body,
        suggested_code: f.suggested_code ?? null,
        validated_schema_version: 'pr_review_findings.v1',
        status: 'posted',
        external_comment_id: null,
        external_write_action_id: null,
        posted_at: input.now,
        created_at: input.now,
        updated_at: input.now,
      };
      const { data, error } = await db.from('pr_review_comments').insert([row]).select('id');
      if (!error) return { state: 'claimed', id: (data as { id: string }[])[0].id };
      if (!isUniqueViolation(error)) throw new JobError({ retryable: true, code: 'comment_claim_failed', summary: 'Could not claim the PR comment row.', source: 'worker' });

      // Our own revision row already exists (resume of this exact revision)?
      const { data: sameRev } = await db.from('pr_review_comments').select('id, external_comment_id').eq('pull_request_id', input.pullRequestId).eq('revision_fingerprint', input.revisionFingerprint).limit(1).maybeSingle();
      if (sameRev?.id) return { state: 'resumed', id: sameRev.id as string, externalCommentId: (sameRev.external_comment_id as string | null) ?? null };
      // A different posted row for the same semantic gap (earlier revision / concurrent job)?
      const { data: posted } = await db.from('pr_review_comments').select('id').eq('pull_request_id', input.pullRequestId).eq('semantic_fingerprint', input.semanticFingerprint).eq('status', 'posted').limit(1).maybeSingle();
      if (posted?.id) return { state: 'exists', existing: { id: posted.id as string } };
      return { state: 'lost' };
    },

    async outdateComment(id, now) {
      const { error } = await db.from('pr_review_comments').update({ status: 'outdated', outdated_at: now, updated_at: now }).eq('id', id);
      if (error) throw new JobError({ retryable: true, code: 'comment_outdate_failed', summary: 'Could not outdate the prior comment.', source: 'worker' });
    },

    async refreshCommentPlacement(input: RefreshPlacementInput) {
      // Placement ONLY — never body / external ids / posted_at (the GitHub comment is unchanged).
      const { error } = await db.from('pr_review_comments').update({ revision_fingerprint: input.revisionFingerprint, head_sha: input.headSha, line_number: input.lineNumber, updated_at: input.now }).eq('id', input.id);
      if (error) throw new JobError({ retryable: true, code: 'comment_refresh_failed', summary: 'Could not refresh the comment placement.', source: 'worker' });
    },

    async finalizeComment(input: FinalizeCommentInput) {
      const { error } = await db.from('pr_review_comments').update({ external_comment_id: input.externalCommentId, external_write_action_id: input.externalWriteActionId, updated_at: input.now }).eq('id', input.id);
      if (error) throw new JobError({ retryable: true, code: 'comment_finalize_failed', summary: 'Could not finalize the posted comment.', source: 'worker' });
    },

    async findExternalWrite(workspaceId, key) {
      const { data, error } = await db.from('external_write_actions').select('id, state, external_id, external_url').eq('workspace_id', workspaceId).eq('provider', 'github').eq('action_kind', 'github_review_comment').eq('idempotency_key', key).limit(1).maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'external_write_read_failed', summary: 'Could not read the external write audit.', source: 'worker' });
      if (!data) return null;
      return { id: data.id as string, state: data.state as string, externalId: (data.external_id as string | null) ?? null, externalUrl: (data.external_url as string | null) ?? null };
    },

    async insertExternalWrite(input: ExternalWriteInsert): Promise<string> {
      const row = {
        workspace_id: input.workspaceId,
        approval_id: null, // allowed null only for github_review_comment (ERD)
        job_id: input.jobId,
        provider: 'github',
        action_kind: input.actionKind,
        idempotency_key: input.idempotencyKey,
        target_summary: input.targetSummary,
        request_hash: input.requestHash,
        request_redacted: input.requestRedacted,
        response_summary: {},
        state: input.state,
        started_at: input.state === 'planned' ? input.now : null,
        completed_at: input.state === 'skipped_duplicate' ? input.now : null,
      };
      const { data, error } = await db.from('external_write_actions').insert([row]).select('id');
      if (error) {
        if (isUniqueViolation(error)) {
          const { data: ex } = await db.from('external_write_actions').select('id').eq('workspace_id', input.workspaceId).eq('provider', 'github').eq('action_kind', input.actionKind).eq('idempotency_key', input.idempotencyKey).limit(1).maybeSingle();
          if (ex?.id) return ex.id as string;
        }
        throw new JobError({ retryable: true, code: 'external_write_failed', summary: 'Could not record the external write.', source: 'worker' });
      }
      return (data as { id: string }[])[0].id;
    },

    async markExternalWrite(id, patch) {
      const update: Record<string, unknown> = { state: patch.state };
      if (patch.externalId !== undefined) update.external_id = patch.externalId;
      if (patch.externalUrl !== undefined) update.external_url = patch.externalUrl;
      if (patch.responseSummary !== undefined) update.response_summary = patch.responseSummary;
      if (patch.errorCode !== undefined) update.error_code = patch.errorCode;
      if (patch.errorSummary !== undefined) update.error_summary = patch.errorSummary;
      if (patch.state === 'succeeded' || patch.state === 'failed') update.completed_at = patch.now;
      const { error } = await db.from('external_write_actions').update(update).eq('id', id);
      if (error) throw new JobError({ retryable: true, code: 'external_write_update_failed', summary: 'Could not update the external write.', source: 'worker' });
    },
  };
}
