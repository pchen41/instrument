// Reliability retry/error telemetry (Task 5D).
//
// This is the *specific* reliability signal path: when a durable job retries or
// fails terminally, the worker emits a `telemetry_emissions` audit row AND a
// Datadog metric + event so a preconfigured reliability monitor can fire and
// create the validation incident. The broad app-instrumentation surface (logs,
// metrics, traces for every path) lives in instrumentation.ts; this file is only
// the two stable, Datadog-routable reliability signals named in the PRD/ERD:
//   - instrument.job.retry
//   - instrument.job.error
//
// Runtime-agnostic, network-free pure TS: the metric/event payloads, the routing
// tags, the idempotency key, and the submit orchestration are all built here and
// unit-tested; the actual Datadog HTTP POST + Postgres writes are injected as
// `DatadogSubmitter` / `EmissionStore` by the Deno edge (datadog-client.ts,
// telemetry-store.ts). Same core/edge split as the 5B/5C helpers.
import { sha256Hex } from './hash';
import type { ClassifiedError } from './retry';
import type { JobType } from './types';
import { scrubSecrets } from './redaction';

/** Stable Datadog metric/event names. PRD OBS-7 requires these exact names. */
export const METRIC_JOB_RETRY = 'instrument.job.retry';
export const METRIC_JOB_ERROR = 'instrument.job.error';

/**
 * job_type → stable, human-stable workflow name used as the Datadog `workflow`
 * tag. Kept separate from job_type (which is also a tag) so a workflow can be
 * renamed/regrouped without changing the enum, and so the reliability monitor
 * query reads naturally (`workflow:incident_investigation`).
 */
export const WORKFLOW_BY_JOB_TYPE: Record<JobType, string> = {
  github_pr_review_analysis: 'pr_review',
  proactive_scan: 'proactive_scan',
  recommendation_generation: 'recommendation_generation',
  datadog_alert_generation: 'monitor_draft',
  incident_investigation: 'incident_investigation',
  recommendation_pr_generation: 'recommendation_pr',
};

export function workflowFor(jobType: JobType): string {
  return WORKFLOW_BY_JOB_TYPE[jobType] ?? jobType;
}

/** Static deployment identity for every emission (service + environment tags). */
export interface TelemetryContext {
  service: string; // e.g. 'instrument'
  environment: string; // e.g. 'production'
}

/**
 * What the worker hands the emitter when an attempt resolves to retry/terminal.
 * Deliberately carries NO raw job id in any tag — job_id lives only in the
 * `telemetry_emissions` row (a real column), never in a Datadog tag (ERD: avoid
 * raw job IDs as Datadog metric tags; they explode cardinality and leak nothing
 * routable). trace/request IDs are the routable way back to TrueFoundry evidence.
 */
export interface JobFailureSignal {
  kind: 'retry' | 'error';
  workspaceId: string;
  jobId: string;
  jobType: JobType;
  attempt: number;
  error: ClassifiedError;
  /** integrations.id of the provider involved, when known. Row-only, not a tag. */
  integrationId?: string | null;
  /** Provider/source the failure came from (truefoundry/datadog/github/worker). */
  source?: string | null;
  traceId?: string | null;
  requestId?: string | null;
}

/** A built emission: the stored row fields + the Datadog metric/event payloads. */
export interface EmissionRecord {
  metricName: string;
  value: number;
  /** Full tag set persisted to telemetry_emissions.tags (incl. trace/request). */
  tags: Record<string, string>;
  /** Low-cardinality routing tags submitted with the Datadog metric. */
  routingTags: Record<string, string>;
  idempotencyKey: string;
  workspaceId: string;
  jobId: string;
  attemptNumber: number;
  integrationId: string | null;
  traceId: string | null;
  requestId: string | null;
  event: DatadogEvent;
}

export interface DatadogEvent {
  title: string;
  text: string;
  alertType: 'warning' | 'error';
  /** Datadog dedupes/threads events sharing an aggregation key. */
  aggregationKey: string;
  tags: string[];
}

