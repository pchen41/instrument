// Deno-side IO for the Task 11 incident investigation: the READ-ONLY MCP adapter
// (the federated `instrument-investigation` gateway server — github + datadog read
// tools, ZERO write tools, so the investigation cannot mutate anything) and the
// PostgREST persistence (incident read, verified evidence writes, the validated
// hypotheses write-back). The pure orchestration + schema live in
// server/lib/agent-investigate.ts.
//
// Tool names on the federated server are suffixed (`_githuvn` for github,
// `_datade8` for datadog); we only ever call tools in its read allowlist.
import { isUniqueViolation } from './agent-runtime.ts';
import { createMcpClient, type McpClient } from './mcp-client.ts';
import { JobError } from '../../lib/retry.ts';
import { scrubSecrets } from '../../lib/redaction.ts';
import {
  type CommitFact,
  type EvidenceFact,
  type IncidentContext,
  type IncidentSignal,
  type InvestigateMcp,
  type InvestigateStore,
  type InvestigationOutput,
  type RepoRef,
  type SignalFact,
  type TfFact,
  type TfWindow,
  investigationOutputSchema,
} from '../../lib/agent-investigate.ts';

// deno-lint-ignore no-explicit-any
declare const Deno: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

const TELEMETRY = {}; // datadog MCP tools require a (empty-OK) telemetry object
const MAX_COMMITS = 8;
const MAX_FACTS = 20;
const FACT_SOURCE_TYPES = ['commit', 'pr_diff', 'datadog_trace', 'datadog_log', 'datadog_metric', 'datadog_alert_event', 'truefoundry_metric', 'truefoundry_log'];

const commitKey = (sha: string) => `inv:commit:${sha.slice(0, 40)}`;
const traceKey = (incidentId: string) => `inv:trace:${incidentId}`;
const logKey = (incidentId: string) => `inv:log:${incidentId}`;
const tfKey = (incidentId: string) => `inv:tf_unavailable:${incidentId}`;
const tfModelKey = (incidentId: string) => `inv:tf_model:${incidentId}`;
const tfMcpKey = (incidentId: string) => `inv:tf_mcp:${incidentId}`;
const tfLogKey = (incidentId: string) => `inv:tf_log:${incidentId}`;
const hypothesesKey = (jobId: string) => `inv:hypotheses:${jobId}`;

// ---- read-only MCP adapter ---------------------------------------------------

