// Deno-side IO for Datadog alert-coverage generation (Task 9, slice 2): the
// datadog MCP READ adapter (metrics + monitors — no writes here; this flow never
// mutates Datadog) and the PostgREST persistence for the coverage snapshot,
// findings read-back, and the category-`alert` recommendation upsert (deduped by
// dedupe_fingerprint via recommendations_dedupe_uniq).
import { isUniqueViolation } from './agent-runtime.ts';
import { createMcpClient, type McpClient } from './mcp-client.ts';
import { JobError } from '../../lib/retry.ts';
import { alertFindingsSchema } from '../../lib/alert-coverage.ts';
import type { MonitorSnapshot } from '../../lib/alert-coverage.ts';
import { scrubSecrets } from '../../lib/redaction.ts';
import type {
  CoverageSnapshot,
  LoadedFindings,
  RecGenMcp,
  RecGenStore,
  SaveCoverageInput,
  SaveFindingsInput,
  UpsertAlertInput,
} from '../../lib/agent-recgen.ts';
import type { AlertFinding } from '../../lib/alert-coverage.ts';

// deno-lint-ignore no-explicit-any
declare const Deno: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

const TELEMETRY = {}; // the datadog MCP tools take a required (but empty-OK) telemetry object
const MAX_MONITORS = 50;
const coverageKey = (jobId: string) => `recgen_coverage:${jobId}`;
const findingsKey = (jobId: string) => `recgen_findings:${jobId}`;
const scanFindingsKey = (jobId: string) => `scan_findings:${jobId}`;

// ---- datadog MCP read adapter ------------------------------------------------

export function createRecGenMcp(admin: Admin): RecGenMcp {
  let cached: { client: McpClient; read: Set<string> } | null = null;
  async function io(): Promise<{ client: McpClient; read: Set<string> }> {
    if (cached) return cached;
    const { data, error } = await admin.database.from('integrations').select('config').eq('provider', 'datadog').limit(1).maybeSingle();
    if (error) throw new JobError({ retryable: true, code: 'datadog_integration_read_failed', summary: 'Could not read the Datadog integration config.', source: 'worker' });
    const mcp = data?.config?.mcp;
    const url = Deno.env.get('DATADOG_MCP_URL') ?? mcp?.server_url;
    const bearer = Deno.env.get('TRUEFOUNDRY_API_KEY');
    if (!url || !bearer) throw new JobError({ retryable: false, code: 'datadog_mcp_misconfigured', summary: 'Datadog MCP URL or gateway key is not configured.', source: 'datadog' });
    cached = { client: createMcpClient(url, bearer, 'datadog', 'datadog'), read: new Set<string>(mcp?.allowed_tools?.read ?? []) };
    return cached;
  }
  function assertTool(set: Set<string>, tool: string): void {
    if (set.size > 0 && !set.has(tool)) throw new JobError({ retryable: false, code: 'tool_not_allowlisted', summary: `MCP read tool "${tool}" is not allowlisted.`, source: 'datadog' });
  }

  return {
    async listMetrics(namespace: string): Promise<string[]> {
      const { client, read } = await io();
      assertTool(read, 'search_datadog_metrics');
      const res = await client.call('search_datadog_metrics', { name_filter: namespace, from: 'now-30d', telemetry: TELEMETRY });
      if (res.isError) throw new JobError({ retryable: true, code: 'datadog_metric_search_failed', summary: 'Datadog metric search failed.', source: 'datadog' });
      return parseMetricNames(res.text);
    },
    async listMonitors(namespace: string): Promise<MonitorSnapshot[]> {
      const { client, read } = await io();
      assertTool(read, 'search_datadog_monitors');
      const res = await client.call('search_datadog_monitors', { query: namespace, telemetry: TELEMETRY });
      if (res.isError) throw new JobError({ retryable: true, code: 'datadog_monitor_search_failed', summary: 'Datadog monitor search failed.', source: 'datadog' });
      return parseMonitors(res.text);
    },
  };
}

/** Parse a search_datadog_metrics response into a bounded list of metric names. */
export function parseMetricNames(text: string): string[] {
  try {
    const j = JSON.parse(text);
    const arr: unknown[] = Array.isArray(j) ? j : Array.isArray(j?.metrics) ? j.metrics : [];
    return arr.map((s) => scrubSecrets(String(s)).slice(0, 200)).filter((s) => s.length > 0).slice(0, 200);
  } catch {
    return [];
  }
}

