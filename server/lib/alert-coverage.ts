// Runtime-agnostic Datadog alert-coverage core (Task 9, slice 2). Pure TS: the
// model's alert-findings schema, the analysis prompt, deterministic metric→monitor
// coverage detection, and the rule that turns a (model-proposed, deterministically
// verified) finding into an `alert` recommendation row + step.
//
// Trust boundary: the MODEL proposes monitor specs and improvement diffs, but
// coverage ("which metrics already have a monitor") and metric verification
// ("does this metric exist in Datadog now") are computed here from the live
// metric/monitor reads — never taken on the model's word. A spec on an unverified,
// non-prerequisite metric is dropped (no creatable alert); a spec on an
// already-covered metric is dropped (no duplicate monitor); an improvement that
// names a monitor we didn't read is dropped (no phantom diff). The surviving
// new-monitor spec is written into the step's `proposed_payload`, which the slice-1
// `datadog_alert_generation` executor consumes after human approval.
import { sha256Hex } from './hash';
import { parseFindings } from './pr-review';
import { scrubSecrets } from './redaction';
import { schemaRegistry, z } from './schema-validation';
import {
  type DdMonitorSpec,
  type MetricVerification,
  canCreateAlert,
  metricVerification,
  parseMonitorSpec,
} from './datadog-alert';

export const ALERT_FINDINGS_SCHEMA_VERSION = 'alert_findings.v1';

/** One reviewable diff row for an existing-monitor improvement (UI shape). */
const diffRowSchema = z
  .object({
    k: z.string().trim().min(1).max(80),
    v: z.string().trim().max(200).nullish(),
    from: z.string().trim().max(200).nullish(),
    to: z.string().trim().max(200).nullish(),
  })
  .refine((r) => r.v != null || r.from != null || r.to != null, 'a diff row needs v, or from/to');

/**
 * One alert-coverage finding the model proposes — either a NEW monitor for an
 * uncovered metric, or an IMPROVEMENT to an existing monitor (rendered as a
 * read-only diff; Instrument never mutates existing monitors in this slice).
 * Per-finding leniency: a malformed finding is dropped, the batch is kept.
 */
export const alertFindingSchema = z.object({
  recommendation_type: z.enum(['new_monitor', 'monitor_improvement']),
  // Prose is OPTIONAL: the gateway model reliably emits the structured fields
  // (metric/query/monitor) but not always a title/rationale, so we synthesize
  // those from the structured fields when absent rather than dropping the finding.
  title: z.string().trim().min(1).max(200).optional(),
  rationale: z.string().trim().min(1).max(1200).optional(),
  // `.catch` coerces an off-vocab severity (e.g. "critical") to medium instead of failing.
  severity: z.enum(['low', 'medium', 'high']).catch('medium'),
  // --- new_monitor fields (the proposed monitor spec) ---
  metric_name: z.string().trim().max(200).nullish(),
  monitor_type: z.enum(['metric alert', 'query alert']).catch('metric alert').nullish(),
  query: z.string().trim().max(800).nullish(),
  message: z.string().trim().max(2000).nullish(),
  suggested_tags: z.array(z.string().trim().min(1).max(80)).max(20).nullish(),
  // The model's claim that this metric does not exist yet but would be added by a
  // code-instrumentation change. Only honoured (→ expected_after_step) when the
  // scan actually found instrumentation gaps; never enough on its own to create.
  needs_instrumentation_first: z.boolean().nullish(),
  // --- monitor_improvement fields (read-only diff) ---
  monitor_name: z.string().trim().max(200).nullish(),
  service: z.string().trim().max(120).nullish(),
  diff_rows: z.array(diffRowSchema).min(1).max(12).nullish(),
});
export type AlertFinding = z.infer<typeof alertFindingSchema>;

export const alertFindingsSchema = z.object({
  findings: z
    .array(z.unknown())
    .transform((arr) =>
      arr
        .slice(0, 50)
        .map((x) => alertFindingSchema.safeParse(x))
        .flatMap((r) => (r.success ? [r.data] : []))
        .slice(0, 20),
    ),
});
export type AlertFindings = z.infer<typeof alertFindingsSchema>;

schemaRegistry.register(ALERT_FINDINGS_SCHEMA_VERSION, alertFindingsSchema);

/**
 * Extract the {findings:[…]} object from model text. Reuses the scan/PR-review
 * extractor, which finds the first balanced `{…}` and so survives ```json code
 * fences and trailing prose (the gateway model wraps its JSON in a fence — a naive
 * JSON.parse on the raw text fails and marks the whole call invalid). Also coerces
 * a bare top-level array into {findings}.
 */
