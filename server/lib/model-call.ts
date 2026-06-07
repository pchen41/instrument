// Shared TrueFoundry model-call helper (Task 5C foundation).
//
// This is the single surface downstream workflow tasks (6, 7, 9, 11, 12) use to
// make an AI call: it runs the call through an injected gateway/Agent invoker,
// bounds any streamed MCP tool calls into `ai_model_calls.tool_calls_redacted`,
// validates structured output against a registered schema, persists ONE full
// `ai_model_calls` row (success or failure), persists cited tool results as
// `evidence_items` linked back to that row, and returns a result the caller can
// gate on before display or external posting.
//
// Runtime-agnostic: pure TS, every side effect (the gateway, persistence) behind
// an injected interface, so it runs under Vitest with fixtures and bundled into
// an Edge Function with the real TrueFoundry client + PostgREST store. The Deno
// adapters live in server/functions/_shared/model-call-store.ts.
import { hashPayload } from './hash';
import { SchemaRegistry, schemaRegistry, type ValidationResult, type ValidationStatus } from './schema-validation';

/** ai_model_calls.api_surface — which TrueFoundry surface produced the call (docs/ERD.md). */
export type ApiSurface = 'agent_chat_completions' | 'agent_responses';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** A reference to a governed MCP server passed to the Agent API (no secrets). */
export interface McpServerRef {
  name: string;
  /** Optional gateway FQN/URL recorded for provenance. */
  fqn?: string;
}

export interface AgentInvokeRequest {
  apiSurface: ApiSurface;
  messages: ModelMessage[];
  maxTokens?: number;
  /** MCP servers offered to the agent → ai_model_calls.mcp_servers_requested. */
  mcpServers?: McpServerRef[];
  /** Agent tool-loop cap → ai_model_calls.agent_iteration_limit. */
  agentIterationLimit?: number;
}

/** One MCP tool call observed in a streamed agent turn (pre-bounding). */
export interface RawToolCall {
  server: string;
  tool: string;
  args?: unknown;
  result?: unknown;
  status: 'ok' | 'error';
  latencyMs?: number;
  errorSummary?: string;
}

/** A cited tool output / model-supported fact to persist as evidence. */
export interface AgentEvidenceDraft {
  subjectType?: string;
  subjectId?: string | null;
  subjectKey: string;
  /** evidence_items.source_type enum (e.g. 'mcp_tool_call', 'commit', 'datadog_metric'). */
  sourceType: string;
  /** evidence_items.source_provider enum: 'github' | 'datadog' | 'truefoundry'. */
  sourceProvider: string;
  claimType: string;
  externalId: string;
  uri?: string;
  title: string;
  summary: string;
  payload: unknown;
  observedAt?: string;
}

export interface AgentInvokeResult {
  text: string;
  model: string;
  provider: string;
  responseId?: string;
  traceId?: string;
  spanId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  latencyMs: number;
  /** Streamed MCP tool calls (Agent API). Bounded into tool_calls_redacted on persist. */
  toolCalls?: RawToolCall[];
  /** Cited tool outputs / facts to persist as evidence_items. */
  evidence?: AgentEvidenceDraft[];
}

/** The injected AI surface: a non-tool chat completion or a streamed agent turn. */
export interface AgentInvoker {
  invoke(req: AgentInvokeRequest): Promise<AgentInvokeResult>;
}

/** Bounded summary of one MCP tool call (what lands in tool_calls_redacted). */
export interface ToolCallSummary {
  server: string;
  tool: string;
  status: 'ok' | 'error';
  latency_ms?: number;
  args_summary?: string;
  result_summary?: string;
  error_summary?: string;
}

export interface ToolCallBounds {
  maxToolCalls: number;
  maxArgsChars: number;
  maxResultChars: number;
}
export const DEFAULT_TOOL_CALL_BOUNDS: ToolCallBounds = { maxToolCalls: 20, maxArgsChars: 400, maxResultChars: 600 };

/** A full ai_model_calls row, as the persistence store should write it. */
export interface ModelCallRow {
  workspaceId: string;
  integrationId?: string | null;
  jobId?: string | null;
  purpose: string;
  apiSurface: ApiSurface;
  status: 'succeeded' | 'failed';
  responseId?: string | null;
  traceId?: string | null;
  spanId?: string | null;
  gatewayBaseUrlName?: string | null;
  providerName?: string | null;
  modelName?: string | null;
  agentIterationLimit?: number | null;
  mcpServersRequested: { name: string; fqn?: string }[];
  toolCallsRedacted: ToolCallSummary[];
  requestSchemaVersion?: string | null;
  outputSchemaVersion?: string | null;
  inputHash: string;
  outputRedacted: unknown;
  validationStatus: ValidationStatus;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  errorCode?: string | null;
  errorSummary?: string | null;
  startedAt: string;
  completedAt?: string | null;
}