/**
 * Datadog tag values: restricted charset, bounded length. Lowercased by default
 * (Datadog lowercases tag values server-side anyway). `preserveCase` is used for
 * the trace/request IDs on the event so the case-correct value is still legible
 * in the event payload — though the authoritative copy for the investigation
 * pivot is the case-preserved `telemetry_emissions.truefoundry_*_id` columns.
 */
export function sanitizeTagValue(v: string, opts?: { preserveCase?: boolean }): string {
  const base = opts?.preserveCase ? v : v.toLowerCase();
  const charset = opts?.preserveCase ? /[^A-Za-z0-9_\-./]/g : /[^a-z0-9_\-./]/g;
  return base.replace(charset, '_').slice(0, 200);
}

/** Render a `{k: v}` tag map as Datadog `k:value` strings, skipping empties. */
export function toDatadogTags(tags: Record<string, string>, preserveCaseKeys: string[] = []): string[] {
  const preserve = new Set(preserveCaseKeys);
  return Object.entries(tags)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}:${sanitizeTagValue(v, { preserveCase: preserve.has(k) })}`);
}

function compact(obj: Record<string, string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && v !== '') out[k] = v;
  }
  return out;
}

/**
 * Build the emission record for a retry/error signal. Pure: no IO, no clock —
 * the store stamps created_at/emitted_at. The idempotency key is
 * `${jobId}:attempt-${attempt}`: a given attempt resolves to exactly one of
 * retry/error, and metric_name is part of the table's unique key, so a re-run of
 * the same tick on the same attempt collapses onto the same row (no double-submit).
 */
export function buildEmission(ctx: TelemetryContext, signal: JobFailureSignal): EmissionRecord {
  const metricName = signal.kind === 'retry' ? METRIC_JOB_RETRY : METRIC_JOB_ERROR;
  const source = signal.source ?? signal.error.source ?? 'worker';

  // Low-cardinality routing tags: what the reliability monitor groups/filters by.
  // No job_id, no trace/request id here (those inflate custom-metric cardinality).
  const routingTags = compact({
    service: ctx.service,
    env: ctx.environment,
    workflow: workflowFor(signal.jobType),
    job_type: signal.jobType,
    integration: source,
    error_code: signal.error.code,
  });

  // Full tag set persisted to the audit row + attached to the (low-volume) event:
  // routing tags plus the trace/request IDs that lead back to TrueFoundry evidence.
  const tags = compact({
    ...routingTags,
    trace_id: signal.traceId ?? undefined,
    request_id: signal.requestId ?? undefined,
  });

  const verb = signal.kind === 'retry' ? 'retried' : 'failed';
  const event: DatadogEvent = {
    title: `Instrument job ${verb}: ${routingTags.workflow} (${signal.error.code})`,
    // The summary is already the engine's redacted failure text; scrub again
    // defensively so no provider token ever rides into a Datadog event body.
    text: scrubSecrets(
      `Workflow ${routingTags.workflow} ${verb} on attempt ${signal.attempt} ` +
        `(${signal.error.code}) from ${source}. ${signal.error.summary}`,
    ),
    alertType: signal.kind === 'retry' ? 'warning' : 'error',
    // Hash the job id so NO raw job id reaches Datadog in any field (not just
    // tags) while still threading events for the same job. The job_id stays a
    // real telemetry_emissions column for the local audit pivot.
    aggregationKey: `${metricName}:${sha256Hex(signal.jobId).slice(0, 16)}`,
    tags: toDatadogTags(tags, ['trace_id', 'request_id']),
  };

  return {
    metricName,
    value: 1,
    tags,
    routingTags,
    idempotencyKey: `${signal.jobId}:attempt-${signal.attempt}`,
    workspaceId: signal.workspaceId,
    jobId: signal.jobId,
    attemptNumber: signal.attempt,
    integrationId: signal.integrationId ?? null,
    traceId: signal.traceId ?? null,
    requestId: signal.requestId ?? null,
    event,
  };
}

// --- Submission orchestration (the unit under test for "submit once") ----------

/** Datadog HTTP surface. No-op/mock impl used when DATADOG_API_KEY is absent. */
export interface DatadogSubmitter {
  /** True when real Datadog config is present; false = local/mock sink. */
  enabled: boolean;
  submitMetric(name: string, value: number, tags: string[]): Promise<void>;
  submitEvent(event: DatadogEvent): Promise<void>;
}

/**
 * Persists the audit row and reports whether this idempotency key already
 * reached a terminal `succeeded` state (so we never re-submit to Datadog).
 */
export interface EmissionStore {
  /** Insert (or find existing) the telemetry_emissions row in `running` state. */
  reserve(rec: EmissionRecord): Promise<{ id: string; alreadySucceeded: boolean }>;
  /** Flip emission_state to succeeded/failed and stamp emitted_at on success. */
  finish(id: string, state: 'succeeded' | 'failed', emittedAt: string | null): Promise<void>;
}

export type EmissionOutcome = 'succeeded' | 'failed' | 'skipped_duplicate';

export interface EmitResult {
  outcome: EmissionOutcome;
  id: string;
  /** Redacted reason when outcome is 'failed' (never raw provider/HTTP detail). */
  error?: string;
  /** True when the no-op/mock sink handled it (no Datadog config). */
  mock?: boolean;
  /** Redacted reason the (best-effort) event failed even though the metric landed. */
  eventError?: string;
}

export interface EmitDeps {
  store: EmissionStore;
  datadog: DatadogSubmitter;
  now: () => Date;
}

/**
 * Emit one reliability signal end-to-end with idempotency:
 *   1. reserve the audit row (running). If the key already succeeded → skip
 *      Datadog entirely and report skipped_duplicate.
 *   2. submit the metric + event to Datadog (or the mock sink).
 *   3. finish the row succeeded (with emitted_at) or failed.
 *
 * Best-effort by contract: a telemetry failure must never break the job state
 * machine, so callers wrap this and ignore throws — but it also won't throw on a
 * Datadog error; it records `failed` and returns an outcome instead.
 */
export async function emitReliabilitySignal(
  deps: EmitDeps,
  ctx: TelemetryContext,
  signal: JobFailureSignal,
): Promise<EmitResult> {
  const rec = buildEmission(ctx, signal);
  const reserved = await deps.store.reserve(rec);
  if (reserved.alreadySucceeded) {
    return { outcome: 'skipped_duplicate', id: reserved.id };
  }

  // No Datadog config → the documented mock sink. Persist the audit row but leave
  // emitted_at NULL so a never-submitted row is provably distinct from a real us5
  // 2xx (a rotated/missing key must not silently look like a successful emission).
  if (!deps.datadog.enabled) {
    await deps.store.finish(reserved.id, 'succeeded', null);
    return { outcome: 'succeeded', id: reserved.id, mock: true };
  }

  // The metric is the monitor's threshold signal — its 2xx defines success. Fail
  // the emission only if the metric fails (nothing was sent → safe to retry).
  try {
    await deps.datadog.submitMetric(rec.metricName, rec.value, toDatadogTags(rec.routingTags));
  } catch (err) {
    await deps.store.finish(reserved.id, 'failed', null);
    return { outcome: 'failed', id: reserved.id, error: redactErr(err) };
  }

  // The event is best-effort human context. Once the metric has landed, an event
  // failure must NOT flip the row to `failed` — re-emitting the same attempt would
  // double-count the (already-delivered) metric. Record it on the result instead.
  let eventError: string | undefined;
  try {
    await deps.datadog.submitEvent(rec.event);
  } catch (err) {
    eventError = redactErr(err);
  }
  await deps.store.finish(reserved.id, 'succeeded', deps.now().toISOString());
  return eventError ? { outcome: 'succeeded', id: reserved.id, eventError } : { outcome: 'succeeded', id: reserved.id };
}

function redactErr(err: unknown): string {
  // Datadog client errors are pre-shaped (a short code); anything else collapses
  // to a generic string so an HTTP body / token can't ride into the result. Scrub
  // even the shaped code defensively in case a third-party error embeds a secret.
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return scrubSecrets(code);
  }
  return 'datadog_submit_failed';
}