export function createInvestigateMcp(admin: Admin): InvestigateMcp {
  let cached: { client: McpClient; read: Set<string> } | null = null;

  async function io(): Promise<{ client: McpClient; read: Set<string> }> {
    if (cached) return cached;
    const { data, error } = await admin.database.from('integrations').select('config').eq('provider', 'truefoundry').limit(1).maybeSingle();
    if (error) throw new JobError({ retryable: true, code: 'truefoundry_integration_read_failed', summary: 'Could not read the TrueFoundry integration config.', source: 'worker' });
    // The investigation server is the read-only federated MCP registered under the
    // truefoundry integration's mcp_servers. Pick it by URL (zero write tools).
    const servers: any[] = Array.isArray(data?.config?.mcp_servers) ? data.config.mcp_servers : Object.values(data?.config?.mcp_servers ?? {});
    const inv = servers.find((s) => typeof s?.server_url === 'string' && s.server_url.includes('/instrument-investigation/'));
    const url = Deno.env.get('INVESTIGATION_MCP_URL') ?? inv?.server_url;
    const bearer = Deno.env.get('TRUEFOUNDRY_API_KEY');
    if (!url || !bearer) throw new JobError({ retryable: false, code: 'investigation_mcp_misconfigured', summary: 'The investigation MCP URL or gateway key is not configured.', source: 'truefoundry' });
    const read = new Set<string>(inv?.allowed_tools?.read ?? []);
    const write = new Set<string>(inv?.allowed_tools?.write ?? []);
    // Read-only guarantee: this federated server must advertise a non-empty read
    // allowlist and NO write tools. Fail CLOSED on a missing/odd registration
    // rather than fall open to an unconstrained tool surface.
    if (read.size === 0 || write.size > 0) throw new JobError({ retryable: false, code: 'investigation_mcp_not_readonly', summary: 'The investigation MCP is not registered as a non-empty read-only server.', source: 'truefoundry' });
    cached = { client: createMcpClient(url, bearer, 'investigation', 'truefoundry'), read };
    return cached;
  }

  function assertTool(read: Set<string>, tool: string): void {
    // read is guaranteed non-empty (io()); every call must be explicitly allowlisted.
    if (!read.has(tool)) throw new JobError({ retryable: false, code: 'tool_not_allowlisted', summary: `MCP read tool "${tool}" is not allowlisted on the investigation server.`, source: 'truefoundry' });
  }

  return {
    async recentCommits(repo: RepoRef): Promise<CommitFact[]> {
      const { client, read } = await io();
      assertTool(read, 'list_commits_githuvn');
      const res = await client.call('list_commits_githuvn', { owner: repo.owner, repo: repo.name, sha: repo.defaultBranch, perPage: MAX_COMMITS });
      if (res.isError) return [];
      return parseCommits(res.text);
    },
    async getTrace(traceId: string): Promise<SignalFact | null> {
      const { client, read } = await io();
      assertTool(read, 'get_datadog_trace_datade8');
      const res = await client.call('get_datadog_trace_datade8', { trace_id: traceId, telemetry: TELEMETRY });
      if (res.isError || !res.text) return null;
      return {
        externalId: `dd_trace:${traceId}`.slice(0, 200),
        title: `Datadog trace ${traceId}`.slice(0, 200),
        summary: clamp(`Trace spans for ${traceId}: ${scrubSecrets(res.text)}`, 300),
        uri: null,
        payload: { trace_id: traceId, snapshot: clamp(scrubSecrets(res.text), 4000) },
        observedAt: null,
      };
    },
    async searchServiceLogs(service: string, traceId: string | null): Promise<SignalFact | null> {
      const { client, read } = await io();
      assertTool(read, 'search_datadog_logs_datade8');
      const query = traceId ? `service:${service} (status:error OR @trace_id:${traceId})` : `service:${service} status:error`;
      const res = await client.call('search_datadog_logs_datade8', { query, from: 'now-1h', to: 'now', telemetry: TELEMETRY });
      if (res.isError || !res.text) return null;
      const parsed = parseLogs(res.text);
      if (!parsed) return null;
      return {
        externalId: `dd_logs:${service}`.slice(0, 200),
        title: `Datadog error logs for ${service}`.slice(0, 200),
        summary: clamp(parsed.summary, 300),
        uri: null,
        payload: { service, query: scrubSecrets(query), sample: parsed.sample },
        observedAt: null,
      };
    },
    async truefoundryTelemetry(window: TfWindow): Promise<TfFact[]> {
      const { client, read } = await io();
      const facts: TfFact[] = [];
      // The TrueFoundry observability tools are federated into the SAME read-only
      // server (suffixed `_truefsd`). When they aren't present we simply gather
      // nothing → the caller records the source as unavailable. Each call is
      // best-effort: an individual tool error degrades that source, not the job.
      if (read.has('query_truefoundry_model_metrics_truefsd')) {
        const f = await tfModelMetrics(client, window);
        if (f) facts.push(f);
      }
      if (read.has('query_truefoundry_mcp_metrics_truefsd')) {
        const f = await tfMcpMetrics(client, window);
        if (f) facts.push(f);
      }
      // Request logs: the server injects its own routing destination, so we pass no
      // filters (a dataRoutingDestination filter key is rejected as a span column).
      // Best-effort — treat any error as simply "no data".
      if (read.has('search_truefoundry_request_logs_truefsd')) {
        const f = await tfRequestLogs(client, window);
        if (f) facts.push(f);
      }
      return facts;
    },
  };
}

