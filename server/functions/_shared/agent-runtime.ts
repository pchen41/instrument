// Deno-side concrete implementations of the agent layer (Task 5B viability run):
// a streaming TrueFoundry AI Gateway client, a scripted MCP tool host, and an
// idempotent PostgREST persistence store. Bundled into job-worker-tick. The pure
// orchestration lives in server/lib/agent.ts; this file is the IO edge.
//
// Hardening (post-review): the gateway aborts before the lease can expire, the
// store fails safe on read/write errors and relies on DB unique constraints for
// atomic idempotency, the integration is resolved per workspace, and no provider
// response body is ever copied into a job-visible error.
import type {
  AgentGateway,
  EvidenceRecord,
  ModelCallRecord,
  ToolHost,
  ToolRequest,
  ToolResult,
  TurnRequest,
  TurnResult,
  WorkStore,
} from '../../lib/agent.ts';
import { JobError } from '../../lib/retry.ts';
import { sleep } from '../../lib/time.ts';

// deno-lint-ignore no-explicit-any
declare const Deno: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

const GATEWAY_BASE = () => Deno.env.get('TRUEFOUNDRY_BASE_URL') ?? 'https://gateway.truefoundry.ai';
const GATEWAY_MODEL = () => Deno.env.get('TRUEFOUNDRY_MODEL') ?? 'instrument/instrument';
// Must stay comfortably under the worker lease (LEASE_SECONDS = 60s): a turn that
// outlived the lease could be reclaimed and re-run by another tick, so we abort
// first and surface a retryable error instead.
const GATEWAY_TIMEOUT_MS = 45_000;

