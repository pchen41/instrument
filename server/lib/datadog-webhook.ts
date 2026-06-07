// Runtime-agnostic Datadog webhook core (Task 10). Pure TS: parse the template-
// driven minimum JSON contract (docs/ERD.md "Datadog" section), authenticate the
// shared-secret header (constant-time), synthesize the delivery / correlation /
// transition keys, map the alert transition to an alert_state, decide the
// investigation-start behaviour deterministically (manual/auto/smart) from
// PRE-investigation metadata only, and build the bounded, secret-free incident
// snapshot (alert_payload_summary + signals + a timeline entry). Every side effect
// (DB, secret read) is injected by the Deno handler; this module is all decisions.
import { sha256Hex } from './hash';
import { scrubSecrets } from './redaction';

// ---- shared-secret authentication --------------------------------------------

/**
 * Constant-time comparison of the configured secret to the value Datadog sends in
 * its custom header. Hash BOTH sides to a fixed 64-hex-char digest first so the
 * compare length doesn't leak the secret length and a mismatched length still runs
 * the full compare. Empty/absent header → false (fail closed).
 */
export function verifyWebhookSecret(configuredSecret: string | null | undefined, provided: string | null | undefined): boolean {
  if (!configuredSecret || !provided) return false;
  const a = sha256Hex(configuredSecret);
  const b = sha256Hex(provided);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The custom header the configured Datadog webhook template must send. */
export const DATADOG_WEBHOOK_TOKEN_HEADER = 'x-instrument-webhook-token';

// ---- the minimum JSON contract -----------------------------------------------

export interface DatadogAlert {
  alertId: string | null;
  alertCycleKey: string | null;
  transition: string | null; // raw $ALERT_TRANSITION (e.g. "Triggered", "Recovered")
  eventId: string | null;
  eventUrl: string | null;
  title: string;
  message: string | null;
  eventType: string | null;
  /** Alert start (epoch ms or ISO) → ISO. Display value; may fall back to now. */
  date: string | null;
  lastUpdated: string | null;
  /** Raw payload-supplied timestamp used ONLY for stable key synthesis — never the
   *  server clock, so a replay that omits the timestamp still dedupes ('' sentinel). */
  keyStamp: string;
  tags: Record<string, string>;
  service: string | null;
  environment: string;
  reliability: string | null; // instrument_reliability tag value
  traceId: string | null;
  requestId: string | null;
}

const str = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() ? v.trim() : null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};

/**
 * Parse Datadog's $TAGS rendering into a map. Datadog renders tags as a comma- or
 * space-separated list of `key:value` (e.g. "service:web, env:production"); bare
 * tags (no colon) map to "true".
 */
export function parseTags(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(',') : '';
  for (const part of text.split(/[,\s]+/)) {
    const t = part.trim();
    if (!t || t === '[]') continue;
    const i = t.indexOf(':');
    const key = (i >= 0 ? t.slice(0, i) : t).trim().toLowerCase();
    const val = i >= 0 ? t.slice(i + 1).trim() : 'true';
    if (key) out[key] = val;
  }
  return out;
}

/** Coerce a Datadog $DATE/$LAST_UPDATED (epoch ms, epoch s, or ISO) to an ISO string. */
export function toIso(v: unknown, fallback: string): string {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && /^\d+$/.test(v.trim())) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback;
}

const UNRESOLVED = '$';

/** A template variable Datadog left unrendered (e.g. "$TAGS[trace_id]") is treated as absent. */
function rendered(v: string | null): string | null {
  return v && !v.includes(UNRESOLVED) ? v : null;
}

/** Scrub + length-cap any model/provider string before it is persisted or keyed. */
const clean = (v: string | null, n: number): string | null => (v ? scrubSecrets(v).slice(0, n) : null);

export function parseDatadogAlert(payload: Record<string, unknown>, nowIso: string): DatadogAlert {
  const tags = parseTags(payload.tags);
  const service = clean(rendered(str(payload.service)) ?? tags.service ?? null, 120);
  const env = clean(rendered(str(payload.env)) ?? tags.env ?? 'production', 60) ?? 'production';
  const reliability = rendered(str(payload.instrument_reliability)) ?? tags.instrument_reliability ?? null;
  const traceId = clean(rendered(str(payload.trace_id)) ?? tags.trace_id ?? null, 120);
  const requestId = clean(rendered(str(payload.request_id)) ?? tags.request_id ?? null, 120);
  const date = toIso(payload.date, nowIso);
  // Stable key timestamp from the RAW payload only (never the now-fallback), so an
  // exact replay produces an identical delivery id even if it omits $DATE.
  const keyStamp = rendered(str(payload.last_updated)) ?? rendered(str(payload.date)) ?? '';
  return {
    alertId: clean(rendered(str(payload.alert_id)), 120),
    alertCycleKey: clean(rendered(str(payload.alert_cycle_key)), 160),
    transition: rendered(str(payload.alert_transition)),
    eventId: clean(rendered(str(payload.event_id)), 120),
    eventUrl: clean(rendered(str(payload.event_url)), 500),
    title: clean(rendered(str(payload.event_title)), 300) ?? 'Datadog alert',
    message: payload.event_msg != null ? clean(str(payload.event_msg), 2000) : null,
    eventType: clean(rendered(str(payload.event_type)), 80),
    date,
    lastUpdated: payload.last_updated != null ? toIso(payload.last_updated, date) : date,
    keyStamp,
    tags,
    service,
    environment: env,
    reliability,
    traceId,
    requestId,
  };
}

