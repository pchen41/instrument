// Runtime-agnostic incident-investigation executor (Task 11). The real RCA flow
// behind an `incident_investigation` job: read the incident + its alert evidence,
// gather verified signals through the READ-ONLY `instrument-investigation` MCP
// (github commits/PRs + datadog traces/logs — that federated server has zero write
// tools, so the investigation is read-only by construction), make ONE schema-
// validated model call to rank hypotheses, then deterministically resolve each
// cited evidence key to a verified `evidence_items` id before writing
// `incidents.hypotheses`. It NEVER creates branches, PRs, monitors, approvals, or
// any external write.
//
// Phases (PHASE_PLANS.incident_investigation):
//   triage         — load the incident; resolve the service's repo + the alert's
//                    trace/request ids. No model call, no write.
//   gather_signals — best-effort MCP reads → persist commit / trace / log evidence
//                    (verified facts) + a single `unavailable` row for TrueFoundry
//                    telemetry when its obs MCP isn't reachable. A flaky/absent
//                    source DEGRADES (recorded) rather than failing the job.
//   correlate      — derive `incidents.correlated_changes` from the commit evidence.
//   hypotheses     — one `agent_chat_completions` call over the incident + the
//                    enumerated evidence → validated ranked hypotheses (persisted
//                    once so a resume doesn't re-bill the gateway).
//   summarize      — resolve every hypothesis's cited evidence keys to verified
//                    evidence ids (dropping unverifiable citations), cap confidence
//                    that lacks evidence, fold a no-code-fix explanation into
//                    runtime/upstream causes, and write `incidents.hypotheses`.
import type { PhaseExecCtx, PhaseExecutor } from './agent';
import { parseFindings } from './pr-review';
import { JobError } from './retry';
import { scrubSecrets } from './redaction';
import { type AgentInvoker, type ModelCallStore, runModelCall } from './model-call';
import { type SchemaRegistry, schemaRegistry, z } from './schema-validation';
import type { JobRow } from './types';

export const INVESTIGATION_SCHEMA_VERSION = 'incident_hypotheses.v1';
const HYPOTHESES_PURPOSE = 'incident_hypotheses';

const MAX_HYPOTHESES = 5;
const MAX_EVIDENCE_IDS = 8;
const MAX_CORRELATED = 6;

// ---- structured MODEL output schema (registered) -----------------------------

export const investigationHypothesisSchema = z.object({
  title: z.string().trim().min(1).max(200),
  reasoning: z.string().trim().min(1).max(1500),
  confidence: z.enum(['high', 'likely', 'low']).catch('likely'),
  // Mirrors incident_root_cause_type (docs/ERD.md): code is the only Instrument-
  // fixable class; runtime_config / upstream / unknown explain a non-code cause.
  root_cause_type: z.enum(['code', 'runtime_config', 'upstream', 'unknown']).catch('unknown'),
  instrument_can_fix: z.boolean().catch(false),
  // The evidence keys (E1, E2, …) the prompt offered; resolved to verified
  // evidence_items ids in selection. Off-list/hallucinated keys are dropped there.
  evidence_keys: z.array(z.string().trim().min(1).max(24)).max(12).catch([]),
  no_fix_reason: z.string().trim().max(600).nullish(),
  suggested_next_step: z.string().trim().max(600).nullish(),
});
export type InvestigationHypothesis = z.infer<typeof investigationHypothesisSchema>;

export const investigationOutputSchema = z.object({
  summary: z.string().trim().max(800).nullish(),
  // Required root array (non-array → 'invalid'); per-item lenient (drop a malformed
  // hypothesis, keep the batch) — same shape as the scan/alert-coverage schemas.
  hypotheses: z
    .array(z.unknown())
    .transform((arr) =>
      arr
        .slice(0, 8)
        .map((x) => investigationHypothesisSchema.safeParse(x))
        .flatMap((r) => (r.success ? [r.data] : []))
        .slice(0, MAX_HYPOTHESES),
    ),
});
export type InvestigationOutput = z.infer<typeof investigationOutputSchema>;

schemaRegistry.register(INVESTIGATION_SCHEMA_VERSION, investigationOutputSchema);

/** Fence-safe extraction (reuses the PR-review/scan balanced-JSON parser). */
export { parseFindings as parseInvestigationOutput };

// ---- context -----------------------------------------------------------------