export function parseAlertFindings(text: string): unknown {
  // Strip a surrounding ```json fence so a bare top-level array can be detected.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence ? fence[1] : text).trim();
  if (body.startsWith('[')) {
    try {
      const arr = JSON.parse(body);
      if (Array.isArray(arr)) return { findings: arr };
    } catch {
      /* fall through to object extraction */
    }
  }
  // Otherwise extract the first balanced {…} (fence- and trailing-prose-safe).
  return parseFindings(body) ?? body;
}

// ---- deterministic coverage --------------------------------------------------

export interface MonitorSnapshot {
  id: number;
  name: string;
  /** The monitor's alert query — what we match metric names against for coverage. */
  query?: string | null;
  type?: string | null;
  message?: string | null;
}

export interface MetricCoverage {
  /** Metrics that an existing monitor's query already references. */
  covered: string[];
  /** Metrics with no monitor — the candidates for a new-monitor recommendation. */
  uncovered: string[];
}

/**
 * Check if the metric name is referenced in the query as a full token,
 * avoiding substring false positives (e.g. "instrument.job" matching "instrument.job.retry").
 */
export function isMetricInQuery(metric: string, query: string): boolean {
  const m = metric.toLowerCase();
  const q = query.toLowerCase();
  let idx = 0;
  while (true) {
    const i = q.indexOf(m, idx);
    if (i === -1) return false;
    const charBefore = i > 0 ? q[i - 1] : '';
    const beforeOk = !/[a-z0-9_.]/.test(charBefore);
    const rest = q.slice(i + m.length);
    const charAfter = rest[0] ?? '';
    // A trailing identifier/`.` means a DIFFERENT metric (e.g. `instrument.job` vs
    // `instrument.job.retry`) — UNLESS it's a Datadog rollup suffix on the SAME
    // metric (`metric.as_count()` / `.as_rate()`), which still references it.
    const afterOk = !/[a-z0-9_.]/.test(charAfter) || /^\.as_(count|rate)\b/.test(rest);
    if (beforeOk && afterOk) return true;
    idx = i + 1;
  }
}

/**
 * A metric is COVERED iff some existing monitor's query string references it.
 * Datadog monitor queries embed the metric verbatim (e.g.
 * `avg(last_5m):avg:instrument.job.retry{*} > 5`), so a substring match on the
 * metric name is a sound, deterministic coverage signal.
 */
export function metricCoverage(metrics: string[], monitors: MonitorSnapshot[]): MetricCoverage {
  const queries = monitors.map((m) => (m.query ?? '').toLowerCase());
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const metric of metrics) {
    (queries.some((q) => isMetricInQuery(metric, q)) ? covered : uncovered).push(metric);
  }
  return { covered, uncovered };
}

// ---- finding → recommendation rule -------------------------------------------

/** A stable per-(workspace) dedupe fingerprint so a recurring gap folds onto one rec. */
export function alertDedupeFingerprint(namespace: string, kind: 'monitor' | 'improve', key: string): string {
  const slug = sha256Hex(JSON.stringify(['alert', namespace.toLowerCase(), kind, key.toLowerCase()])).slice(0, 32);
  return `alert:${slug}`;
}

/** The recommendation step + row fields one verified finding produces. */
export interface AlertRecommendationUpsert {
  dedupeFingerprint: string;
  title: string;
  rationale: string;
  serviceName: string | null;
  proposedNextStep: string;
  severity: 'low' | 'medium' | 'high';
  step: Record<string, unknown>;
}

export interface SelectAlertInput {
  namespace: string;
  findings: AlertFinding[];
  /** Metric names that exist in Datadog right now (search_datadog_metrics). */
  liveMetrics: string[];
  /** Metric names already covered by an existing monitor (metricCoverage.covered). */
  coveredMetrics: string[];
  /** Existing monitors (for matching improvement targets by name). */
  existingMonitors: MonitorSnapshot[];
  /** Whether the originating scan found instrumentation gaps (gates expected_after_step). */
  hasInstrumentationGaps: boolean;
}

const NEW_MONITOR_STEP_KEY = 'create-monitor';
const IMPROVE_STEP_KEY = 'improve-monitor';

/**
 * Turn model findings into recommendation upserts, applying every deterministic
 * gate. Returns at most one upsert per distinct metric / monitor; callers upsert
 * each (dedupe_fingerprint makes it once-only across scans).
 */