// ---- transition → alert_state ------------------------------------------------

export type AlertState = 'firing' | 'resolved';

/**
 * `Recovered` (case-insensitive) → resolved. Every other first-slice transition
 * (Triggered, Re-Triggered, Warn, No Data, Renotify, …) and an absent transition
 * → firing. Recovery is the ONLY resolving signal in the first slice.
 */
export function mapAlertState(transition: string | null): AlertState {
  return (transition ?? '').trim().toLowerCase() === 'recovered' ? 'resolved' : 'firing';
}

// ---- synthesized keys --------------------------------------------------------

/**
 * Stable subject key for the alert cycle: `alert_cycle_key` when Datadog provides
 * it, else monitor id + service/env scope. This is the incident_correlation_key
 * (one open incident per cycle) and the inbound provider_correlation_key.
 */
export function incidentCorrelationKey(alert: DatadogAlert): string {
  if (alert.alertCycleKey) return `dd:${alert.alertCycleKey}`.slice(0, 200);
  const scope = [alert.alertId ?? 'monitor', alert.service ?? 'service', alert.environment].join(':');
  return `dd:${scope}`.slice(0, 200);
}

/** Per-transition dedupe key — one logical state change of the cycle. Uses the raw
 *  payload-supplied keyStamp (not the now-fallback) so replays are stable. */
export function alertTransitionKey(alert: DatadogAlert): string {
  const base = incidentCorrelationKey(alert);
  return `${base}:${(alert.transition ?? 'unknown').toLowerCase()}:${alert.keyStamp}`.slice(0, 260);
}

/**
 * Synthesized inbound delivery id (Datadog sends no GitHub-style UUID): cycle key
 * + transition + timestamp, hashed to a bounded token. Identical re-deliveries of
 * the SAME transition collapse on the (provider, external_delivery_id) unique index.
 */
export function externalDeliveryId(alert: DatadogAlert): string {
  return `dd:${sha256Hex(alertTransitionKey(alert)).slice(0, 40)}`;
}

// ---- investigation-start decision (PRE-investigation only) -------------------

export type InvestigationStartMode = 'manual' | 'auto' | 'smart';

export interface SmartStartRules {
  /** Tag whose truthy value marks a reliability alert (default `instrument_reliability`). */
  reliability_tag?: string;
  /** Datadog monitor/alert ids that always auto-start. */
  monitor_ids?: string[];
  /** Case-insensitive title/message keywords that auto-start. */
  title_keywords?: string[];
}

const TRUTHY = new Set(['true', '1', 'yes', 'on']);

/**
 * SMART rule — deterministic and computed from PRE-investigation metadata only
 * (monitor identity, tags, configured rules), never a post-investigation confidence
 * score. Defaults (empty rules) treat an `instrument_reliability` truthy tag as the
 * auto-start signal — the TrueFoundry reliability monitor (Task 12).
 */
export function smartShouldStart(alert: DatadogAlert, rules: SmartStartRules = {}): boolean {
  // Coerce defensively — a malformed admin `smart_start_rules` must NEVER throw,
  // since the decision runs before incident creation (a throw would block ALL
  // incident creation in smart mode).
  const r = (rules ?? {}) as SmartStartRules;
  const tagName = typeof r.reliability_tag === 'string' && r.reliability_tag ? r.reliability_tag : 'instrument_reliability';
  // Look the configured tag up directly; for the default tag also accept the
  // explicit instrument_reliability field. (A custom tag is honoured even if a
  // separate instrument_reliability tag is present-but-false.)
  const tagVal = String(alert.tags[tagName] ?? (tagName === 'instrument_reliability' ? alert.reliability ?? '' : '')).toLowerCase();
  if (TRUTHY.has(tagVal)) return true;
  const monitorIds = Array.isArray(r.monitor_ids) ? r.monitor_ids.map((x) => String(x)) : [];
  if (alert.alertId && monitorIds.includes(alert.alertId)) return true;
  const keywords = Array.isArray(r.title_keywords) ? r.title_keywords.map((x) => String(x)) : [];
  const hay = `${alert.title} ${alert.message ?? ''}`.toLowerCase();
  if (keywords.some((k) => k && hay.includes(k.toLowerCase()))) return true;
  return false;
}