/** A full evidence_items row, linked to the model call that cited it. */
export interface EvidenceRow {
  workspaceId: string;
  aiModelCallId: string;
  collectedByJobId?: string | null;
  subjectType: string;
  subjectId?: string | null;
  subjectKey: string;
  sourceType: string;
  sourceProvider: string;
  claimType: string;
  externalId: string;
  uri?: string | null;
  title: string;
  summary: string;
  payload: unknown;
  contentHash: string;
  observedAt: string;
}

/**
 * Idempotent persistence. `saveModelCall` returns the row id (and whether a
 * unique-constraint hit deduped it onto an existing row), so evidence can link
 * to it. Implementations: the Deno PostgREST store (prod) and FakeStore (tests).
 */
export interface ModelCallStore {
  saveModelCall(row: ModelCallRow): Promise<{ id: string; deduped: boolean }>;
  saveEvidence(rows: EvidenceRow[]): Promise<void>;
}

export interface RunModelCallDeps {
  gateway: AgentInvoker;
  store: ModelCallStore;
  /** Schema registry for structured-output validation (defaults to the shared one). */
  registry?: SchemaRegistry;
  /** Wall clock (defaults to Date) for deterministic tests. */
  now?: () => Date;
}

export interface RunModelCallSpec {
  workspaceId: string;
  integrationId?: string | null;
  jobId?: string | null;
  /** ai_model_calls.purpose (also the per-job idempotency key). */
  purpose: string;
  request: AgentInvokeRequest;
  requestSchemaVersion?: string;
  /** When set, the output text is parsed + validated against this schema version. */
  outputSchemaVersion?: string;
  /** Extracts the structured object from the model text (default: JSON.parse). */
  parseStructured?: (text: string) => unknown;
  /** Recorded on gateway_base_url_name (provenance label, not a URL/secret). */
  gatewayBaseUrlName?: string;
  /** Default subject for evidence rows that don't carry their own. */
  subjectType?: string;
  subjectId?: string | null;
  toolCallBounds?: Partial<ToolCallBounds>;
}

export interface RunModelCallOutcome {
  modelCallId: string;
  deduped: boolean;
  result: AgentInvokeResult;
  validation: ValidationResult;
  toolCallsRedacted: ToolCallSummary[];
}

/**
 * Run one model call end-to-end: invoke → bound tool calls → validate output →
 * persist the ai_model_calls row → persist cited evidence. On a gateway failure
 * a `status: 'failed'` row is still written (with the error captured) before the
 * error is re-thrown, so every attempt leaves an audit trail.
 */