// ---- TrueFoundry telemetry tool calls + parsers ------------------------------
// All three are best-effort: a non-2xx tool result or unparseable body yields null
// (degrade-not-fail). The metrics datasources are org-wide AI-gateway reliability
// signals, surfaced as `truefoundry_metric` evidence the model may cite.

async function tfModelMetrics(client: McpClient, window: TfWindow): Promise<TfFact | null> {
  try {
    const res = await client.call('query_truefoundry_model_metrics_truefsd', {
      start_time: window.start,
      end_time: window.end,
      query_type: 'distribution',
      // camelCase columns per the TrueFoundry model-metrics API (snake_case 400s).
      aggregations: [
        { type: 'count', column: 'modelName' },
        { type: 'p99', column: 'latencyMs' },
        { type: 'sum', column: 'costInUSD' },
      ],
      group_by: ['modelName'],
      limit: 20,
    });
    if (res.isError || !res.text) return null;
    return parseModelMetrics(res.text);
  } catch {
    return null;
  }
}

async function tfMcpMetrics(client: McpClient, window: TfWindow): Promise<TfFact | null> {
  try {
    const res = await client.call('query_truefoundry_mcp_metrics_truefsd', { start_time: window.start, end_time: window.end, limit: 5 });
    if (res.isError || !res.text) return null;
    return parseMcpMetrics(res.text);
  } catch {
    return null;
  }
}

async function tfRequestLogs(client: McpClient, window: TfWindow): Promise<TfFact | null> {
  try {
    const res = await client.call('search_truefoundry_request_logs_truefsd', { start_time: window.start, end_time: window.end, limit: 5 });
    if (res.isError || !res.text) return null;
    return parseRequestLogs(res.text);
  } catch {
    return null;
  }
}

function toNum(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}
function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
/** Metric dataPoints land at result.data.dataPoints (live-verified); tolerate a
 *  flattened result.data array too so a shape drift degrades, never mis-parses. */
function dataPoints(j: any): any[] {
  const d = j?.result?.data;
  if (Array.isArray(d?.dataPoints)) return d.dataPoints;
  if (Array.isArray(d)) return d;
  return [];
}

function parseModelMetrics(text: string): TfFact | null {
  try {
    const j = JSON.parse(text);
    const pts = dataPoints(j);
    if (pts.length === 0) return null;
    const ranked = pts
      .filter((p) => p && (p.modelName || p.countModelName != null || p.total != null))
      .sort((a, b) => (toNum(b.countModelName ?? b.total) ?? 0) - (toNum(a.countModelName ?? a.total) ?? 0));
    if (ranked.length === 0) return null;
    const total = ranked.reduce((s, p) => s + (toNum(p.countModelName ?? p.total) ?? 0), 0);
    // Symmetric with parseMcpMetrics: an all-zero/unparseable count degrades to
    // null (→ recorded unavailable) rather than a misleading verified "0 calls" fact.
    if (!total) return null;
    const top = ranked.slice(0, 5).map((p) => {
      const name = scrubSecrets(String(p.modelName ?? 'model')).slice(0, 80);
      const calls = toNum(p.countModelName ?? p.total) ?? 0;
      const p99 = toNum(p.p99LatencyMs);
      const cost = toNum(p.sumCostInUSD);
      return `${name} ${calls} call(s)${p99 != null ? `, p99 ${fmtMs(p99)}` : ''}${cost != null ? `, $${cost.toFixed(4)}` : ''}`;
    });
    return {
      kind: 'model_metric',
      externalId: 'tf_model_metrics',
      title: 'TrueFoundry AI Gateway — model metrics (6h)',
      summary: `${total} model call(s) across ${ranked.length} model(s); ${top.join('; ')}`,
      payload: {
        window_hours: 6,
        total_calls: total,
        models: ranked.slice(0, 10).map((p) => ({ model: scrubSecrets(String(p.modelName ?? '')).slice(0, 80), calls: toNum(p.countModelName ?? p.total), p99_latency_ms: toNum(p.p99LatencyMs), cost_usd: toNum(p.sumCostInUSD) })),
      },
      observedAt: null,
    };
  } catch {
    return null;
  }
}

