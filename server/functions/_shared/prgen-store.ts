// Deno-side IO for recommendation-PR generation (Task 8): the github MCP write
// adapter (read file → create branch → update file → create PR) and the PostgREST
// persistence (approval/recommendation load, file+patch evidence, recommendation
// step updates, external_write_actions audit). All provider writes go through the
// gateway-brokered github MCP; each is recorded as an external_write_actions row
// carrying the approval id + approved_payload_hash (request_hash).
import { isUniqueViolation } from './agent-runtime.ts';
import { createMcpClient, type McpClient } from './mcp-client.ts';
import { JobError } from '../../lib/retry.ts';
import { prGenPatchSchema, parsePatch } from '../../lib/pr-gen.ts';
import type { CreatedPr, ExternalWriteInsert, FileRead, LoadedPatch, PrGenJobContext, PrGenMcp, PrGenPlan, PrGenStore } from '../../lib/agent-prgen.ts';
import type { PrGenPatch } from '../../lib/pr-gen.ts';

// deno-lint-ignore no-explicit-any
declare const Deno: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

const fileKey = (jobId: string) => `prgen_file:${jobId}`;
const patchKey = (jobId: string) => `prgen_patch:${jobId}`;

// ---- github MCP write adapter ------------------------------------------------

export function createPrGenMcp(admin: Admin): PrGenMcp {
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
  function assertWrite(set: Set<string>, tool: string): void {
    if (!set.has(tool)) throw new JobError({ retryable: false, code: 'write_tool_not_allowlisted', summary: `MCP write tool "${tool}" is not allowlisted.`, source: 'github' });
  }

  // The PrGenMcp interface methods don't carry workspaceId; resolve it from the
  // (single, demo) github integration and cache the resolved client.
  async function client(): Promise<{ client: McpClient; read: Set<string>; write: Set<string> }> {
    return io(await firstGithubWorkspace(admin));
  }

  return {
    async readFile(repo, path, ref): Promise<FileRead | null> {
      const { client: c } = await client();
      const res = await c.call('get_file_contents', { owner: repo.owner, repo: repo.name, path, ref });
      if (res.isError) return null;
      return parseFileContents(res);
    },
    async createBranch(repo, branch, fromBranch) {
      const { client: c, write } = await client();
      assertWrite(write, 'create_branch');
      const res = await c.call('create_branch', { owner: repo.owner, repo: repo.name, branch, from_branch: fromBranch });
      // Already-exists is idempotent success.
      if (res.isError && !/exist|already|reference already/i.test(res.text)) throw new JobError({ retryable: true, code: 'github_branch_failed', summary: 'Could not create the branch.', source: 'github' });
    },
    async updateFile(repo, branch, path, content, message, sha) {
      const { client: c, write } = await client();
      assertWrite(write, 'create_or_update_file');
      const res = await c.call('create_or_update_file', { owner: repo.owner, repo: repo.name, path, content, message, branch, ...(sha ? { sha } : {}) });
      if (res.isError) throw new JobError({ retryable: true, code: 'github_file_failed', summary: 'Could not update the file.', source: 'github' });
    },
    async createPr(repo, branch, baseBranch, title, body): Promise<CreatedPr> {
      const { client: c, write } = await client();
      assertWrite(write, 'create_pull_request');
      const res = await c.call('create_pull_request', { owner: repo.owner, repo: repo.name, title, head: branch, base: baseBranch, body });
      if (res.isError) {
        // A PR for this branch may already exist (crash-resume) — recover its number.
        const existing = await findOpenPrForBranch(c, repo, branch);
        if (existing) return existing;
        throw new JobError({ retryable: true, code: 'github_pr_failed', summary: 'Could not create the pull request.', source: 'github' });
      }
      const pr = parsePr(res.text);
      if (!pr) throw new JobError({ retryable: true, code: 'github_pr_unparsed', summary: 'Could not read the created PR.', source: 'github' });
      return pr;
    },
  };
}