export interface StartDecision {
  start: boolean;
  automatic: boolean;
  reason: string;
}

/**
 * Decide whether to enqueue an investigation for a FIRING alert. manual → never;
 * auto → always; smart → only reliability/clear-cut alerts. Resolved alerts never
 * start. `automatic` marks `incidents.started_automatically`.
 */
export function decideInvestigationStart(mode: InvestigationStartMode, state: AlertState, alert: DatadogAlert, rules: SmartStartRules = {}): StartDecision {
  if (state !== 'firing') return { start: false, automatic: false, reason: 'not_firing' };
  if (mode === 'manual') return { start: false, automatic: false, reason: 'manual_mode' };
  if (mode === 'auto') return { start: true, automatic: true, reason: 'auto_mode' };
  return smartShouldStart(alert, rules)
    ? { start: true, automatic: true, reason: 'smart_reliability_match' }
    : { start: false, automatic: false, reason: 'smart_no_match' };
}

// ---- bounded snapshots -------------------------------------------------------

/** Bounded, secret-free Datadog snapshot for `incidents.alert_payload_summary`. */
export function buildAlertPayloadSummary(alert: DatadogAlert): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    monitor_id: alert.alertId,
    transition: alert.transition,
    event_type: alert.eventType,
    event_url: alert.eventUrl,
    event_id: alert.eventId,
    service: alert.service,
    env: alert.environment,
    tags: boundedTags(alert.tags),
  };
  if (alert.message) summary.message = alert.message.slice(0, 600);
  if (alert.traceId) summary.trace_id = alert.traceId;
  if (alert.requestId) summary.request_id = alert.requestId;
  if (alert.reliability) summary.instrument_reliability = alert.reliability;
  return summary;
}

/** Cap the tag map so a runaway $TAGS can't bloat the row. */
function boundedTags(tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(tags)) {
    if (n++ >= 30) break;
    out[k.slice(0, 60)] = scrubSecrets(v).slice(0, 120);
  }
  return out;
}

/**
 * Key signals for the incident card. trace_id / request_id are surfaced as signals
 * (not just buried in the payload) so the Task 11 investigation can pick them up to
 * find Datadog/TrueFoundry evidence.
 */
export function buildSignals(alert: DatadogAlert): { key: string; label: string; value: string }[] {
  const signals: { key: string; label: string; value: string }[] = [];
  if (alert.alertId) signals.push({ key: 'monitor', label: 'monitor', value: alert.alertId });
  if (alert.service) signals.push({ key: 'service', label: 'service', value: alert.service });
  if (alert.traceId) signals.push({ key: 'trace_id', label: 'trace', value: alert.traceId.slice(0, 80) });
  if (alert.requestId) signals.push({ key: 'request_id', label: 'request', value: alert.requestId.slice(0, 80) });
  return signals;
}

/** One ordered timeline entry for an alert transition. */
export function buildTimelineEntry(alert: DatadogAlert, state: AlertState, at: string): { at: string; kind: string; title: string; detail?: string } {
  if (state === 'resolved') {
    return { at, kind: 'recovery', title: 'Datadog alert recovered', detail: alert.service ? `${alert.service} recovered.` : undefined };
  }
  return {
    at,
    kind: 'alert',
    title: 'Datadog monitor fired',
    detail: scrubSecrets(alert.message ?? alert.title).slice(0, 300) || undefined,
  };
}

/** Bounded, redacted header map for inbound_webhooks (never the secret token). */
export function redactedDatadogHeaders(get: (name: string) => string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const h of ['content-type', 'user-agent', 'x-datadog-trace-id']) {
    const v = get(h);
    if (v) out[h] = v.slice(0, 200);
  }
  out[DATADOG_WEBHOOK_TOKEN_HEADER] = '[redacted]';
  return out;
}

/** Bounded, secret-free payload snapshot for inbound_webhooks.payload_redacted. */
export function boundedDatadogPayload(alert: DatadogAlert): Record<string, unknown> {
  return {
    alert_id: alert.alertId,
    alert_cycle_key: alert.alertCycleKey,
    alert_transition: alert.transition,
    event_type: alert.eventType,
    event_url: alert.eventUrl,
    service: alert.service,
    env: alert.environment,
    title: alert.title,
    tags: boundedTags(alert.tags),
    has_trace_id: !!alert.traceId,
    has_request_id: !!alert.requestId,
  };
}
