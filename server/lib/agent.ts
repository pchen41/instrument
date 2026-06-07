import { hashPayload } from './hash';
import type { JobRow } from './types';

// Runtime-agnostic agent layer for the Task 5B viability workload. Pure TS: no
// Deno, no SDK, no network — every side effect is behind an injected interface so
// the representative investigation loop runs identically under Vitest (fakes) and
// inside the bundled Edge Function (real TrueFoundry gateway + scripted MCP tools
// + PostgREST persistence). The worker invokes `executePhase` per phase; this
// module supplies the investigation executor.

/** One LLM turn through the TrueFoundry AI Gateway. */
export interface TurnRequest {
  purpose: string; // → ai_model_calls.purpose (also the per-job idempotency key)
  system?: string;
  user: string;
  maxTokens?: number;
}
export interface TurnResult {
  text: string;
  model: string;
  provider: string;
  responseId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  latencyMs: number;
}
export interface AgentGateway {
  complete(req: TurnRequest): Promise<TurnResult>;
}

/** One governed MCP tool call (github / datadog / instrument-investigation). */
export interface ToolRequest {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  /** evidence_items.source_type label, e.g. 'commit' | 'datadog_metric' | 'mcp_tool_call'. */
  sourceType: string;
  claimType: string;
}
export interface ToolResult {
  externalId: string;
  title: string;
  summary: string;
  payload: unknown;
  latencyMs: number;
}
export interface ToolHost {
  call(req: ToolRequest): Promise<ToolResult>;
}

export interface ModelCallRecord {
  workspaceId: string;
  jobId: string;
  purpose: string;
  modelName: string;
  providerName: string;
  responseId?: string;
  inputHash: string;
  outputRedacted: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  startedAt: string;
  completedAt: string;
  toolCallsRedacted?: unknown[];
}
export interface EvidenceRecord {
  workspaceId: string;
  jobId: string;
  subjectId: string;
  subjectKey: string;
  sourceType: string;
  sourceProvider: string;
  claimType: string;
  externalId: string;
  title: string;
  summary: string;
  payload: unknown;
  contentHash: string;
  observedAt: string;
}

/**
 * Idempotent persistence for the artifacts a run produces. The has-then-record
 * split is what proves the acceptance criterion "resuming does not duplicate
 * model-call records, evidence items": a resumed phase that re-enters checks
 * existence first and skips the write. (Completed phases are skipped entirely by
 * the worker; this guards the narrower window of a kill within a phase.)
 */
export interface WorkStore {
  hasModelCall(jobId: string, purpose: string): Promise<boolean>;
  recordModelCall(rec: ModelCallRecord): Promise<void>;
  hasEvidence(jobId: string, subjectKey: string): Promise<boolean>;
  recordEvidence(rec: EvidenceRecord): Promise<void>;
}

export interface InvestigationDeps {
  gateway: AgentGateway;
  tools: ToolHost;
  store: WorkStore;
  /** Wall clock (defaults to Date) so tests stay deterministic. */
  now?: () => Date;
}

export interface PhaseExecCtx {
  job: JobRow;
  phaseKey: string;
  attempt: number;
}
export type PhaseExecutor = (ctx: PhaseExecCtx) => Promise<void>;

/** Pull the viability run context off the job (set at enqueue time). */
interface ViabilityContext {
  serviceName: string;
  repo?: string;
  monitor?: string;
}
function viabilityContext(job: JobRow): ViabilityContext | null {
  const ts = job.trigger_summary as Record<string, unknown> | undefined;
  if (!ts || ts.mode !== 'viability') return null;
  return {
    serviceName: typeof ts.service_name === 'string' ? ts.service_name : 'service',
    repo: typeof ts.repo === 'string' ? ts.repo : undefined,
    monitor: typeof ts.monitor === 'string' ? ts.monitor : undefined,
  };
}

