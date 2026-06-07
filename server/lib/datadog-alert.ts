// Runtime-agnostic Datadog draft-alert core (Task 9). Pure TS: the approved
// monitor-spec schema, metric-verification rule, deterministic monitor marker
// tag + external_write idempotency key, and the draft (non-notifying) monitor
// payload builder. Creation is approval-gated like Task 8 PR generation: the
// single Datadog write carries the approval's approved_payload_hash as its
// request_hash, and the executor verifies the approval is approved before writing.
import { sha256Hex } from './hash';
import { scrubSecrets } from './redaction';
import { schemaRegistry, z } from './schema-validation';

export const DD_MONITOR_SPEC_VERSION = 'datadog_monitor_spec.v1';

// The approved monitor definition (set on the recommendation step by the analysis
// phase, hashed into the approval). Lenient on the type enum so an off-vocab value
// degrades to a metric alert rather than failing the whole spec.
export const ddMonitorSpecSchema = z.object({
  // The single metric the monitor alerts on — must exist in Datadog (verified) or
  // be added by a completed prerequisite step (expected_after_step). Never create
  // an alert on an unverified metric.
  metric_name: z.string().trim().min(1).max(200),
  monitor_type: z.enum(['metric alert', 'query alert']).catch('metric alert'),
  name: z.string().trim().min(1).max(200),
  // e.g. "avg(last_5m):avg:instrument.job.retry{*} > 5"
  query: z.string().trim().min(1).max(800),
  message: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
});
export type DdMonitorSpec = z.infer<typeof ddMonitorSpecSchema>;

schemaRegistry.register(DD_MONITOR_SPEC_VERSION, ddMonitorSpecSchema);

/** Validate a stored monitor spec (from the rec step's proposed_payload). */
export function parseMonitorSpec(value: unknown): DdMonitorSpec | null {
  const r = ddMonitorSpecSchema.safeParse(value);
  return r.success ? r.data : null;
}

// ---- metric verification (ERD vocab: metric_existence_state) -----------------

export type MetricVerification = 'verified_in_datadog' | 'expected_after_step' | 'unverified';

/**
 * `verified_in_datadog` when the metric exists now; `expected_after_step` only
 * when a completed prerequisite instrumentation step would have added it; else
 * `unverified` (which must NOT produce a creatable alert).
 */
export function metricVerification(metricExists: boolean, prerequisiteStepDone: boolean): MetricVerification {
  if (metricExists) return 'verified_in_datadog';
  if (prerequisiteStepDone) return 'expected_after_step';
  return 'unverified';
}

/** A creatable alert requires the metric to exist now (not merely expected). */
export function canCreateAlert(v: MetricVerification): boolean {
  return v === 'verified_in_datadog';
}

// ---- draft monitor payload ---------------------------------------------------

export const DRAFT_MARKER = '[instrument:draft]';

/**
 * Deterministic Datadog tag marking the monitor as Instrument-owned for THIS
 * recommendation step — used to recover the monitor id on a retry that crashed
 * between create and recording (the Task 8 findOpenPrForBranch analogue).
 */
export function monitorMarkerTag(recommendationId: string, stepKey: string | null): string {
  return `instrument_rec:${sha256Hex(`${recommendationId}:${stepKey ?? ''}`).slice(0, 12)}`;
}

/** external_write_actions idempotency key for the single draft-monitor write. */
export function monitorWriteKey(recommendationId: string, stepKey: string | null): string {
  return `datadog_create_monitor:${recommendationId}:${stepKey ?? ''}`;
}

export interface DraftMonitorPayload {
  name: string;
  type: string;
  query: string;
  message: string;
  tags: string[];
  options: Record<string, unknown>;
}

/**
 * Build the `create_datadog_monitor` arguments for a DRAFT monitor: the message
 * carries NO @-mentions, so Datadog creates it without any notification routing
 * (the first-slice "draft" contract). Tagged with the deterministic marker plus
 * `source:instrument` + `instrument:draft` so it's recoverable and clearly owned.
 */
export function buildDraftMonitor(spec: DdMonitorSpec, recommendationTitle: string, recommendationId: string, stepKey: string | null): DraftMonitorPayload {
  const marker = monitorMarkerTag(recommendationId, stepKey);
  // System/marker tags FIRST so the 20-tag cap can never slice off the marker
  // (which findMonitorByTag relies on for crash-resume) or the draft/ownership labels.
  const required = ['source:instrument', 'instrument:draft', marker];
  const userTags = (spec.tags ?? []).filter((t) => !required.includes(t));
  const tags = Array.from(new Set([...required, ...userTags])).slice(0, 20);
  // The draft contract is "Instrument adds NO notification routing". Datadog routes
  // on @handles in the message, so neutralize any @ in analyst-supplied text — a
  // draft must never page anyone, even if the spec message contains an @-mention.
  const analystMessage = spec.message ? noMentions(scrubSecrets(spec.message)).slice(0, 1200) : undefined;
  const message = [
    DRAFT_MARKER,
    `Draft monitor proposed by Instrument for the recommendation: ${noMentions(scrubSecrets(recommendationTitle)).slice(0, 200)}.`,
    'It has no notification routing and will not page anyone until a human publishes it.',
    analystMessage ? '' : undefined,
    analystMessage,
  ]
    .filter((l): l is string => typeof l === 'string')
    .join('\n');
  return {
    name: scrubSecrets(spec.name).slice(0, 200),
    type: spec.monitor_type,
    query: spec.query,
    message,
    tags,
    // Conservative defaults: don't alert on missing data and require a clear
    // recovery window — a reviewer tunes these before publishing.
    options: { notify_no_data: false, renotify_interval: 0, thresholds: extractThresholds(spec.query) },
  };
}

/** Neutralize Datadog @-mention routing tokens so a draft message can never page. */
function noMentions(text: string): string {
  return text.replace(/@/g, '[at]');
}

/** Best-effort parse of a trailing comparison in the query into Datadog thresholds. */
function extractThresholds(query: string): Record<string, number> {
  const m = /([<>]=?)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(query.trim());
  if (!m) return {};
  const n = Number(m[2]);
  return Number.isFinite(n) ? { critical: n } : {};
}