function parseMcpMetrics(text: string): TfFact | null {
  try {
    const j = JSON.parse(text);
    const pts = dataPoints(j);
    const total = pts.reduce((s, p) => s + (toNum(p?.countMethod ?? p?.total) ?? 0), 0);
    if (!total) return null;
    // Unfiltered MCP metrics include non-tool methods (initialize, tools/list), so
    // this is "request(s)", not "tool call(s)".
    return {
      kind: 'mcp_metric',
      externalId: 'tf_mcp_metrics',
      title: 'TrueFoundry AI Gateway — MCP metrics (6h)',
      summary: `${total} MCP gateway request(s) in the last 6h.`,
      payload: { window_hours: 6, total_requests: total },
      observedAt: null,
    };
  } catch {
    return null;
  }
}

function parseRequestLogs(text: string): TfFact | null {
  try {
    const j = JSON.parse(text);
    // Live spans land at result.data (array); tolerate a few other shapes.
    const rows: any[] = Array.isArray(j?.result?.data)
      ? j.result.data
      : Array.isArray(j?.result?.data?.spans)
        ? j.result.data.spans
        : Array.isArray(j?.result?.spans)
          ? j.result.spans
          : Array.isArray(j?.spans)
            ? j.spans
            : [];
    if (rows.length === 0) return null;
    // Sample only the non-sensitive span shell (name/service/status) — never the
    // span attributes, which can carry prompt/response text.
    const errors = rows.filter((r) => r && r.statusCode && String(r.statusCode).toUpperCase().includes('ERROR')).length;
    const sample = rows
      .slice(0, 5)
      .map((r) => {
        const name = scrubSecrets(String(r?.spanName ?? r?.name ?? '')).slice(0, 80);
        const svc = r?.serviceName ? ` @${scrubSecrets(String(r.serviceName)).slice(0, 40)}` : '';
        const status = r?.statusCode != null ? ` [${String(r.statusCode).slice(0, 20)}]` : '';
        return `${name}${svc}${status}`.trim();
      })
      .filter((line) => line.length > 0);
    return {
      kind: 'request_log',
      externalId: 'tf_request_logs',
      title: 'TrueFoundry AI Gateway — request logs (6h)',
      summary: `${rows.length} gateway request span(s)${errors ? `, ${errors} error(s)` : ''}${sample[0] ? `; e.g. ${sample[0]}` : ''}`,
      payload: { window_hours: 6, count: rows.length, errors, sample },
      observedAt: null,
    };
  } catch {
    return null;
  }
}

function parseCommits(text: string): CommitFact[] {
  try {
    const j = JSON.parse(text);
    const arr: any[] = Array.isArray(j) ? j : Array.isArray(j?.commits) ? j.commits : Array.isArray(j?.data) ? j.data : [];
    return arr
      .map((c) => {
        const sha = String(c?.sha ?? c?.id ?? '').trim();
        if (!sha) return null;
        const message = scrubSecrets(String(c?.commit?.message ?? c?.message ?? '')).split('\n')[0].slice(0, 200);
        const author = scrubSecrets(String(c?.commit?.author?.name ?? c?.author?.login ?? c?.author?.name ?? '')).slice(0, 120) || null;
        const url = typeof c?.html_url === 'string' ? c.html_url : typeof c?.url === 'string' ? c.url : null;
        const committedAt = typeof c?.commit?.author?.date === 'string' ? c.commit.author.date : null;
        return { sha, message, author, url, committedAt } as CommitFact;
      })
      .filter((c): c is CommitFact => c !== null)
      .slice(0, MAX_COMMITS);
  } catch {
    return [];
  }
}