async function firstGithubWorkspace(admin: Admin): Promise<string> {
  const { data } = await admin.database.from('integrations').select('workspace_id').eq('provider', 'github').limit(1).maybeSingle();
  return (data?.workspace_id as string) ?? '';
}
// The github MCP returns get_file_contents as a status `text` block plus a
// `resource` block whose `resource.text` holds the file content; the mcp-client
// only surfaces text blocks, so read from `raw.content`. The SHA is in the status
// line ("... (SHA: <40hex>)"). Falls back to an inline-JSON shape for safety.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseFileContents(res: { text: string; raw: any }): FileRead | null {
  const content = res.raw?.content;
  let text = '';
  if (Array.isArray(content)) {
    const resource = content.find((b: any) => b?.type === 'resource' && typeof b?.resource?.text === 'string');
    if (resource) text = resource.resource.text as string;
  }
  if (!text) {
    try {
      const j = JSON.parse(res.text);
      if (typeof j?.content === 'string') text = j.encoding === 'base64' ? atob(j.content.replace(/\n/g, '')) : j.content;
      else if (typeof j?.text === 'string') text = j.text;
    } catch {
      /* not inline JSON */
    }
  }
  if (!text) return null;
  const sha = /SHA:\s*([0-9a-f]{40})/i.exec(res.text)?.[1] ?? null;
  return { content: text, sha };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parsePr(text: string): CreatedPr | null {
  try {
    const j = JSON.parse(text);
    const n = j?.number ?? j?.pull_request?.number;
    if (n == null) return null;
    return { number: Number(n), url: (j.html_url ?? j.url ?? j?.pull_request?.html_url) ?? '', nodeId: (j.node_id ?? null) as string | null };
  } catch {
    return null;
  }
}
async function findOpenPrForBranch(c: McpClient, repo: PrGenPlan['repo'], branch: string): Promise<CreatedPr | null> {
  try {
    const res = await c.call('list_pull_requests', { owner: repo.owner, repo: repo.name, state: 'open', head: `${repo.owner}:${branch}`, perPage: 5 });
    const arr = JSON.parse(res.text);
    const list = Array.isArray(arr) ? arr : arr?.pull_requests ?? arr?.items ?? [];
    const hit = list.find((p: any) => p?.head?.ref === branch) ?? list[0];
    if (!hit?.number) return null;
    return { number: Number(hit.number), url: hit.html_url ?? '', nodeId: hit.node_id ?? null };
  } catch {
    return null;
  }
}

// ---- persistence -------------------------------------------------------------