/** Parse a search_datadog_monitors response into bounded monitor snapshots (id+name+query). */
export function parseMonitors(text: string): MonitorSnapshot[] {
  try {
    const j = JSON.parse(text);
    const arr: any[] = Array.isArray(j) ? j : Array.isArray(j?.monitors) ? j.monitors : [];
    return arr
      .filter((m) => m && m.id != null && typeof m.name === 'string')
      .map((m) => ({
        id: Number(m.id),
        name: scrubSecrets(String(m.name)),
        query: typeof m.query === 'string' ? scrubSecrets(m.query) : null,
        type: typeof m.type === 'string' ? m.type : null,
        message: typeof m.message === 'string' ? scrubSecrets(m.message).slice(0, 400) : null
      }))
      .slice(0, MAX_MONITORS);
  } catch {
    return [];
  }
}

// ---- persistence -------------------------------------------------------------

export function createRecGenStore(admin: Admin): RecGenStore {
  const db = admin.database;

  async function evidence(jobId: string, key: string): Promise<any | null> {
    const { data, error } = await db.from('evidence_items').select('payload').eq('collected_by_job_id', jobId).eq('subject_key', key).limit(1).maybeSingle();
    if (error) throw new JobError({ retryable: true, code: 'evidence_read_failed', summary: 'Could not read coverage evidence.', source: 'worker' });
    return data?.payload ?? null;
  }

  return {
    async hasCoverage(jobId) {
      return (await evidence(jobId, coverageKey(jobId))) !== null;
    },

    async saveCoverage(input: SaveCoverageInput) {
      const { snapshot } = input;
      const { error } = await db.from('evidence_items').insert([
        {
          workspace_id: input.workspaceId,
          source_type: 'datadog_monitor',
          source_provider: 'datadog',
          collected_by_job_id: input.jobId,
          subject_type: 'repository',
          subject_id: input.repositoryId,
          subject_key: coverageKey(input.jobId),
          claim_type: 'fact',
          external_id: `recgen:coverage:${input.jobId}`,
          title: `Datadog alert coverage for ${input.namespace}`,
          summary: `${snapshot.metrics.length} metric(s), ${snapshot.monitors.length} monitor(s); ${snapshot.uncovered.length} uncovered`,
          payload: snapshot,
          content_hash: `${input.jobId}:recgen-coverage`,
          verification_state: 'verified',
          observed_at: input.now,
          collected_at: input.now,
        },
      ]);
      if (error && !isUniqueViolation(error)) throw new JobError({ retryable: true, code: 'evidence_write_failed', summary: 'Could not persist the coverage snapshot.', source: 'worker' });
    },

    async loadCoverage(jobId): Promise<CoverageSnapshot | null> {
      const p = await evidence(jobId, coverageKey(jobId));
      if (!p) return null;
      return {
        metrics: Array.isArray(p.metrics) ? p.metrics.map(String) : [],
        monitors: Array.isArray(p.monitors) ? (p.monitors as MonitorSnapshot[]) : [],
        uncovered: Array.isArray(p.uncovered) ? p.uncovered.map(String) : [],
        covered: Array.isArray(p.covered) ? p.covered.map(String) : [],
        instrumentationGaps: Array.isArray(p.instrumentationGaps) ? p.instrumentationGaps.map(String) : [],
      };
    },

    async saveFindings(input: SaveFindingsInput) {
      const exists = await evidence(input.jobId, findingsKey(input.jobId));
      if (exists !== null) return;
      const scrubbed = input.findings.map((f) => ({
        ...f,
        title: f.title ? scrubSecrets(f.title) : undefined,
        rationale: f.rationale ? scrubSecrets(f.rationale) : undefined,
        metric_name: f.metric_name ? scrubSecrets(f.metric_name) : null,
        query: f.query ? scrubSecrets(f.query) : null,
        message: f.message ? scrubSecrets(f.message) : null,
        suggested_tags: f.suggested_tags ? f.suggested_tags.map((t) => scrubSecrets(t)) : null,
        monitor_name: f.monitor_name ? scrubSecrets(f.monitor_name) : null,
        service: f.service ? scrubSecrets(f.service) : null,
        diff_rows: f.diff_rows
          ? f.diff_rows.map((r) => ({
              k: scrubSecrets(r.k),
              v: r.v != null ? scrubSecrets(r.v) : null,
              from: r.from != null ? scrubSecrets(r.from) : null,
              to: r.to != null ? scrubSecrets(r.to) : null,
            }))
          : null,
      }));
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
          external_id: input.modelCallId || `alert-findings:${input.jobId}`,
          title: 'Alert coverage findings',
          summary: `${input.findings.length} finding(s); ${input.validationStatus}`,
          payload: { findings: scrubbed, validation_status: input.validationStatus, model_call_id: input.modelCallId || null },
          content_hash: `${input.jobId}:alert-findings`,
          verification_state: 'verified',
          observed_at: input.now,
          collected_at: input.now,
        },
      ]);
      if (error && !isUniqueViolation(error)) throw new JobError({ retryable: true, code: 'findings_write_failed', summary: 'Could not persist alert findings.', source: 'worker' });
    },

    async loadFindings(jobId): Promise<LoadedFindings | null> {
      const p = await evidence(jobId, findingsKey(jobId));
      if (!p) return null;
      const validationStatus = p.validation_status ?? 'not_applicable';
      let findings: AlertFinding[] = [];
      if (validationStatus === 'valid') {
        try {
          findings = alertFindingsSchema.parse({ findings: p.findings ?? [] }).findings;
        } catch {
          findings = [];
        }
      }
      return { modelCallId: p.model_call_id ?? '', validationStatus, findings };
    },

    async loadScanGaps(scanJobId): Promise<string[]> {
      if (!scanJobId) return [];
      const p = await evidence(scanJobId, scanFindingsKey(scanJobId));
      if (!p || !Array.isArray(p.findings)) return [];
      return (p.findings as { title?: string }[]).map((f) => f?.title).filter((t): t is string => typeof t === 'string').slice(0, 20);
    },

    async upsertAlertRecommendation(input: UpsertAlertInput): Promise<{ id: string; created: boolean }> {
      const confidence = input.severity === 'high' ? 'high' : input.severity === 'low' ? 'low' : 'likely';
      const insertFields = {
        repository_id: input.repositoryId,
        category: 'alert',
        state: 'active',
        title: input.title,
        rationale: input.rationale,
        service_name: input.serviceName,
        proposed_next_step: input.proposedNextStep,
        confidence,
        dedupe_fingerprint: input.dedupeFingerprint,
        validated_schema_version: 'recommendation.v1',
        steps: [input.step],
        last_seen_job_id: input.jobId,
        created_by_model_call_id: input.modelCallId || null,
        updated_at: input.now,
      };
      const { data: existing, error: selErr } = await db.from('recommendations').select('id, steps').eq('workspace_id', input.workspaceId).eq('dedupe_fingerprint', input.dedupeFingerprint).limit(1).maybeSingle();
      if (selErr) throw new JobError({ retryable: true, code: 'recommendation_read_failed', summary: 'Could not read the recommendation.', source: 'worker' });
      if (existing?.id) {
        // Refresh metadata always; refresh the step array only when it has NOT been
        // acted on — so a `locked` (expected_after_step) step flips to `available`
        // once its metric exists, but an approved / generated / human-completed step
        // is preserved (never clobber an in-flight approval, a created monitor, or a
        // reviewed read-only diff a human already worked).
        const updateFields: Record<string, any> = { last_seen_job_id: input.jobId, updated_at: input.now, title: input.title, rationale: input.rationale, proposed_next_step: input.proposedNextStep };
        let frozen = Array.isArray(existing.steps) && existing.steps.some((s: any) => s && (s.approval_id || s.generated_monitor || s.generated_monitor_id || s.generated_pr || s.job_id || s.completion_source || (s.state && !['available', 'locked'].includes(s.state))));
        // Also freeze if an approval already exists in the approvals table for this
        // recommendation — the step JSON may not carry approval_id yet, but replacing
        // its steps would orphan an in-flight approval/draft-monitor job.
        if (!frozen) {
          const { data: appr } = await db.from('approvals').select('id').eq('workspace_id', input.workspaceId).eq('target_type', 'recommendation').eq('target_id', existing.id).in('state', ['requested', 'approved', 'executed']).limit(1).maybeSingle();
          if (appr?.id) frozen = true;
        }
        if (!frozen) {
          updateFields.steps = [input.step];
        }
        const { error } = await db.from('recommendations').update(updateFields).eq('id', existing.id);
        if (error) throw new JobError({ retryable: true, code: 'recommendation_write_failed', summary: 'Could not update the recommendation.', source: 'worker' });
        return { id: existing.id as string, created: false };
      }
      const { data, error } = await db.from('recommendations').insert([{ workspace_id: input.workspaceId, created_by_job_id: input.jobId, created_at: input.now, ...insertFields }]).select('id');
      if (error) {
        if (isUniqueViolation(error)) {
          const { data: row } = await db.from('recommendations').select('id').eq('workspace_id', input.workspaceId).eq('dedupe_fingerprint', input.dedupeFingerprint).limit(1).maybeSingle();
          if (row?.id) return { id: row.id as string, created: false };
        }
        throw new JobError({ retryable: true, code: 'recommendation_write_failed', summary: 'Could not create the recommendation.', source: 'worker' });
      }
      return { id: (data as { id: string }[])[0].id, created: true };
    },
  };
}
