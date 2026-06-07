// Deno-side concrete implementations for the Task 5C model-call helper:
// a PostgREST-backed ModelCallStore (full ai_model_calls + evidence_items rows)
// and an AgentInvoker that wraps the streaming TrueFoundry gateway for non-tool
// chat completions. The pure orchestration lives in server/lib/model-call.ts;
// this file is the IO edge that downstream workflow functions (Tasks 6/7/9/11/12)
// wire up. Bundled into a function only when that function imports it.
//
// Mirrors the hardening in agent-runtime.ts: reads/writes fail safe, a unique
// constraint hit is treated as an idempotent dedup, and no provider body is ever
// copied into a job-visible error.
import type {
  AgentInvokeRequest,
  AgentInvokeResult,
  AgentInvoker,
  EvidenceRow,
  ModelCallRow,
  ModelCallStore,
} from '../../lib/model-call.ts';
import { createGateway, isUniqueViolation } from './agent-runtime.ts';
import { JobError } from '../../lib/retry.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

// ai_model_calls has NOT NULL columns the gateway can't always fill (a failed
// call has no model; an unversioned call has no schema). Coerce to sentinels at
// the DB boundary so an audit row always lands.
const UNKNOWN_MODEL = 'unknown';
const NO_SCHEMA = 'none';