function parseLogs(text: string): { summary: string; sample: string[] } | null {
  try {
    const j = JSON.parse(text);
    const arr: any[] = Array.isArray(j) ? j : Array.isArray(j?.logs) ? j.logs : Array.isArray(j?.data) ? j.data : [];
    if (!arr.length) return null;
    const sample = arr
      .slice(0, 5)
      .map((l) => scrubSecrets(String(l?.message ?? l?.attributes?.message ?? l?.content ?? '')).slice(0, 200))
      .filter((s) => s.length > 0);
    const summary = `${arr.length} error log event(s)${sample[0] ? `; e.g. "${sample[0]}"` : ''}`;
    return { summary, sample };
  } catch {
    return null;
  }
}

// ---- persistence -------------------------------------------------------------

export function createInvestigateStore(admin: Admin): InvestigateStore {
  const db = admin.database;

  async function insertEvidence(row: Record<string, unknown>): Promise<void> {
    const { error } = await db.from('evidence_items').insert([row]);
    if (error && !isUniqueViolation(error)) throw new JobError({ retryable: true, code: 'evidence_write_failed', summary: 'Could not persist investigation evidence.', source: 'worker' });
  }

  async function evidenceExists(jobId: string, subjectKey: string): Promise<boolean> {
    const { data, error } = await db.from('evidence_items').select('id').eq('collected_by_job_id', jobId).eq('subject_key', subjectKey).limit(1).maybeSingle();
    if (error) throw new JobError({ retryable: true, code: 'evidence_read_failed', summary: 'Could not read investigation evidence.', source: 'worker' });
    return !!data?.id;
  }

  return {
    async loadIncident(incidentId: string): Promise<IncidentContext | null> {
      const { data, error } = await db
        .from('incidents')
        .select('id, workspace_id, service_name, environment, title, description, alert_state, incident_state, external_monitor_id, datadog_url, started_at, signals, alert_payload_summary')
        .eq('id', incidentId)
        .maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'incident_read_failed', summary: 'Could not read the incident.', source: 'worker' });
      if (!data?.id) return null;
      const signals: IncidentSignal[] = Array.isArray(data.signals) ? data.signals : [];
      const aps = (data.alert_payload_summary ?? {}) as Record<string, unknown>;
      const fromSignals = (key: string) => signals.find((s) => s.key === key)?.value ?? null;
      return {
        id: data.id,
        workspaceId: data.workspace_id,
        serviceName: data.service_name ?? null,
        environment: data.environment ?? null,
        title: data.title ?? 'Incident',
        description: data.description ?? null,
        alertState: data.alert_state ?? null,
        incidentState: data.incident_state ?? null,
        monitorId: data.external_monitor_id ?? null,
        datadogUrl: data.datadog_url ?? null,
        traceId: (typeof aps.trace_id === 'string' ? aps.trace_id : null) ?? fromSignals('trace_id'),
        requestId: (typeof aps.request_id === 'string' ? aps.request_id : null) ?? fromSignals('request_id'),
        startedAt: data.started_at ?? null,
        signals,
      };
    },

    async loadRepo(workspaceId: string, serviceName: string | null): Promise<RepoRef | null> {
      const { data, error } = await db
        .from('repositories')
        .select('id, github_owner, github_name, default_branch, is_primary, service_map')
        .eq('workspace_id', workspaceId)
        .order('is_primary', { ascending: false })
        .limit(20);
      if (error) throw new JobError({ retryable: true, code: 'repo_read_failed', summary: 'Could not read the workspace repository.', source: 'worker' });
      const rows: any[] = Array.isArray(data) ? data : [];
      if (rows.length === 0) return null;
      // Prefer the repo whose service_map names this incident's service; fall back
      // to the primary (first, since ordered is_primary desc) so a non-primary
      // service doesn't silently correlate against an unrelated repo.
      const match = serviceName ? rows.find((r) => serviceMapHas(r.service_map, serviceName)) : null;
      const chosen = match ?? rows[0];
      const owner = String(chosen.github_owner ?? '');
      const name = String(chosen.github_name ?? '');
      if (!owner || !name) return null;
      return { id: chosen.id, owner, name, fullName: `${owner}/${name}`, defaultBranch: String(chosen.default_branch ?? 'main') };
    },

    async saveCommitEvidence({ ctx, incidentId, commit, now }) {
      await insertEvidence({
        workspace_id: ctx.workspaceId,
        source_type: 'commit',
        source_provider: 'github',
        collected_by_job_id: ctx.jobId,
        subject_type: 'incident',
        subject_id: incidentId,
        subject_key: commitKey(commit.sha),
        claim_type: 'fact',
        external_id: commit.sha.slice(0, 64),
        uri: validUri(commit.url),
        title: clamp(`Commit ${commit.sha.slice(0, 7)}`, 200),
        summary: clamp(`${commit.message}${commit.author ? ` — ${commit.author}` : ''}`, 300),
        payload: { sha: commit.sha, message: commit.message, author: commit.author, url: validUri(commit.url), committed_at: commit.committedAt },
        content_hash: `${incidentId}:${commitKey(commit.sha)}`,
        verification_state: 'verified',
        observed_at: commit.committedAt ?? now,
        collected_at: now,
      });
    },

    async saveSignalEvidence({ ctx, incidentId, sourceType, fact, now }) {
      const subjectKey = sourceType === 'datadog_trace' ? traceKey(incidentId) : logKey(incidentId);
      await insertEvidence({
        workspace_id: ctx.workspaceId,
        source_type: sourceType,
        source_provider: 'datadog',
        collected_by_job_id: ctx.jobId,
        subject_type: 'incident',
        subject_id: incidentId,
        subject_key: subjectKey,
        claim_type: 'fact',
        external_id: fact.externalId,
        uri: validUri(fact.uri),
        title: clamp(fact.title, 200),
        summary: clamp(fact.summary, 300),
        payload: fact.payload,
        content_hash: `${incidentId}:${subjectKey}`,
        verification_state: 'verified',
        observed_at: fact.observedAt ?? now,
        collected_at: now,
      });
    },

    async saveTruefoundryEvidence({ ctx, incidentId, fact, now }) {
      const subjectKey = fact.kind === 'model_metric' ? tfModelKey(incidentId) : fact.kind === 'mcp_metric' ? tfMcpKey(incidentId) : tfLogKey(incidentId);
      // model/MCP metrics are `truefoundry_metric`; request logs are `truefoundry_log`.
      const sourceType = fact.kind === 'request_log' ? 'truefoundry_log' : 'truefoundry_metric';
      await insertEvidence({
        workspace_id: ctx.workspaceId,
        source_type: sourceType,
        source_provider: 'truefoundry',
        collected_by_job_id: ctx.jobId,
        subject_type: 'incident',
        subject_id: incidentId,
        subject_key: subjectKey,
        claim_type: 'fact',
        external_id: fact.externalId.slice(0, 64),
        uri: null,
        title: clamp(fact.title, 200),
        summary: clamp(fact.summary, 300),
        payload: scrubDeep(fact.payload),
        content_hash: `${incidentId}:${subjectKey}`,
        verification_state: 'verified',
        observed_at: fact.observedAt ?? now,
        collected_at: now,
      });
    },

    async saveUnavailableTruefoundry({ ctx, incidentId, now }) {
      await insertEvidence({
        workspace_id: ctx.workspaceId,
        source_type: 'truefoundry_metric',
        source_provider: 'truefoundry',
        collected_by_job_id: ctx.jobId,
        subject_type: 'incident',
        subject_id: incidentId,
        subject_key: tfKey(incidentId),
        claim_type: 'fact',
        external_id: `tf_unavailable:${incidentId}`,
        uri: null,
        title: 'TrueFoundry telemetry unavailable',
        summary: 'No TrueFoundry model/MCP telemetry was available for this investigation.',
        payload: { reason: 'no_truefoundry_telemetry_available' },
        content_hash: `${incidentId}:${tfKey(incidentId)}`,
        // Degraded source: 'unavailable' keeps it out of the citable-fact set.
        verification_state: 'unavailable',
        observed_at: now,
        collected_at: now,
      });
    },

    async loadEvidenceFacts({ workspaceId, incidentId }): Promise<EvidenceFact[]> {
      const { data, error } = await db
        .from('evidence_items')
        .select('id, source_type, source_provider, title, summary, external_id, uri, verification_state, collected_at')
        .eq('workspace_id', workspaceId)
        .eq('subject_type', 'incident')
        .eq('subject_id', incidentId)
        .eq('verification_state', 'verified')
        .in('source_type', FACT_SOURCE_TYPES)
        .order('observed_at', { ascending: true, nullsFirst: true })
        .order('collected_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(MAX_FACTS);
      if (error) throw new JobError({ retryable: true, code: 'evidence_read_failed', summary: 'Could not read incident evidence.', source: 'worker' });
      return (data ?? []).map((r: any, i: number) => ({
        key: `E${i + 1}`,
        id: r.id,
        verified: true,
        sourceType: r.source_type,
        provider: r.source_provider ?? null,
        title: String(r.title ?? ''),
        summary: String(r.summary ?? ''),
        externalId: r.external_id ?? null,
        uri: r.uri ?? null,
      }));
    },

    async loadCommitEvidence(jobId: string): Promise<{ id: string; commit: CommitFact }[]> {
      const { data, error } = await db
        .from('evidence_items')
        .select('id, payload, observed_at, collected_at')
        .eq('collected_by_job_id', jobId)
        .eq('source_type', 'commit')
        .order('observed_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .limit(MAX_COMMITS);
      if (error) throw new JobError({ retryable: true, code: 'evidence_read_failed', summary: 'Could not read commit evidence.', source: 'worker' });
      return (data ?? []).map((r: any) => ({
        id: r.id,
        commit: {
          sha: String(r.payload?.sha ?? ''),
          message: String(r.payload?.message ?? ''),
          author: r.payload?.author ?? null,
          url: r.payload?.url ?? null,
          committedAt: r.payload?.committed_at ?? null,
        },
      }));
    },

    async hasHypothesesOutput(jobId: string): Promise<boolean> {
      return evidenceExists(jobId, hypothesesKey(jobId));
    },

    async saveHypothesesOutput({ ctx, incidentId, modelCallId, output, facts, now }) {
      // subject_key carries the jobId so resume reads it back; collected_by_job_id
      // is that same job, making (job, key) the idempotency pair. The output is
      // scrubbed (a model can echo a secret-shaped string) and the evidence key→id
      // snapshot is stored so summarize resolves citations against exactly what the
      // model saw.
      await insertEvidence({
        workspace_id: ctx.workspaceId,
        source_type: 'ai_model_call',
        source_provider: 'truefoundry',
        ai_model_call_id: modelCallId || null,
        collected_by_job_id: ctx.jobId,
        subject_type: 'incident',
        subject_id: incidentId,
        subject_key: hypothesesKey(ctx.jobId),
        claim_type: 'inference_support',
        external_id: modelCallId || `hypotheses:${ctx.jobId}`,
        uri: null,
        title: 'Incident hypotheses (model output)',
        summary: clamp(`${output.hypotheses.length} hypothesis/es`, 300),
        payload: { output: scrubDeep(output), facts: facts.map((f) => ({ key: f.key, id: f.id, verified: f.verified, sourceType: f.sourceType, title: scrubSecrets(f.title), summary: scrubSecrets(f.summary), externalId: f.externalId, uri: f.uri, provider: f.provider })), model_call_id: modelCallId || null },
        content_hash: `${incidentId}:${hypothesesKey(ctx.jobId)}`,
        verification_state: 'verified',
        observed_at: now,
        collected_at: now,
      });
    },

    async loadHypothesesOutput(jobId: string): Promise<{ output: InvestigationOutput; facts: EvidenceFact[] } | null> {
      const { data, error } = await db.from('evidence_items').select('payload').eq('collected_by_job_id', jobId).eq('subject_key', hypothesesKey(jobId)).limit(1).maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'evidence_read_failed', summary: 'Could not read hypotheses output.', source: 'worker' });
      if (!data?.payload?.output) return null;
      const parsed = investigationOutputSchema.safeParse(data.payload.output);
      const output = parsed.success ? parsed.data : { summary: null, hypotheses: [] };
      const facts: EvidenceFact[] = Array.isArray(data.payload.facts)
        ? data.payload.facts.map((f: any) => ({ key: String(f.key), id: String(f.id), verified: f.verified === true, sourceType: String(f.sourceType ?? ''), provider: f.provider ?? null, title: String(f.title ?? ''), summary: String(f.summary ?? ''), externalId: f.externalId ?? null, uri: f.uri ?? null }))
        : [];
      return { output, facts };
    },

    async writeCorrelatedChanges({ incidentId, changes, now }) {
      const { error } = await db.from('incidents').update({ correlated_changes: changes, updated_at: now }).eq('id', incidentId);
      if (error) throw new JobError({ retryable: true, code: 'incident_write_failed', summary: 'Could not write correlated changes.', source: 'worker' });
    },

    async writeHypotheses({ incidentId, hypotheses, summary, addSignals, now }) {
      const { data, error } = await db.from('incidents').select('signals, timeline').eq('id', incidentId).maybeSingle();
      if (error) throw new JobError({ retryable: true, code: 'incident_read_failed', summary: 'Could not read the incident to write hypotheses.', source: 'worker' });
      const signals = mergeSignals(Array.isArray(data?.signals) ? data.signals : [], addSignals);
      const timeline = appendFinding(Array.isArray(data?.timeline) ? data.timeline : [], { at: now, kind: 'finding', title: 'Investigation complete', detail: summary });
      const { error: upErr } = await db.from('incidents').update({ hypotheses, signals, timeline, updated_at: now }).eq('id', incidentId);
      if (upErr) throw new JobError({ retryable: true, code: 'incident_write_failed', summary: 'Could not write hypotheses.', source: 'worker' });
    },
  };
}