export interface InvestigationContext {
  workspaceId: string;
  incidentId: string;
  source: string;
  /** The investigating job id — the collected_by_job_id / idempotency partner. */
  jobId: string;
}

/**
 * Resolve the real-investigation context off the job. Only `incident_investigation`
 * jobs targeting an incident and triggered by the console or a Datadog alert are
 * ours — the seeded/simulated 5A jobs (viability mode / `simulate`) are left to the
 * engine's simulated path, so wiring this executor in doesn't change their
 * behaviour. The worker uses the same predicate to skip its placeholder finalize.
 */
export function investigationContext(job: JobRow): InvestigationContext | null {
  if (job.job_type !== 'incident_investigation') return null;
  if (job.target_type !== 'incident' || !job.target_id) return null;
  const ts = job.trigger_summary as Record<string, unknown> | undefined;
  const source = typeof ts?.source === 'string' ? ts.source : '';
  if (source !== 'console' && source !== 'datadog_alert') return null;
  if (ts?.mode === 'viability' || ts?.simulate) return null;
  return { workspaceId: job.workspace_id, incidentId: job.target_id, source, jobId: job.id };
}

/** Whether a job is a real Task 11 investigation (drives the worker's finalize gate). */
export function isRealInvestigation(job: JobRow): boolean {
  return investigationContext(job) !== null;
}

// ---- injected interfaces -----------------------------------------------------

export interface IncidentContext {
  id: string;
  workspaceId: string;
  serviceName: string | null;
  environment: string | null;
  title: string;
  description: string | null;
  alertState: string | null;
  incidentState: string | null;
  monitorId: string | null;
  datadogUrl: string | null;
  traceId: string | null;
  requestId: string | null;
  startedAt: string | null;
  signals: IncidentSignal[];
}

export interface IncidentSignal {
  key: string;
  label: string;
  value: string;
  evidence_id?: string | null;
}