export async function runModelCall(deps: RunModelCallDeps, spec: RunModelCallSpec): Promise<RunModelCallOutcome> {
  const now = deps.now ?? (() => new Date());
  const registry = deps.registry ?? schemaRegistry;
  const bounds = { ...DEFAULT_TOOL_CALL_BOUNDS, ...spec.toolCallBounds };
  const startedAt = now().toISOString();
  const inputHash = hashPayload({
    purpose: spec.purpose,
    apiSurface: spec.request.apiSurface,
    messages: spec.request.messages,
    mcpServers: (spec.request.mcpServers ?? []).map((s) => s.name),
    requestSchemaVersion: spec.requestSchemaVersion ?? null,
  });
  const mcpServersRequested = (spec.request.mcpServers ?? []).map((s) => ({ name: s.name, ...(s.fqn ? { fqn: s.fqn } : {}) }));

  let result: AgentInvokeResult;
  try {
    result = await deps.gateway.invoke(spec.request);
  } catch (err) {
    // Persist the failure before rethrowing. Never copy a raw provider/internal
    // message into the stored summary — keep it bounded + sanitized.
    const { code, summary } = errorParts(err);
    await deps.store.saveModelCall({
      workspaceId: spec.workspaceId,
      integrationId: spec.integrationId ?? null,
      jobId: spec.jobId ?? null,
      purpose: spec.purpose,
      apiSurface: spec.request.apiSurface,
      status: 'failed',
      gatewayBaseUrlName: spec.gatewayBaseUrlName ?? null,
      agentIterationLimit: spec.request.agentIterationLimit ?? null,
      mcpServersRequested,
      toolCallsRedacted: [],
      requestSchemaVersion: spec.requestSchemaVersion ?? null,
      outputSchemaVersion: spec.outputSchemaVersion ?? null,
      inputHash,
      outputRedacted: null,
      validationStatus: 'not_applicable',
      latencyMs: elapsed(startedAt, now),
      errorCode: code,
      errorSummary: summary,
      startedAt,
      completedAt: now().toISOString(),
    });
    throw err;
  }

  const toolCallsRedacted = summarizeToolCalls(result.toolCalls ?? [], bounds);

  // Validate structured output (if a schema version was requested).
  let validation: ValidationResult = { status: 'not_applicable', errors: [] };
  if (spec.outputSchemaVersion) {
    let parsed: unknown;
    let parseError: string | null = null;
    try {
      parsed = (spec.parseStructured ?? defaultParse)(result.text);
    } catch (e) {
      parseError = e instanceof Error ? e.message : 'failed to parse model output';
    }
    validation = parseError
      ? { status: 'invalid', errors: [parseError] }
      : registry.validate(spec.outputSchemaVersion, parsed);
  }

  const completedAt = now().toISOString();
  const saved = await deps.store.saveModelCall({
    workspaceId: spec.workspaceId,
    integrationId: spec.integrationId ?? null,
    jobId: spec.jobId ?? null,
    purpose: spec.purpose,
    apiSurface: spec.request.apiSurface,
    status: 'succeeded',
    responseId: result.responseId ?? null,
    traceId: result.traceId ?? null,
    spanId: result.spanId ?? null,
    gatewayBaseUrlName: spec.gatewayBaseUrlName ?? null,
    providerName: result.provider,
    modelName: result.model,
    agentIterationLimit: spec.request.agentIterationLimit ?? null,
    mcpServersRequested,
    toolCallsRedacted,
    requestSchemaVersion: spec.requestSchemaVersion ?? null,
    outputSchemaVersion: spec.outputSchemaVersion ?? null,
    inputHash,
    outputRedacted: boundedOutput(result.text),
    validationStatus: validation.status,
    inputTokens: result.inputTokens ?? null,
    outputTokens: result.outputTokens ?? null,
    totalTokens: result.totalTokens ?? null,
    costUsd: result.costUsd ?? null,
    latencyMs: result.latencyMs,
    startedAt,
    completedAt,
  });

  // Persist cited evidence, each linked to the model call that produced it.
  const drafts = result.evidence ?? [];
  if (drafts.length) {
    const rows: EvidenceRow[] = drafts.map((d) => ({
      workspaceId: spec.workspaceId,
      aiModelCallId: saved.id,
      collectedByJobId: spec.jobId ?? null,
      subjectType: d.subjectType ?? spec.subjectType ?? 'incident',
      subjectId: d.subjectId ?? spec.subjectId ?? null,
      subjectKey: d.subjectKey,
      sourceType: d.sourceType,
      sourceProvider: d.sourceProvider,
      claimType: d.claimType,
      externalId: d.externalId,
      uri: d.uri ?? null,
      title: d.title,
      summary: d.summary,
      payload: d.payload,
      contentHash: hashPayload(d.payload),
      observedAt: d.observedAt ?? completedAt,
    }));
    await deps.store.saveEvidence(rows);
  }

  return { modelCallId: saved.id, deduped: saved.deduped, result, validation, toolCallsRedacted };
}

/** Bound streamed MCP tool calls into UI-safe summaries (count + per-field caps). */
export function summarizeToolCalls(calls: RawToolCall[], bounds: ToolCallBounds = DEFAULT_TOOL_CALL_BOUNDS): ToolCallSummary[] {
  return calls.slice(0, bounds.maxToolCalls).map((c) => {
    const s: ToolCallSummary = { server: c.server, tool: c.tool, status: c.status };
    if (typeof c.latencyMs === 'number') s.latency_ms = c.latencyMs;
    if (c.args !== undefined) s.args_summary = truncate(stringify(c.args), bounds.maxArgsChars);
    if (c.result !== undefined) s.result_summary = truncate(stringify(c.result), bounds.maxResultChars);
    if (c.errorSummary) s.error_summary = truncate(c.errorSummary, bounds.maxResultChars);
    return s;
  });
}

function defaultParse(text: string): unknown {
  return JSON.parse(extractJson(text));
}

/** Pull a JSON object/array out of model text (tolerates ```json fences / prose). */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) return body;
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  return end > start ? body.slice(start, end + 1) : body.slice(start);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Keep stored model output bounded; preserve structure when it's an object. */
function boundedOutput(text: string): unknown {
  return truncate(text, 4000);
}

function elapsed(startedAt: string, now: () => Date): number {
  return Math.max(0, now().getTime() - new Date(startedAt).getTime());
}

/** Sanitize a thrown error into a bounded { code, summary } for persistence. */
function errorParts(err: unknown): { code: string; summary: string } {
  const e = err as { code?: unknown; summary?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : 'model_call_failed';
  const raw = typeof e?.summary === 'string' ? e.summary : typeof e?.message === 'string' ? e.message : 'model call failed';
  return { code, summary: truncate(raw, 300) };
}