function mergeSignals(existing: IncidentSignal[], next: IncidentSignal[]): IncidentSignal[] {
  const byKey = new Map(existing.map((s) => [s.key, s]));
  for (const s of next) byKey.set(s.key, s);
  return Array.from(byKey.values()).slice(0, 20);
}

function appendFinding(timeline: any[], entry: { at: string; kind: string; title: string; detail: string }): any[] {
  const filtered = timeline.filter((t) => !(t && t.title === entry.title));
  return [...filtered, entry].slice(-50);
}

/** Whether a repository's service_map references the incident's service. service_map
 *  shape is provider-defined (object or array); match by value/key substring. */
function serviceMapHas(serviceMap: unknown, service: string): boolean {
  if (!serviceMap || !service) return false;
  const needle = service.toLowerCase();
  const hay = JSON.stringify(serviceMap).toLowerCase();
  return hay.includes(`"${needle}"`) || hay.includes(needle);
}

/** Scrub secret-shaped substrings from every string in the model output. */
function scrubDeep(node: unknown): unknown {
  if (typeof node === 'string') return scrubSecrets(node);
  if (Array.isArray(node)) return node.map(scrubDeep);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = scrubDeep(v);
    return out;
  }
  return node;
}

function clamp(s: string, max: number): string {
  const t = (s ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
function validUri(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString() : null;
  } catch {
    return null;
  }
}