export function selectAlertRecommendations(input: SelectAlertInput): AlertRecommendationUpsert[] {
  const live = new Set(input.liveMetrics.map((m) => m.toLowerCase()));
  const covered = new Set(input.coveredMetrics.map((m) => m.toLowerCase()));
  const monitorByName = new Map(input.existingMonitors.map((m) => [m.name.trim().toLowerCase(), m]));
  const out: AlertRecommendationUpsert[] = [];
  const seen = new Set<string>();

  for (const f of input.findings) {
    const upsert = f.recommendation_type === 'new_monitor' ? newMonitorUpsert(f, input, live, covered) : improvementUpsert(f, input, monitorByName);
    if (!upsert) continue;
    if (seen.has(upsert.dedupeFingerprint)) continue; // collapse duplicate findings within one batch
    seen.add(upsert.dedupeFingerprint);
    out.push(upsert);
  }
  return out;
}

function newMonitorUpsert(f: AlertFinding, input: SelectAlertInput, live: Set<string>, covered: Set<string>): AlertRecommendationUpsert | null {
  const spec = toMonitorSpec(f);
  if (!spec) return null; // not a well-formed monitor spec → drop
  // Query-consistency gate: the monitor's QUERY (what actually fires) must reference
  // the declared metric_name — otherwise verifying metric_name proves nothing about
  // the metric the created monitor would alert on (the model could declare a verified
  // metric but write a query over a different, unverified one).
  if (!isMetricInQuery(spec.metric_name, spec.query)) return null;
  const metricLc = spec.metric_name.toLowerCase();
  // Coverage gate: never propose a second monitor for a metric that already has one.
  if (covered.has(metricLc)) return null;
  // Verification gate (NOT model-trusted): exists-now → verified; else only
  // expected_after_step when the model flagged it AND the scan found real
  // instrumentation gaps; otherwise unverified → no creatable alert.
  const exists = live.has(metricLc);
  const prereqDone = !!f.needs_instrumentation_first && input.hasInstrumentationGaps;
  const verification: MetricVerification = metricVerification(exists, prereqDone);
  if (verification === 'unverified') return null; // unverified metric must not create an alert

  const creatable = canCreateAlert(verification); // true only for verified_in_datadog
  const title = f.title ?? `Add a Datadog monitor for ${spec.metric_name}`;
  const rationale = f.rationale ?? `${spec.metric_name} is emitted but has no monitor — alert when it breaches a threshold.`;
  const step: Record<string, unknown> = {
    key: NEW_MONITOR_STEP_KEY,
    order: 0,
    kind: 'datadog_new_monitor',
    state: creatable ? 'available' : 'locked',
    label: creatable ? 'Create draft monitor' : 'Draft monitor (after metric is instrumented)',
    target_provider: 'datadog',
    proposed_payload: spec,
    metric_verification_state: verification,
  };
  if (!creatable) step.waits_for = `the ${spec.metric_name} metric to be emitted by an instrumentation change`;

  return {
    dedupeFingerprint: alertDedupeFingerprint(input.namespace, 'monitor', spec.metric_name),
    title: scrubSecrets(title).slice(0, 200),
    rationale: scrubSecrets(rationale).slice(0, 1200),
    serviceName: f.service ? scrubSecrets(f.service).slice(0, 120) : null,
    proposedNextStep: creatable ? `Create a draft Datadog monitor on ${spec.metric_name}.` : `Instrument ${spec.metric_name}, then create a draft Datadog monitor.`,
    severity: f.severity,
    step,
  };
}

function improvementUpsert(f: AlertFinding, input: SelectAlertInput, monitorByName: Map<string, MonitorSnapshot>): AlertRecommendationUpsert | null {
  const name = (f.monitor_name ?? '').trim();
  if (!name || !f.diff_rows || f.diff_rows.length === 0) return null;
  // Phantom-diff gate: only improve a monitor we actually read.
  const monitor = monitorByName.get(name.toLowerCase());
  if (!monitor) return null;
  const rows = f.diff_rows.slice(0, 12).map((r) => ({
    k: scrubSecrets(r.k).slice(0, 80),
    ...(r.v != null ? { v: scrubSecrets(r.v).slice(0, 200) } : {}),
    ...(r.from != null ? { from: scrubSecrets(r.from).slice(0, 200) } : {}),
    ...(r.to != null ? { to: scrubSecrets(r.to).slice(0, 200) } : {}),
  }));
  const title = f.title ?? `Improve the "${monitor.name}" monitor`;
  const rationale = f.rationale ?? `Proposed configuration change to the "${monitor.name}" monitor.`;
  const step: Record<string, unknown> = {
    key: IMPROVE_STEP_KEY,
    order: 0,
    kind: 'datadog_monitor_change',
    // Read-only: improvements are manually reviewed/completed; Instrument does NOT
    // mutate existing monitors. No proposed_payload / approval / generation path.
    state: 'available',
    label: scrubSecrets(title).slice(0, 120),
    target_provider: 'datadog',
    configuration_diff: { monitor: monitor.name, rows },
  };
  return {
    dedupeFingerprint: alertDedupeFingerprint(input.namespace, 'improve', monitor.name),
    title: scrubSecrets(title).slice(0, 200),
    rationale: scrubSecrets(rationale).slice(0, 1200),
    serviceName: f.service ? scrubSecrets(f.service).slice(0, 120) : null,
    proposedNextStep: `Review the proposed change to "${monitor.name}" and apply it in Datadog.`,
    severity: f.severity,
    step,
  };
}

