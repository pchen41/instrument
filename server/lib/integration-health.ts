// Integration health assessment (Task 5D).
//
// Maps observable facts about an integration — credential presence, MCP
// registration, recent provider/API failures, and telemetry submission failures
// — onto the `integrations.status` enum so the console can show why a provider is
// unhealthy. The diagnostics it returns (last_error_code/summary) are redacted:
// a status reason, never a raw provider body or token.
//
// Status precedence (most actionable first):
//   missing_credentials  — no usable credential; nothing else can be trusted.
//   rate_limited         — a recent failure is a rate-limit (transient, retrying).
//   degraded             — MCP not registered, recent non-rate-limit failures, or
//                          our own telemetry submission to this provider failing.
//   connected            — credentials present, registered, no recent failures.
//
// `disconnected` is a user/lifecycle state (the integration was removed) and is
// not inferred here. Runtime-agnostic pure TS.
import { scrubSecrets } from './redaction';

export type IntegrationStatus =
  | 'connected'
  | 'disconnected'
  | 'degraded'
  | 'rate_limited'
  | 'missing_credentials';

export interface RecentFailure {
  code?: string | null;
  summary?: string | null;
  /** Coarse class; 'rate_limit' drives the rate_limited status. */
  kind?: 'rate_limit' | 'auth' | 'other' | null;
  at?: string | null;
}

export interface HealthInput {
  /** A usable provider credential exists (secret present / token non-empty). */
  hasCredentials: boolean;
  /**
   * MCP registration state through the TrueFoundry MCP Gateway. `null` = not
   * applicable (e.g. a provider with no MCP server); only `false` degrades.
   */
  mcpRegistered?: boolean | null;
  /** Recent provider/API failures, most-recent first or any order. */
  recentFailures?: RecentFailure[];
  /** Our own retry/error telemetry submission to this provider is failing. */
  telemetrySubmissionFailed?: boolean;
  now: string;
}

export interface HealthResult {
  status: IntegrationStatus;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  checkedAt: string;
}

const RATE_LIMIT_CODE = /rate.?limit|429|too.?many.?requests/i;

function isRateLimit(f: RecentFailure): boolean {
  return f.kind === 'rate_limit' || (f.code != null && RATE_LIMIT_CODE.test(f.code)) || (f.summary != null && RATE_LIMIT_CODE.test(f.summary));
}

function mostRecent(failures: RecentFailure[]): RecentFailure | null {
  if (!failures.length) return null;
  // Prefer an explicit timestamp ordering; fall back to the first element.
  const withAt = failures.filter((f) => f.at);
  if (withAt.length === failures.length) {
    return [...failures].sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  }
  return failures[0];
}

export function assessIntegrationHealth(input: HealthInput): HealthResult {
  const failures = input.recentFailures ?? [];
  const latest = mostRecent(failures);
  const diag = {
    lastErrorCode: latest?.code ? latest.code : null,
    lastErrorSummary: latest?.summary ? scrubSecrets(latest.summary) : null,
    checkedAt: input.now,
  };

  if (!input.hasCredentials) {
    // No credential overrides any stale failure diagnostics: a rate-limit or
    // gateway error recorded earlier is moot (and likely a *consequence* of the
    // missing credential), so report the actionable cause directly.
    return {
      status: 'missing_credentials',
      lastErrorCode: 'missing_credentials',
      lastErrorSummary: 'No usable provider credential is configured.',
      checkedAt: input.now,
    };
  }

  if (failures.some(isRateLimit)) {
    const rl = failures.find(isRateLimit)!;
    return {
      status: 'rate_limited',
      lastErrorCode: rl.code ?? 'rate_limited',
      lastErrorSummary: rl.summary ? scrubSecrets(rl.summary) : 'The provider is rate limiting requests.',
      checkedAt: input.now,
    };
  }

  const degraded = input.mcpRegistered === false || failures.length > 0 || input.telemetrySubmissionFailed === true;
  if (degraded) {
    return {
      status: 'degraded',
      lastErrorCode: diag.lastErrorCode ?? (input.mcpRegistered === false ? 'mcp_unregistered' : input.telemetrySubmissionFailed ? 'telemetry_submit_failed' : 'provider_degraded'),
      lastErrorSummary:
        diag.lastErrorSummary ??
        (input.mcpRegistered === false
          ? 'The MCP server is not registered through the gateway.'
          : input.telemetrySubmissionFailed
            ? 'Reliability telemetry submission to this provider is failing.'
            : 'The integration is degraded.'),
      checkedAt: input.now,
    };
  }

  return { status: 'connected', lastErrorCode: null, lastErrorSummary: null, checkedAt: input.now };
}