export function createPrGenStore(admin: Admin): PrGenStore {
  const db = admin.database;

  async function getEvidence(jobId: string, key: string): Promise<any | null> {
    const { data, error } = await db.from('evidence_items').select('payload').eq('collected_by_job_id', jobId).eq('subject_key', key).limit(1).maybeSingle();
    if (error) throw new JobError({ retryable: true, code: 'evidence_read_failed', summary: 'Could not read PR-gen evidence.', source: 'worker' });
    return data?.payload ?? null;
  }
  async function putEvidence(jobId: string, workspaceId: string, recommendationId: string, key: string, title: string, payload: unknown, now: string, sourceType: string): Promise<void> {
    const { data: existing } = await db.from('evidence_items').select('id').eq('collected_by_job_id', jobId).eq('subject_key', key).limit(1).maybeSingle();
    if (existing) return;
    const { error } = await db.from('evidence_items').insert([
      { workspace_id: workspaceId, source_type: sourceType, source_provider: sourceType === 'ai_model_call' ? 'truefoundry' : 'github', collected_by_job_id: jobId, subject_type: 'recommendation', subject_id: recommendationId, subject_key: key, claim_type: 'fact', external_id: key, title, summary: title, payload, content_hash: `${jobId}:${key}`, verification_state: 'verified', observed_at: now, collected_at: now },
    ]);
    if (error && !isUniqueViolation(error)) throw new JobError({ retryable: true, code: 'evidence_write_failed', summary: 'Could not persist PR-gen evidence.', source: 'worker' });
  }
  async function updateStep(recommendationId: string, stepKey: string | null, mut: (step: any) => void, now: string): Promise<void> {
    const { data, error } = await db.from('recommendations').select('steps').eq('id', recommendationId).maybeSingle();
    if (error) throw new JobError({ retryable: true, code: 'recommendation_read_failed', summary: 'Could not read the recommendation steps.', source: 'worker' });
    const steps = Array.isArray(data?.steps) ? [...(data!.steps as any[])] : [];
    const idx = steps.findIndex((s) => s?.key === stepKey);
    if (idx < 0) return; // no matching step (e.g. instrumentation rec with no code_pr step yet)
    steps[idx] = { ...steps[idx] };
    mut(steps[idx]);
    const { error: upErr } = await db.from('recommendations').update({ steps, updated_at: now }).eq('id', recommendationId);
    if (upErr) throw new JobError({ retryable: true, code: 'recommendation_write_failed', summary: 'Could not update the recommendation step.', source: 'worker' });
  }

  return {
    async loadPlan(ctx: PrGenJobContext): Promise<PrGenPlan | null> {
      const { data: approval, error: aErr } = await db.from('approvals').select('state, approved_payload_hash, action_type, target_type, target_id, target_step_key, workspace_id').eq('id', ctx.approvalId).maybeSingle();
      if (aErr) throw new JobError({ retryable: true, code: 'approval_read_failed', summary: 'Could not read the approval.', source: 'worker' });
      if (!approval) return null;
      // Governance: the approval must actually authorize THIS PR-generation for THIS
      // recommendation/step in THIS workspace — never act on a mismatched approval id.
      if (
        approval.action_type !== 'generate_pr' ||
        approval.target_type !== 'recommendation' ||
        approval.target_id !== ctx.recommendationId ||
        (approval.target_step_key ?? null) !== ctx.stepKey ||
        approval.workspace_id !== ctx.workspaceId
      ) {
        throw new JobError({ retryable: false, code: 'approval_mismatch', summary: 'The approval does not authorize PR generation for this recommendation step.', source: 'worker' });
      }
      const { data: rec, error: rErr } = await db.from('recommendations').select('title, rationale, proposed_next_step, affected_code_path, repository_id').eq('id', ctx.recommendationId).maybeSingle();
      if (rErr) throw new JobError({ retryable: true, code: 'recommendation_read_failed', summary: 'Could not read the recommendation.', source: 'worker' });
      if (!rec) return null;
      const { data: repo } = await db.from('repositories').select('github_owner, github_name, default_branch').eq('id', rec.repository_id).maybeSingle();
      if (!repo) return null;
      const filePath = String(rec.affected_code_path ?? '').split(':')[0];
      if (!filePath) return null;
      return {
        approvalState: approval.state as string,
        approvedPayloadHash: (approval.approved_payload_hash as string) ?? '',
        repo: { owner: repo.github_owner as string, name: repo.github_name as string, fullName: `${repo.github_owner}/${repo.github_name}`, defaultBranch: (repo.default_branch as string) ?? 'main' },
        integrationId: null,
        recommendationTitle: (rec.title as string) ?? '',
        recommendationRationale: (rec.rationale as string) ?? '',
        proposedNextStep: (rec.proposed_next_step as string) ?? '',
        filePath,
      };
    },

    async loadFileBaseline(jobId) {
      const p = await getEvidence(jobId, fileKey(jobId));
      return p ? { path: p.path, content: p.content, sha: p.sha ?? null } : null;
    },
    saveFileBaseline: (jobId, workspaceId, recommendationId, path, content, sha, now) => putEvidence(jobId, workspaceId, recommendationId, fileKey(jobId), `Baseline ${path}`, { path, content, sha }, now, 'code_file'),

    async loadPatch(jobId): Promise<LoadedPatch | null> {
      const p = await getEvidence(jobId, patchKey(jobId));
      if (!p) return null;
      const validationStatus = p.validation_status ?? 'not_applicable';
      let patch: PrGenPatch | null = null;
      if (validationStatus === 'valid') {
        try {
          patch = prGenPatchSchema.parse(parsePatch(JSON.stringify(p.patch)) ?? p.patch);
        } catch {
          patch = null;
        }
      }
      return { modelCallId: p.model_call_id ?? '', validationStatus, patch };
    },
    savePatch: (jobId, workspaceId, recommendationId, modelCallId, validationStatus, patch, now) => putEvidence(jobId, workspaceId, recommendationId, patchKey(jobId), 'Generated patch', { patch, validation_status: validationStatus, model_call_id: modelCallId || null }, now, 'ai_model_call'),

    setStepState: (recommendationId, stepKey, state, now) => updateStep(recommendationId, stepKey, (s) => { s.state = state; }, now),
    setGeneratedPr: (recommendationId, stepKey, generatedPr, now) => updateStep(recommendationId, stepKey, (s) => { s.generated_pr = generatedPr; }, now),

    async findExternalWrite(workspaceId, key) {
      const { data, error } = await db.from('external_write_actions').select('id, state, external_id, external_url').eq('workspace_id', workspaceId).eq('idempotency_key', key).limit(1).maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'external_write_read_failed', summary: 'Could not read the external write audit.', source: 'worker' });
      if (!data) return null;
      return { id: data.id as string, state: data.state as string, externalId: (data.external_id as string | null) ?? null, externalUrl: (data.external_url as string | null) ?? null };
    },
    async insertExternalWrite(input: ExternalWriteInsert): Promise<string> {
      const row = { workspace_id: input.workspaceId, approval_id: input.approvalId, job_id: input.jobId, provider: 'github', action_kind: input.actionKind, idempotency_key: input.idempotencyKey, target_summary: input.targetSummary, request_hash: input.requestHash, request_redacted: input.requestRedacted, response_summary: {}, state: 'planned', started_at: input.now };
      const { data, error } = await db.from('external_write_actions').insert([row]).select('id');
      if (error) {
        if (isUniqueViolation(error)) {
          const { data: ex } = await db.from('external_write_actions').select('id').eq('workspace_id', input.workspaceId).eq('idempotency_key', input.idempotencyKey).limit(1).maybeSingle();
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
      if (patch.errorCode !== undefined) update.error_code = patch.errorCode;
      if (patch.errorSummary !== undefined) update.error_summary = patch.errorSummary;
      if (patch.state === 'succeeded' || patch.state === 'failed') update.completed_at = patch.now;
      const { error } = await db.from('external_write_actions').update(update).eq('id', id);
      if (error) throw new JobError({ retryable: true, code: 'external_write_update_failed', summary: 'Could not update the external write.', source: 'worker' });
    },
  };
}