/**
 * Per-phase executor for a representative incident investigation. Returns a
 * no-op for any job not explicitly flagged `trigger_summary.mode === 'viability'`,
 * so it can be wired into the shared worker tick without changing behaviour for
 * the seeded/simulated 5A jobs.
 *
 * Phase map (mirrors PHASE_PLANS.incident_investigation):
 *   triage         → 1 gateway turn
 *   gather_signals → 2 MCP tool calls → 2 evidence items
 *   correlate      → 1 gateway turn
 *   hypotheses     → 1 gateway turn
 *   summarize      → 1 gateway turn
 */
export function makeInvestigationExecutor(deps: InvestigationDeps): PhaseExecutor {
  const now = deps.now ?? (() => new Date());

  const turn = async (job: JobRow, purpose: string, req: Omit<TurnRequest, 'purpose'>): Promise<void> => {
    if (await deps.store.hasModelCall(job.id, purpose)) return; // resume: already recorded
    const startedAt = now().toISOString();
    const res = await deps.gateway.complete({ purpose, ...req });
    await deps.store.recordModelCall({
      workspaceId: job.workspace_id,
      jobId: job.id,
      purpose,
      modelName: res.model,
      providerName: res.provider,
      responseId: res.responseId,
      inputHash: hashPayload({ purpose, user: req.user, system: req.system ?? null }),
      outputRedacted: redact(res.text),
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      totalTokens: res.totalTokens,
      latencyMs: res.latencyMs,
      startedAt,
      completedAt: now().toISOString(),
    });
  };

  const toolEvidence = async (job: JobRow, req: ToolRequest): Promise<void> => {
    const subjectKey = `${job.id}:${req.server}:${req.tool}`;
    if (await deps.store.hasEvidence(job.id, subjectKey)) return; // resume: already collected
    const res = await deps.tools.call(req);
    await deps.store.recordEvidence({
      workspaceId: job.workspace_id,
      jobId: job.id,
      subjectId: job.target_id,
      subjectKey,
      sourceType: req.sourceType,
      sourceProvider: req.server,
      claimType: req.claimType,
      externalId: res.externalId,
      title: res.title,
      summary: res.summary,
      payload: res.payload,
      contentHash: hashPayload(res.payload),
      observedAt: now().toISOString(),
    });
  };

  return async ({ job, phaseKey }) => {
    const ctx = viabilityContext(job);
    if (!ctx) return; // not a viability job — leave simulated behaviour to the worker

    switch (phaseKey) {
      case 'triage':
        await turn(job, 'triage', {
          system: 'You are an SRE triaging an alert. Be concise.',
          user: `Alert fired on service "${ctx.serviceName}". In 2-3 sentences, state what to check first and why.`,
          maxTokens: 200,
        });
        break;
      case 'gather_signals':
        await toolEvidence(job, {
          server: 'github',
          tool: 'list_recent_commits',
          args: { repo: ctx.repo ?? 'unknown', since_hours: 6 },
          sourceType: 'commit',
          claimType: 'recent_change',
        });
        await toolEvidence(job, {
          server: 'datadog',
          tool: 'query_metric',
          args: { metric: `trace.${ctx.serviceName}.duration.p95`, window: '30m' },
          sourceType: 'datadog_metric',
          claimType: 'latency_signal',
        });
        break;
      case 'correlate':
        await turn(job, 'correlate', {
          system: 'You are an SRE correlating signals to recent changes.',
          user: `Given a p95 latency spike on "${ctx.serviceName}" and a recent deploy, give the single most likely correlation in 2 sentences.`,
          maxTokens: 220,
        });
        break;
      case 'hypotheses':
        await turn(job, 'hypotheses', {
          system: 'You are an SRE. Output ranked hypotheses, most likely first.',
          user: `List up to 3 ranked root-cause hypotheses for the latency spike on "${ctx.serviceName}", each one line with a confidence (high/likely/low).`,
          maxTokens: 280,
        });
        break;
      case 'summarize':
        await turn(job, 'summarize', {
          system: 'You are an SRE writing the incident summary for responders.',
          user: `Write a 3-sentence summary of the most likely cause of the "${ctx.serviceName}" latency spike and the recommended next step.`,
          maxTokens: 240,
        });
        break;
    }
  };
}

/** Keep stored model output bounded + UI-safe (no unbounded provider blobs). */
function redact(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}…` : trimmed;
}