/** Build a DdMonitorSpec from a new_monitor finding (returns null if not well-formed). */
function toMonitorSpec(f: AlertFinding): DdMonitorSpec | null {
  if (!f.metric_name || !f.query) return null;
  return parseMonitorSpec({
    metric_name: scrubSecrets(f.metric_name),
    monitor_type: f.monitor_type ?? 'metric alert',
    name: scrubSecrets(f.title ?? `Monitor: ${f.metric_name}`),
    query: scrubSecrets(f.query),
    ...(f.message ? { message: scrubSecrets(f.message) } : {}),
    ...(f.suggested_tags ? { tags: f.suggested_tags.map((t) => scrubSecrets(t)) } : {}),
  });
}

// ---- analysis prompt ---------------------------------------------------------

export interface AlertCoverageContext {
  repoFullName: string;
  namespace: string;
  uncoveredMetrics: string[];
  coveredMetrics: string[];
  existingMonitors: MonitorSnapshot[];
  /** Titles of instrumentation gaps the scan found (context for expected_after_step). */
  instrumentationGaps: string[];
}

const SYSTEM_PROMPT =
  'You are Instrument, an observability engineer reviewing Datadog alert coverage for a service. ' +
  'You are given metrics that exist with NO monitor, metrics already covered, and the existing monitors. ' +
  'Propose only high-value alert recommendations of two kinds: ' +
  '(1) "new_monitor" — a monitor for an UNCOVERED metric. Provide metric_name (exactly one of the uncovered metrics), monitor_type ("metric alert"), query (a Datadog monitor query referencing that metric, e.g. "avg(last_5m):avg:METRIC{*} > N"), a short message, and severity. ' +
  'Set needs_instrumentation_first=true ONLY if the metric is not emitted yet and requires a code change first. ' +
  '(2) "monitor_improvement" — a concrete improvement to ONE existing monitor (by its exact monitor_name). Provide diff_rows describing the change as {k, from, to} (or {k, v} for context rows). These are reviewed by a human; do not propose new monitors here. ' +
  'For EVERY finding also include a short "title" and a one-sentence "rationale". ' +
  'Do NOT propose a monitor for an already-covered metric. Do NOT invent metrics or monitors not listed. If there is nothing high-value to add, return an empty findings array. ' +
  'Respond with ONLY a JSON object, no prose or code fences: {"findings":[{"recommendation_type","title","rationale", ...}]}.';

export function buildAlertCoverageMessages(ctx: AlertCoverageContext): { role: 'system' | 'user'; content: string }[] {
  const monitors = ctx.existingMonitors
    .slice(0, 25)
    .map((m) => `- ${m.name}${m.type ? ` [${m.type}]` : ''}: ${m.query ?? '(no query)'}`)
    .join('\n');
  const user =
    `Service namespace: ${ctx.namespace} (repository ${ctx.repoFullName})\n\n` +
    `UNCOVERED metrics (no monitor — candidates for new_monitor):\n${ctx.uncoveredMetrics.map((m) => `- ${m}`).join('\n') || '- (none)'}\n\n` +
    `Already-covered metrics (do NOT propose monitors for these):\n${ctx.coveredMetrics.map((m) => `- ${m}`).join('\n') || '- (none)'}\n\n` +
    `Existing monitors (candidates for monitor_improvement):\n${monitors || '- (none)'}\n\n` +
    `Recent instrumentation gaps the scan found:\n${ctx.instrumentationGaps.slice(0, 10).map((t) => `- ${t}`).join('\n') || '- (none)'}\n\n` +
    'Return the alert recommendations as the specified JSON. Empty findings if there is nothing high-value.';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}