/** Streaming TrueFoundry AI Gateway client (OpenAI-compatible /chat/completions). */
export function createGateway(): AgentGateway {
  return {
    async complete(req: TurnRequest): Promise<TurnResult> {
      const key = Deno.env.get('TRUEFOUNDRY_API_KEY');
      if (!key) throw new JobError({ retryable: false, code: 'gateway_misconfigured', summary: 'TrueFoundry key unset.', source: 'truefoundry' });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
      const t0 = Date.now();
      try {
        let resp: Response;
        try {
          resp = await fetch(`${GATEWAY_BASE()}/api/inference/openai/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              model: GATEWAY_MODEL(),
              stream: true,
              stream_options: { include_usage: true },
              max_tokens: req.maxTokens ?? 256,
              messages: [
                ...(req.system ? [{ role: 'system', content: req.system }] : []),
                { role: 'user', content: req.user },
              ],
            }),
          });
        } catch (err) {
          const aborted = controller.signal.aborted;
          throw new JobError({
            retryable: true,
            code: aborted ? 'gateway_timeout' : 'gateway_unreachable',
            summary: aborted ? `Gateway call exceeded ${GATEWAY_TIMEOUT_MS / 1000}s.` : 'Gateway connection failed.',
            source: 'truefoundry',
          });
        }

        if (!resp.ok || !resp.body) {
          // Drain + discard the body: never copy a provider response into a
          // job-visible error (it can carry account/PII detail). Status only.
          try {
            await resp.text();
          } catch {
            /* ignore */
          }
          throw new JobError({
            retryable: resp.status === 429 || resp.status >= 500,
            code: `gateway_http_${resp.status}`,
            summary: `Gateway returned HTTP ${resp.status}.`,
            source: 'truefoundry',
          });
        }

        // Consume the SSE stream. Accumulate deltas; completion is signalled by a
        // non-null finish_reason and/or a usage block (TrueFoundry does NOT emit a
        // [DONE] sentinel). A clean EOF without either marker means the stream was
        // truncated → retryable, so we never store a partial answer as complete.
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let text = '';
        let model = GATEWAY_MODEL();
        let provider = 'truefoundry';
        let responseId: string | undefined;
        let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
        let sawFinish = false;

        const handle = (data: string): void => {
          if (data === '[DONE]') {
            sawFinish = true;
            return;
          }
          try {
            const json = JSON.parse(data);
            if (json.id) responseId = json.id;
            if (json.model) model = json.model;
            if (json.provider) provider = json.provider;
            const choice = json.choices?.[0];
            const delta = choice?.delta?.content;
            if (typeof delta === 'string') text += delta;
            if (choice?.finish_reason) sawFinish = true; // 'stop' | 'length' | …
            if (json.usage) usage = json.usage;
          } catch {
            // tolerate keep-alive / non-JSON frames
          }
        };
        const drain = (): void => {
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line.startsWith('data:')) handle(line.slice(5).trim());
          }
        };

        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            drain();
          }
          buf += '\n'; // flush a final unterminated line
          drain();
        } catch (err) {
          const aborted = controller.signal.aborted;
          throw new JobError({
            retryable: true,
            code: aborted ? 'gateway_timeout' : 'gateway_stream_error',
            summary: aborted ? `Gateway stream exceeded ${GATEWAY_TIMEOUT_MS / 1000}s.` : 'The gateway stream was interrupted.',
            source: 'truefoundry',
          });
        }

        if (!sawFinish && !usage) {
          throw new JobError({ retryable: true, code: 'gateway_incomplete_stream', summary: 'The gateway stream ended before completing.', source: 'truefoundry' });
        }

        return {
          text,
          model,
          provider,
          responseId,
          inputTokens: usage?.prompt_tokens,
          outputTokens: usage?.completion_tokens,
          totalTokens: usage?.total_tokens,
          latencyMs: Date.now() - t0,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Scripted MCP tool host (the hybrid: real LLM, deterministic tools). Mirrors the
 * shape and latency of a governed github/datadog MCP call without depending on
 * 5C's MCP server being live — same partial-output/persistence shape.
 */
export function createScriptedToolHost(): ToolHost {
  return {
    async call(req: ToolRequest): Promise<ToolResult> {
      const t0 = Date.now();
      await sleep(300 + Math.floor(Math.random() * 500)); // approximate tool round-trip
      const externalId = `${req.server}:${req.tool}:${Math.random().toString(36).slice(2, 8)}`;
      if (req.server === 'github') {
        return {
          externalId,
          title: 'Recent deploy detected',
          summary: `Merged PR bumped a connection-pool default in ${String(req.args.repo ?? 'repo')} ~40m before the alert.`,
          payload: { tool: req.tool, args: req.args, commits: [{ sha: 'a1b2c3d', message: 'chore: raise pool size', files: ['db/pool.ts'] }] },
          latencyMs: Date.now() - t0,
        };
      }
      return {
        externalId,
        title: 'p95 latency breach',
        summary: `p95 for ${String(req.args.metric ?? 'metric')} rose from 180ms to 920ms over the window.`,
        payload: { tool: req.tool, args: req.args, series: [180, 190, 210, 640, 920], unit: 'ms' },
        latencyMs: Date.now() - t0,
      };
    },
  };
}

/**
 * Idempotent PostgREST-backed persistence for model calls + evidence. Reads fail
 * SAFE (a query error throws retryable rather than reporting "absent", which would
 * re-run work); writes check the PostgREST error and treat a unique-constraint
 * violation as an idempotent no-op (the DB unique indexes are the atomic backstop
 * for the check-then-insert guard). Integration is resolved per workspace.
 */
export function createWorkStore(admin: Admin): WorkStore {
  const db = admin.database;
  const integrationCache = new Map<string, string>();

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

  return {
    async hasModelCall(jobId, purpose) {
      const { data, error } = await db.from('ai_model_calls').select('id').eq('job_id', jobId).eq('purpose', purpose).limit(1).maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'store_read_failed', summary: 'Could not read prior model calls.', source: 'worker' });
      return !!data;
    },
    async recordModelCall(rec: ModelCallRecord) {
      const integrationId = await integrationFor(rec.workspaceId);
      const { error } = await db.from('ai_model_calls').insert([
        {
          workspace_id: rec.workspaceId,
          integration_id: integrationId,
          job_id: rec.jobId,
          purpose: rec.purpose,
          api_surface: 'agent_chat_completions',
          truefoundry_response_id: rec.responseId ?? null,
          gateway_base_url_name: 'truefoundry',
          provider_name: rec.providerName,
          model_name: rec.modelName,
          tool_calls_redacted: rec.toolCallsRedacted ?? [],
          request_schema_version: 'v1',
          output_schema_version: 'v1',
          input_hash: rec.inputHash,
          output_redacted: rec.outputRedacted,
          validation_status: 'not_applicable',
          input_tokens: rec.inputTokens ?? null,
          output_tokens: rec.outputTokens ?? null,
          total_tokens: rec.totalTokens ?? null,
          latency_ms: rec.latencyMs,
          status: 'succeeded',
          started_at: rec.startedAt,
          completed_at: rec.completedAt,
        },
      ]);
      if (error && !isUniqueViolation(error)) {
        throw new JobError({ retryable: true, code: 'store_write_failed', summary: 'Could not persist the model call.', source: 'worker' });
      }
    },
    async hasEvidence(jobId, subjectKey) {
      const { data, error } = await db.from('evidence_items').select('id').eq('collected_by_job_id', jobId).eq('subject_key', subjectKey).limit(1).maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'store_read_failed', summary: 'Could not read prior evidence.', source: 'worker' });
      return !!data;
    },
    async recordEvidence(rec: EvidenceRecord) {
      const { error } = await db.from('evidence_items').insert([
        {
          workspace_id: rec.workspaceId,
          source_type: rec.sourceType,
          source_provider: rec.sourceProvider,
          collected_by_job_id: rec.jobId,
          subject_type: 'incident',
          subject_id: rec.subjectId,
          subject_key: rec.subjectKey,
          claim_type: rec.claimType,
          external_id: rec.externalId,
          title: rec.title,
          summary: rec.summary,
          payload: rec.payload,
          content_hash: rec.contentHash,
          verification_state: 'verified',
          observed_at: rec.observedAt,
          collected_at: rec.observedAt,
        },
      ]);
      if (error && !isUniqueViolation(error)) {
        throw new JobError({ retryable: true, code: 'store_write_failed', summary: 'Could not persist evidence.', source: 'worker' });
      }
    },
  };
}

/** A Postgres unique-constraint violation surfaced through PostgREST. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isUniqueViolation(error: any): boolean {
  return error?.code === '23505' || /duplicate key|unique constraint|already exists/i.test(String(error?.message ?? ''));
}
