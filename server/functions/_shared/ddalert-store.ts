// Deno-side IO for Datadog draft-alert generation (Task 9): the datadog MCP write
// adapter (verify metric → create draft monitor → recover by marker tag) and the
// PostgREST persistence (approval/recommendation+spec load, recommendation step
// updates, external_write_actions audit). The single provider write goes through
// the gateway-brokered datadog MCP and is recorded as an external_write_actions
// row carrying the approval id + approved_payload_hash (request_hash).
import { isUniqueViolation } from './agent-runtime.ts';
import { createMcpClient, type McpClient } from './mcp-client.ts';
import { JobError } from '../../lib/retry.ts';
import { type DdMonitorSpec, parseMonitorSpec } from '../../lib/datadog-alert.ts';
import type {
  CreatedMonitor,
  DdAlertJobContext,
  DdAlertMcp,
  DdAlertPlan,
  DdAlertStore,
  ExternalWriteInsert,
} from '../../lib/agent-ddalert.ts';

// deno-lint-ignore no-explicit-any
declare const Deno: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

const TELEMETRY = {}; // the datadog MCP tools take a required (but empty-OK) telemetry object

// ---- datadog MCP write adapter -----------------------------------------------

export function createDdAlertMcp(admin: Admin): DdAlertMcp {
  let cached: { client: McpClient; read: Set<string>; write: Set<string>; site: string } | null = null;
  async function io(): Promise<{ client: McpClient; read: Set<string>; write: Set<string>; site: string }> {
    if (cached) return cached;
    const { data, error } = await admin.database.from('integrations').select('config, workspace_id').eq('provider', 'datadog').limit(1).maybeSingle();
    if (error) throw new JobError({ retryable: true, code: 'datadog_integration_read_failed', summary: 'Could not read the Datadog integration config.', source: 'worker' });
    const mcp = data?.config?.mcp;
    const url = Deno.env.get('DATADOG_MCP_URL') ?? mcp?.server_url;
    const bearer = Deno.env.get('TRUEFOUNDRY_API_KEY');
    if (!url || !bearer) throw new JobError({ retryable: false, code: 'datadog_mcp_misconfigured', summary: 'Datadog MCP URL or gateway key is not configured.', source: 'datadog' });
    const site = Deno.env.get('DATADOG_SITE') ?? data?.config?.site ?? 'us5.datadoghq.com';
    cached = { client: createMcpClient(url, bearer, 'datadog', 'datadog'), read: new Set<string>(mcp?.allowed_tools?.read ?? []), write: new Set<string>(mcp?.allowed_tools?.write ?? []), site };
    return cached;
  }
  function assertTool(set: Set<string>, tool: string, source: 'datadog'): void {
    if (set.size > 0 && !set.has(tool)) throw new JobError({ retryable: false, code: 'tool_not_allowlisted', summary: `MCP tool "${tool}" is not allowlisted.`, source });
  }

  return {
    async metricExists(metricName: string): Promise<boolean> {
      const { client, read } = await io();
      assertTool(read, 'search_datadog_metrics', 'datadog');
      const res = await client.call('search_datadog_metrics', { name_filter: metricName, from: 'now-30d', telemetry: TELEMETRY });
      if (res.isError) throw new JobError({ retryable: true, code: 'datadog_metric_search_failed', summary: 'Datadog metric search failed.', source: 'datadog' });
      try {
        const arr = JSON.parse(res.text);
        const list: string[] = Array.isArray(arr) ? arr : Array.isArray(arr?.metrics) ? arr.metrics : [];
        return list.map(String).includes(metricName);
      } catch {
        // Fall back to a substring check on the raw text if it isn't clean JSON.
        return res.text.includes(`"${metricName}"`);
      }
    },

    async createMonitor(payload): Promise<CreatedMonitor> {
      const { client, write, site } = await io();
      assertTool(write, 'create_datadog_monitor', 'datadog');
      const res = await client.call('create_datadog_monitor', {
        name: payload.name,
        type: payload.type,
        query: payload.query,
        message: payload.message,
        tags: payload.tags,
        options: payload.options,
        telemetry: TELEMETRY,
      });
      if (res.isError) throw new JobError({ retryable: true, code: 'datadog_monitor_create_failed', summary: 'Creating the Datadog monitor failed.', source: 'datadog' });
      const m = parseMonitor(res.text, site);
      if (!m) throw new JobError({ retryable: true, code: 'datadog_monitor_unparsed', summary: 'Could not read the created Datadog monitor.', source: 'datadog' });
      return m;
    },

    async findMonitorByTag(markerTag: string): Promise<CreatedMonitor | null> {
      try {
        const { client, read, site } = await io();
        if (read.size > 0 && !read.has('search_datadog_monitors')) return null;
        const res = await client.call('search_datadog_monitors', { query: `tag:"${markerTag}"`, telemetry: TELEMETRY });
        if (res.isError) return null;
        const arr = JSON.parse(res.text);
        const list: any[] = Array.isArray(arr) ? arr : Array.isArray(arr?.monitors) ? arr.monitors : [];
        const hit = list.find((m) => m?.id != null) ?? null;
        if (!hit?.id) return null;
        return { id: Number(hit.id), url: hit.url ?? `https://${site}/monitors/${hit.id}` };
      } catch {
        return null; // best-effort recovery; the succeeded-row check is the primary guard
      }
    },
  };
}