/** PostgREST-backed ModelCallStore. Writes one ai_model_calls row, returns its id. */
export function createModelCallStore(admin: Admin): ModelCallStore {
  const db = admin.database;
  const integrationCache = new Map<string, string>();

  // integration_id is NOT NULL; resolve the workspace's TrueFoundry integration
  // when the caller doesn't supply one (mirrors the 5B work store).
  async function integrationFor(workspaceId: string): Promise<string> {
    const cached = integrationCache.get(workspaceId);
    if (cached) return cached;
    const { data, error } = await db
      .from('integrations')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('provider', 'truefoundry')
      .limit(1)
      .maybeSingle();
    if (error) throw new JobError({ retryable: true, code: 'integration_lookup_failed', summary: 'Could not resolve the TrueFoundry integration.', source: 'worker' });
    if (!data?.id) throw new JobError({ retryable: false, code: 'integration_missing', summary: 'No TrueFoundry integration is configured for this workspace.', source: 'truefoundry' });
    integrationCache.set(workspaceId, data.id as string);
    return data.id as string;
  }

  async function rowToInsert(row: ModelCallRow): Promise<Record<string, unknown>> {
    const integrationId = row.integrationId ?? (await integrationFor(row.workspaceId));
    return {
      workspace_id: row.workspaceId,
      integration_id: integrationId,
      job_id: row.jobId,
      purpose: row.purpose,
      api_surface: row.apiSurface,
      status: row.status,
      truefoundry_response_id: row.responseId ?? null,
      truefoundry_trace_id: row.traceId ?? null,
      truefoundry_span_id: row.spanId ?? null,
      gateway_base_url_name: row.gatewayBaseUrlName ?? null,
      provider_name: row.providerName ?? null,
      model_name: row.modelName ?? UNKNOWN_MODEL,
      agent_iteration_limit: row.agentIterationLimit ?? null,
      mcp_servers_requested: row.mcpServersRequested ?? [],
      tool_calls_redacted: row.toolCallsRedacted ?? [],
      request_schema_version: row.requestSchemaVersion ?? NO_SCHEMA,
      output_schema_version: row.outputSchemaVersion ?? NO_SCHEMA,
      input_hash: row.inputHash,
      output_redacted: row.outputRedacted ?? null,
      validation_status: row.validationStatus,
      input_tokens: row.inputTokens ?? null,
      output_tokens: row.outputTokens ?? null,
      total_tokens: row.totalTokens ?? null,
      cost_usd: row.costUsd ?? null,
      latency_ms: row.latencyMs ?? null,
      error_code: row.errorCode ?? null,
      error_summary: row.errorSummary ?? null,
      started_at: row.startedAt,
      completed_at: row.completedAt ?? null,
    };
  }

  return {
    async saveModelCall(row: ModelCallRow): Promise<{ id: string; deduped: boolean }> {
      const insert = await rowToInsert(row);
      const { data, error } = await db.from('ai_model_calls').insert([insert]).select('id');
      if (error) {
        // (job_id, purpose) is unique. A prior row exists for this call — usually
        // an earlier failed attempt or a resume. Upsert: a later SUCCESS overwrites
        // the existing row (so a retry's success isn't lost behind a failure); a
        // later FAILURE never clobbers (don't downgrade a recorded success).
        if (isUniqueViolation(error)) {
          const existing = await db
            .from('ai_model_calls')
            .select('id')
            .eq('job_id', row.jobId)
            .eq('purpose', row.purpose)
            .limit(1)
            .maybeSingle();
          const existingId = existing.data?.id as string | undefined;
          if (existingId) {
            if (row.status === 'succeeded') {
              const upd = await db.from('ai_model_calls').update(insert).eq('id', existingId);
              if (upd.error) throw new JobError({ retryable: true, code: 'store_write_failed', summary: 'Could not update the model call.', source: 'worker' });
            }
            return { id: existingId, deduped: true };
          }
        }
        throw new JobError({ retryable: true, code: 'store_write_failed', summary: 'Could not persist the model call.', source: 'worker' });
      }
      const id = (data as { id: string }[] | null)?.[0]?.id;
      if (!id) throw new JobError({ retryable: true, code: 'store_write_failed', summary: 'Model call insert returned no id.', source: 'worker' });
      return { id, deduped: false };
    },

    async saveEvidence(rows: EvidenceRow[]): Promise<void> {
      if (!rows.length) return;
      const payload = rows.map((r) => ({
        workspace_id: r.workspaceId,
        ai_model_call_id: r.aiModelCallId,
        collected_by_job_id: r.collectedByJobId ?? null,
        subject_type: r.subjectType,
        subject_id: r.subjectId ?? null,
        subject_key: r.subjectKey,
        source_type: r.sourceType,
        source_provider: r.sourceProvider,
        claim_type: r.claimType,
        external_id: r.externalId,
        uri: r.uri ?? null,
        title: r.title,
        summary: r.summary,
        payload: r.payload,
        content_hash: r.contentHash,
        verification_state: 'verified',
        observed_at: r.observedAt,
        collected_at: r.collectedAt,
      }));
      const { error } = await db.from('evidence_items').insert(payload);
      // A batch insert is all-or-nothing; if the batch races a unique
      // (collected_by_job_id, subject_key) index, fall back to per-row inserts so
      // the new rows still land and the dup is a no-op.
      if (error) {
        if (!isUniqueViolation(error)) {
          throw new JobError({ retryable: true, code: 'store_write_failed', summary: 'Could not persist evidence.', source: 'worker' });
        }
        for (const one of payload) {
          const res = await db.from('evidence_items').insert([one]);
          if (res.error && !isUniqueViolation(res.error)) {
            throw new JobError({ retryable: true, code: 'store_write_failed', summary: 'Could not persist evidence.', source: 'worker' });
          }
        }
      }
    },
  };
}

/**
 * AgentInvoker over the streaming TrueFoundry AI Gateway for non-tool chat
 * completions (`agent_chat_completions`). The streamed Agent-API tool loop
 * (`agent_responses`, with real MCP tool calls + cited evidence) is wired in the
 * provider workflow tasks (6/7/9/11/12); calling it here throws so a caller
 * can't silently get a tool-less result when it expected a tool loop.
 */
export function createAgentInvoker(): AgentInvoker {
  const gateway = createGateway();
  return {
    async invoke(req: AgentInvokeRequest): Promise<AgentInvokeResult> {
      if (req.apiSurface !== 'agent_chat_completions') {
        throw new JobError({
          retryable: false,
          code: 'agent_surface_unimplemented',
          summary: `The ${req.apiSurface} tool loop is not wired yet (added in the provider workflow tasks).`,
          source: 'truefoundry',
        });
      }
      const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || undefined;
      const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
      const res = await gateway.complete({ purpose: 'model_call', system, user, maxTokens: req.maxTokens });
      return {
        text: res.text,
        model: res.model,
        provider: res.provider,
        responseId: res.responseId,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        totalTokens: res.totalTokens,
        latencyMs: res.latencyMs,
      };
    },
  };
}