export interface RepoRef {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface CommitFact {
  sha: string;
  message: string;
  author: string | null;
  url: string | null;
  committedAt: string | null;
}
export interface SignalFact {
  /** External id (trace id / a synthetic log key). */
  externalId: string;
  title: string;
  summary: string;
  uri: string | null;
  payload: Record<string, unknown>;
  observedAt: string | null;
}

/** Read-only investigation MCP (the federated `instrument-investigation` server). */
export interface InvestigateMcp {
  recentCommits(repo: RepoRef): Promise<CommitFact[]>;
  getTrace(traceId: string): Promise<SignalFact | null>;
  searchServiceLogs(service: string, traceId: string | null): Promise<SignalFact | null>;
  /** Whether TrueFoundry's observability MCP is reachable from the worker. */
  truefoundryAvailable(): boolean;
}

/** One verified fact offered to the model, with the stable key it cites. */
export interface EvidenceFact {
  key: string; // E1, E2, …
  id: string; // evidence_items.id
  verified: boolean;
  sourceType: string;
  provider: string | null;
  title: string;
  summary: string;
  externalId: string | null;
  uri: string | null;
}

export interface InvestigateStore {
  loadIncident(incidentId: string): Promise<IncidentContext | null>;
  loadRepo(workspaceId: string, serviceName: string | null): Promise<RepoRef | null>;
  saveCommitEvidence(args: { ctx: InvestigationContext; incidentId: string; commit: CommitFact; now: string }): Promise<void>;
  saveSignalEvidence(args: { ctx: InvestigationContext; incidentId: string; sourceType: 'datadog_trace' | 'datadog_log'; fact: SignalFact; now: string }): Promise<void>;
  /** Persist the degraded TrueFoundry-telemetry marker (verification_state 'unavailable'). Idempotent. */
  saveUnavailableTruefoundry(args: { ctx: InvestigationContext; incidentId: string; now: string }): Promise<void>;
  /** Verified fact rows for this incident (alert events + gathered), enumerated E1.. deterministically. */
  loadEvidenceFacts(args: { workspaceId: string; incidentId: string }): Promise<EvidenceFact[]>;
  /** Commit evidence collected by this job (for correlated_changes). */
  loadCommitEvidence(jobId: string): Promise<{ id: string; commit: CommitFact }[]>;
  hasHypothesesOutput(jobId: string): Promise<boolean>;
  /** Persist the model output together with the EXACT evidence key→id snapshot the
   *  model was shown, so summarize resolves citations against that snapshot (not a
   *  re-enumeration that could have shifted). */
  saveHypothesesOutput(args: { ctx: InvestigationContext; incidentId: string; modelCallId: string; output: InvestigationOutput; facts: EvidenceFact[]; now: string }): Promise<void>;
  loadHypothesesOutput(jobId: string): Promise<{ output: InvestigationOutput; facts: EvidenceFact[] } | null>;
  writeCorrelatedChanges(args: { incidentId: string; changes: CorrelatedChange[]; now: string }): Promise<void>;
  writeHypotheses(args: { incidentId: string; hypotheses: StoredHypothesis[]; summary: string; addSignals: IncidentSignal[]; now: string }): Promise<void>;
}

export interface InvestigateDeps {
  gateway: AgentInvoker;
  modelStore: ModelCallStore;
  mcp: InvestigateMcp;
  store: InvestigateStore;
  registry?: SchemaRegistry;
  now?: () => Date;
}

// ---- output shapes (conform to src/lib/schemas/incidents.ts) ------------------

export interface StoredHypothesis {
  rank: number;
  leading: boolean;
  summary: string;
  detail: string;
  root_cause_type: 'code' | 'runtime_config' | 'upstream' | 'unknown';
  confidence: 'high' | 'likely' | 'low';
  evidence_ids: string[];
  instrument_can_fix: boolean;
  no_fix_reason?: string | null;
  suggested_next_step?: string | null;
}
export interface CorrelatedChange {
  kind: 'commit' | 'pr' | 'deploy' | 'config';
  ref: string;
  summary: string;
  url?: string | null;
  evidence_id?: string | null;
}

// ---- executor ----------------------------------------------------------------

export function makeInvestigateExecutor(deps: InvestigateDeps): PhaseExecutor {
  const now = deps.now ?? (() => new Date());
  const registry = deps.registry ?? schemaRegistry;
  return async ({ job, phaseKey }: PhaseExecCtx) => {
    const ctx = investigationContext(job);
    if (!ctx) return; // not a real investigation — leave to the simulated path
    switch (phaseKey) {
      case 'triage':
        await triage(deps, ctx);
        break;
      case 'gather_signals':
        await gather(deps, ctx, now);
        break;
      case 'correlate':
        await correlate(deps, ctx, job.id, now);
        break;
      case 'hypotheses':
        await hypotheses(deps, ctx, job.id, registry, now);
        break;
      case 'summarize':
        await summarize(deps, ctx, job.id, now);
        break;
    }
  };
}

async function loadIncidentOrThrow(deps: InvestigateDeps, ctx: InvestigationContext): Promise<IncidentContext> {
  const incident = await deps.store.loadIncident(ctx.incidentId);
  if (!incident) throw new JobError({ retryable: false, code: 'incident_missing', summary: 'The incident to investigate was not found.', source: 'worker' });
  // Defence in depth (the store writes by incident id under the service-role
  // client): never let a job touch an incident outside its own workspace.
  if (incident.workspaceId !== ctx.workspaceId) throw new JobError({ retryable: false, code: 'incident_workspace_mismatch', summary: "The incident does not belong to this job's workspace.", source: 'worker' });
  return incident;
}

/** triage: confirm the incident exists (read-only). Resolving the repo here would
 *  be wasted work — gather needs it and re-reads cheaply. */
async function triage(deps: InvestigateDeps, ctx: InvestigationContext): Promise<void> {
  await loadIncidentOrThrow(deps, ctx);
}

/**
 * gather: collect verified signals through the read-only MCP. Every source is
 * best-effort — a flaky or unreachable provider is recorded as degraded (TrueFoundry
 * persists an `unavailable` evidence row) rather than failing the investigation, so
 * a Datadog/GitHub-backed RCA still completes. Evidence writes are idempotent.
 */
async function gather(deps: InvestigateDeps, ctx: InvestigationContext, now: () => Date): Promise<void> {
  const incident = await loadIncidentOrThrow(deps, ctx);

  // GitHub: recent commits on the service's repo primary branch (deploy candidates).
  const repo = await deps.store.loadRepo(ctx.workspaceId, incident.serviceName);
  if (repo) {
    const commits = await safe(() => deps.mcp.recentCommits(repo));
    for (const commit of commits ?? []) {
      await deps.store.saveCommitEvidence({ ctx, incidentId: incident.id, commit, now: now().toISOString() });
    }
  }

  // Datadog: the alert's trace (when the alert carried a trace_id) + service logs.
  if (incident.traceId) {
    const trace = await safe(() => deps.mcp.getTrace(incident.traceId as string));
    if (trace) await deps.store.saveSignalEvidence({ ctx, incidentId: incident.id, sourceType: 'datadog_trace', fact: trace, now: now().toISOString() });
  }
  if (incident.serviceName) {
    const logs = await safe(() => deps.mcp.searchServiceLogs(incident.serviceName as string, incident.traceId));
    if (logs) await deps.store.saveSignalEvidence({ ctx, incidentId: incident.id, sourceType: 'datadog_log', fact: logs, now: now().toISOString() });
  }

  // TrueFoundry: its observability MCP needs a token the worker doesn't carry, so
  // surface the missing source as `unavailable` evidence (not a hard failure).
  if (!deps.mcp.truefoundryAvailable()) {
    await deps.store.saveUnavailableTruefoundry({ ctx, incidentId: incident.id, now: now().toISOString() });
  }
}

/** correlate: derive correlated_changes from the gathered commit evidence. */
async function correlate(deps: InvestigateDeps, ctx: InvestigationContext, jobId: string, now: () => Date): Promise<void> {
  const commitRows = await deps.store.loadCommitEvidence(jobId);
  const changes = buildCorrelatedChanges(commitRows);
  await deps.store.writeCorrelatedChanges({ incidentId: ctx.incidentId, changes, now: now().toISOString() });
}

/** hypotheses: one validated model call over the enumerated evidence; persisted once. */
async function hypotheses(deps: InvestigateDeps, ctx: InvestigationContext, jobId: string, registry: SchemaRegistry, now: () => Date): Promise<void> {
  if (await deps.store.hasHypothesesOutput(jobId)) return; // resume: don't re-bill the gateway
  const incident = await loadIncidentOrThrow(deps, ctx);
  const facts = await deps.store.loadEvidenceFacts({ workspaceId: ctx.workspaceId, incidentId: incident.id });

  const outcome = await runModelCall(
    { gateway: deps.gateway, store: deps.modelStore, registry, now },
    {
      workspaceId: ctx.workspaceId,
      jobId,
      purpose: HYPOTHESES_PURPOSE,
      request: {
        apiSurface: 'agent_chat_completions',
        messages: buildInvestigationMessages(incident, facts, deps.mcp.truefoundryAvailable()),
        // gemini-3.5-flash is a reasoning model that spends output tokens on a
        // preamble before the JSON; a tight cap truncates the JSON → invalid. 3000
        // is the proven budget for this model (Tasks 6/9).
        maxTokens: 3000,
      },
      requestSchemaVersion: 'incident_investigation_request.v1',
      outputSchemaVersion: INVESTIGATION_SCHEMA_VERSION,
      parseStructured: parseFindings,
      gatewayBaseUrlName: 'truefoundry',
      subjectType: 'incident',
      subjectId: incident.id,
    },
  );
  const output: InvestigationOutput = outcome.validation.status === 'valid'
    ? (outcome.validation.value as InvestigationOutput)
    : { summary: null, hypotheses: [] };
  await deps.store.saveHypothesesOutput({ ctx, incidentId: incident.id, modelCallId: outcome.modelCallId, output, facts, now: now().toISOString() });
}

/** summarize: resolve cited evidence, cap unsupported confidence, write hypotheses. */
async function summarize(deps: InvestigateDeps, ctx: InvestigationContext, jobId: string, now: () => Date): Promise<void> {
  const loaded = await deps.store.loadHypothesesOutput(jobId);
  if (!loaded) throw new JobError({ retryable: true, code: 'hypotheses_unavailable', summary: 'The hypotheses output was not available to summarize.', source: 'worker' });
  const incident = await loadIncidentOrThrow(deps, ctx);

  // Resolve citations against the SNAPSHOT the model was shown, so a later evidence
  // change can never re-point a hypothesis to the wrong verified evidence id.
  const hyps = selectHypotheses(loaded.output.hypotheses, loaded.facts);
  const summary = summaryText(loaded.output, hyps, deps.mcp.truefoundryAvailable());
  const addSignals = investigationSignals(hyps, loaded.facts);
  await deps.store.writeHypotheses({ incidentId: incident.id, hypotheses: hyps, summary, addSignals, now: now().toISOString() });
}

// ---- pure helpers ------------------------------------------------------------

/** A source whose result we can ignore on failure (gather is degrade-not-fail). */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

const FACT_LABEL: Record<string, string> = {
  commit: 'GitHub commit',
  pr_diff: 'GitHub diff',
  datadog_trace: 'Datadog trace',
  datadog_log: 'Datadog logs',
  datadog_metric: 'Datadog metric',
  datadog_alert_event: 'Datadog alert',
  truefoundry_metric: 'TrueFoundry metric',
  truefoundry_log: 'TrueFoundry logs',
};

export function buildInvestigationMessages(incident: IncidentContext, facts: EvidenceFact[], truefoundryAvailable: boolean): { role: 'system' | 'user'; content: string }[] {
  const system =
    'You are Instrument, an SRE assistant performing a READ-ONLY incident investigation. ' +
    'Using ONLY the evidence provided, produce ranked root-cause hypotheses, most likely first. ' +
    'You never apply or propose that Instrument auto-applies a fix; you only explain and suggest a next step. ' +
    'Cite evidence by its exact key (e.g. "E1"). Do NOT invent evidence keys or facts. ' +
    'Set confidence "high" ONLY when the cited evidence strongly supports the cause; otherwise "likely" or "low". ' +
    'root_cause_type is one of: "code" (a code change Instrument could fix), "runtime_config" (config/infra/limits), "upstream" (a dependency/provider), or "unknown". ' +
    'When the cause is not a code defect, set instrument_can_fix=false and give a no_fix_reason plus a suggested_next_step. ' +
    'Output ONLY the JSON object — no preamble, no prose or heading before it, no commentary after it. ' +
    'Shape: {"summary": string, "hypotheses":[{"title","reasoning","confidence","root_cause_type","instrument_can_fix","evidence_keys":["E1"],"no_fix_reason","suggested_next_step"}]}.';

  const factLines = facts.length
    ? facts.map((f) => `${f.key} [${FACT_LABEL[f.sourceType] ?? f.sourceType}] ${f.title}: ${f.summary}${f.externalId ? ` (${f.externalId})` : ''}`).join('\n')
    : '(no corroborating evidence was collected)';
  const tfNote = truefoundryAvailable ? '' : '\nUnavailable sources: TrueFoundry model/MCP telemetry was not reachable for this investigation — do not assert facts about it.';

  const user =
    `Incident: ${incident.title}\n` +
    `Service: ${incident.serviceName ?? 'unknown'} (${incident.environment ?? 'production'})\n` +
    `Alert state: ${incident.alertState ?? 'firing'}\n` +
    (incident.description ? `Description: ${clamp(incident.description, 1000)}\n` : '') +
    (incident.traceId ? `trace_id: ${incident.traceId}\n` : '') +
    (incident.requestId ? `request_id: ${incident.requestId}\n` : '') +
    `\nEvidence:\n${factLines}\n${tfNote}\n\n` +
    'Rank up to 5 hypotheses as the specified JSON. Cite only the evidence keys above.';
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Deterministically turn the model's hypotheses into stored, evidence-backed ones:
 *  - resolve each cited key to a VERIFIED evidence id; drop keys that don't resolve
 *    (so a hallucinated/unavailable citation never reaches the UI as fact);
 *  - cap confidence to "likely" when a hypothesis has no verified evidence (no
 *    unsupported "Root cause"/high claims);
 *  - fold a no-code-fix explanation + suggested next step into `detail` for
 *    non-code / unfixable causes, so the existing UI surfaces it;
 *  - rank in model order; mark rank 1 leading.
 * If nothing usable survives, emit a single low-confidence "inconclusive" hypothesis
 * so a completed investigation always reads coherently.
 */
export function selectHypotheses(raw: InvestigationHypothesis[], facts: EvidenceFact[]): StoredHypothesis[] {
  const verifiedById = new Map(facts.filter((f) => f.verified).map((f) => [f.key.toUpperCase(), f.id]));
  const out: StoredHypothesis[] = [];
  raw.slice(0, MAX_HYPOTHESES).forEach((h, i) => {
    const ids = dedupe(
      (h.evidence_keys ?? [])
        .map((k) => verifiedById.get(String(k).trim().toUpperCase()))
        .filter((id): id is string => typeof id === 'string'),
    ).slice(0, MAX_EVIDENCE_IDS);

    // Careful confidence: "high" requires verified evidence; otherwise cap to "likely".
    let confidence = h.confidence;
    if (confidence === 'high' && ids.length === 0) confidence = 'likely';

    const canFix = h.instrument_can_fix === true && h.root_cause_type === 'code';
    const detail = composeDetail(h, canFix);
    out.push({
      rank: i + 1,
      leading: i === 0,
      summary: clamp(scrubSecrets(h.title), 200),
      detail,
      root_cause_type: h.root_cause_type,
      confidence,
      evidence_ids: ids,
      instrument_can_fix: canFix,
      no_fix_reason: !canFix && h.no_fix_reason ? clamp(scrubSecrets(h.no_fix_reason), 600) : null,
      suggested_next_step: h.suggested_next_step ? clamp(scrubSecrets(h.suggested_next_step), 600) : null,
    });
  });

  if (out.length === 0) {
    out.push({
      rank: 1,
      leading: true,
      summary: 'Inconclusive from the available evidence',
      detail: 'Instrument could not isolate a single cause from the collected signals. Review the alert, recent deploys, and logs, then re-run the investigation as more evidence becomes available.',
      root_cause_type: 'unknown',
      confidence: 'low',
      evidence_ids: [],
      instrument_can_fix: false,
      no_fix_reason: 'The evidence did not point to a specific code defect.',
      suggested_next_step: 'Inspect the linked alert and service logs, then retry the investigation.',
    });
  }
  return out;
}

/** detail = reasoning, with a folded no-code-fix explanation for non-code causes. */
function composeDetail(h: InvestigationHypothesis, canFix: boolean): string {
  let detail = clamp(scrubSecrets(h.reasoning), 1500);
  if (!canFix) {
    const reason = h.no_fix_reason ? scrubSecrets(h.no_fix_reason) : rootCauseExplanation(h.root_cause_type);
    const next = h.suggested_next_step ? scrubSecrets(h.suggested_next_step) : 'Hand off to the owning team for a configuration or upstream fix.';
    detail = clamp(`${detail} Instrument can't fix this automatically — ${reason} Suggested next step: ${next}`, 1900);
  }
  return detail;
}

function rootCauseExplanation(type: InvestigationHypothesis['root_cause_type']): string {
  switch (type) {
    case 'runtime_config':
      return 'the likely cause is runtime/configuration, not the codebase.';
    case 'upstream':
      return 'the likely cause is an upstream dependency or provider, outside this codebase.';
    default:
      return 'the cause could not be tied to a specific code change.';
  }
}

export function buildCorrelatedChanges(rows: { id: string; commit: CommitFact }[]): CorrelatedChange[] {
  return rows.slice(0, MAX_CORRELATED).map(({ id, commit }) => ({
    kind: 'commit' as const,
    ref: (commit.sha || '').slice(0, 12) || 'commit',
    summary: clamp(scrubSecrets(commit.message || 'Recent change'), 200),
    url: validUrl(commit.url),
    evidence_id: id,
  }));
}

/** Confidence → the leading-card label the UI shows (parity with rootTitle()). */
export function confidenceLabel(confidence: string | null | undefined): 'Root cause' | 'Leading hypothesis' {
  return confidence === 'high' ? 'Root cause' : 'Leading hypothesis';
}

function investigationSignals(hyps: StoredHypothesis[], facts: EvidenceFact[]): IncidentSignal[] {
  const leading = hyps.find((h) => h.leading) ?? hyps[0];
  const signals: IncidentSignal[] = [];
  if (leading) {
    signals.push({ key: 'leading_cause', label: confidenceLabel(leading.confidence), value: leading.summary });
  }
  const commits = facts.filter((f) => f.sourceType === 'commit').length;
  if (commits > 0) signals.push({ key: 'recent_commits', label: 'Recent commits', value: String(commits) });
  return signals;
}

function summaryText(output: InvestigationOutput, hyps: StoredHypothesis[], truefoundryAvailable: boolean): string {
  const leading = hyps.find((h) => h.leading) ?? hyps[0];
  const base = output.summary && output.summary.trim() ? scrubSecrets(output.summary) : leading ? leading.summary : 'Investigation complete.';
  const tf = truefoundryAvailable ? '' : ' TrueFoundry telemetry was unavailable for this investigation.';
  return clamp(`${base}${tf}`, 800);
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
function clamp(s: string, max: number): string {
  const t = (s ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
function validUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