/** Parse a created-monitor response into { id, url }. The datadog MCP nests the
 * monitor under `response.monitor` ({"response":{"monitor":{"id":...}}}); also
 * accept a top-level `monitor`/`id` and, as a last resort, a numeric id scraped
 * from the text. Datadog omits the URL, so build it from the site. */
export function parseMonitor(text: string, site: string): CreatedMonitor | null {
  try {
    const j = JSON.parse(text);
    const mon = j?.response?.monitor ?? j?.monitor ?? j;
    const id = mon?.id ?? j?.monitor_id;
    if (id != null && Number.isFinite(Number(id))) {
      const url = mon?.url ?? `https://${site}/monitors/${Number(id)}`;
      return { id: Number(id), url };
    }
    // Valid JSON but no monitor id (e.g. an error body) — do NOT regex-scrape it,
    // or a stray number like request_id could be mistaken for the monitor id.
    return null;
  } catch {
    /* not JSON — fall through to scrape a bare id from free text */
  }
  const m = /monitors\/(\d+)/.exec(text) ?? /"id"\s*:\s*(\d+)/.exec(text);
  if (m) return { id: Number(m[1]), url: `https://${site}/monitors/${m[1]}` };
  return null;
}

// ---- persistence -------------------------------------------------------------

export function createDdAlertStore(admin: Admin): DdAlertStore {
  const db = admin.database;

  async function updateStep(recommendationId: string, stepKey: string | null, mut: (step: any) => void, now: string): Promise<void> {
    const { data, error } = await db.from('recommendations').select('steps').eq('id', recommendationId).maybeSingle();
    if (error) throw new JobError({ retryable: true, code: 'recommendation_read_failed', summary: 'Could not read the recommendation steps.', source: 'worker' });
    const steps = Array.isArray(data?.steps) ? [...(data!.steps as any[])] : [];
    const effectiveKey = stepKey ?? 'create-monitor';
    let idx = steps.findIndex((s) => s?.key === effectiveKey);
    if (idx < 0) {
      steps.push({ key: effectiveKey, kind: 'datadog_new_monitor', label: 'Create draft monitor', order: steps.length, state: 'available', target_provider: 'datadog' });
      idx = steps.length - 1;
    }
    steps[idx] = { ...steps[idx] };
    mut(steps[idx]);
    const { error: upErr } = await db.from('recommendations').update({ steps, updated_at: now }).eq('id', recommendationId);
    if (upErr) throw new JobError({ retryable: true, code: 'recommendation_write_failed', summary: 'Could not update the recommendation step.', source: 'worker' });
  }

  return {
    async loadPlan(ctx: DdAlertJobContext): Promise<DdAlertPlan | null> {
      const { data: approval, error: aErr } = await db.from('approvals').select('state, approved_payload_hash, action_type, target_type, target_id, target_step_key, workspace_id').eq('id', ctx.approvalId).maybeSingle();
      if (aErr) throw new JobError({ retryable: true, code: 'approval_read_failed', summary: 'Could not read the approval.', source: 'worker' });
      if (!approval) return null;
      // Governance: the approval must authorize THIS monitor creation for THIS
      // recommendation/step in THIS workspace.
      if (
        approval.action_type !== 'create_monitor' ||
        approval.target_type !== 'recommendation' ||
        approval.target_id !== ctx.recommendationId ||
        (approval.target_step_key ?? null) !== ctx.stepKey ||
        approval.workspace_id !== ctx.workspaceId
      ) {
        throw new JobError({ retryable: false, code: 'approval_mismatch', summary: 'The approval does not authorize monitor creation for this recommendation step.', source: 'worker' });
      }
      const { data: rec, error: rErr } = await db.from('recommendations').select('title, steps').eq('id', ctx.recommendationId).maybeSingle();
      if (rErr) throw new JobError({ retryable: true, code: 'recommendation_read_failed', summary: 'Could not read the recommendation.', source: 'worker' });
      if (!rec) return null;
      const steps: any[] = Array.isArray(rec.steps) ? rec.steps : [];
      const step = steps.find((s) => s?.key === (ctx.stepKey ?? 'create-monitor'));
      const spec: DdMonitorSpec | null = step ? parseMonitorSpec(step.proposed_payload) : null;
      if (!spec) throw new JobError({ retryable: false, code: 'ddalert_spec_missing', summary: 'The recommendation step has no valid proposed monitor spec.', source: 'worker' });
      // expected_after_step only when a completed prerequisite step would add the metric.
      const prereqKey = step?.prerequisite_step_key ?? null;
      const prereq = prereqKey ? steps.find((s) => s?.key === prereqKey) : null;
      return {
        approvalState: approval.state as string,
        approvedPayloadHash: (approval.approved_payload_hash as string) ?? '',
        recommendationTitle: (rec.title as string) ?? '',
        prerequisiteStepDone: prereq?.state === 'done',
        spec,
      };
    },

    setStepState: (recommendationId, stepKey, state, now) => updateStep(recommendationId, stepKey, (s) => { s.state = state; }, now),
    setMetricVerification: (recommendationId, stepKey, state, now) => updateStep(recommendationId, stepKey, (s) => { s.metric_verification_state = state; }, now),
    setGeneratedMonitor: (recommendationId, stepKey, monitor, now) => updateStep(recommendationId, stepKey, (s) => { s.generated_monitor = monitor; }, now),

    async findExternalWrite(workspaceId, key) {
      const { data, error } = await db.from('external_write_actions').select('id, state, external_id, external_url').eq('workspace_id', workspaceId).eq('idempotency_key', key).limit(1).maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'external_write_read_failed', summary: 'Could not read the external write audit.', source: 'worker' });
      if (!data) return null;
      return { id: data.id as string, state: data.state as string, externalId: (data.external_id as string | null) ?? null, externalUrl: (data.external_url as string | null) ?? null };
    },
    async insertExternalWrite(input: ExternalWriteInsert): Promise<string> {
      const row = { workspace_id: input.workspaceId, approval_id: input.approvalId, job_id: input.jobId, provider: 'datadog', action_kind: input.actionKind, idempotency_key: input.idempotencyKey, target_summary: input.targetSummary, request_hash: input.requestHash, request_redacted: input.requestRedacted, response_summary: {}, state: 'planned', started_at: input.now };
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
