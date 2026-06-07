// Persists computed integration health to integrations.status (Task 5D, review
// fix). server/lib/integration-health.ts is the pure assessor; this is the IO
// edge that actually writes the row so the console reflects it. Best-effort: a
// health-write failure is logged (redacted code) and never thrown into the
// caller — health is a derived signal, not durable workflow state.
import { assessIntegrationHealth, type HealthResult } from '../../lib/integration-health.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

const KNOWN_PROVIDERS = new Set(['github', 'datadog', 'truefoundry']);

/** UPDATE one integration's status + last_error fields + last_checked_at. */
export async function writeIntegrationHealth(
  admin: Admin,
  opts: { workspaceId: string; integrationId?: string | null; provider?: string | null; result: HealthResult },
): Promise<void> {
  const db = admin.database;
  let id = opts.integrationId ?? null;
  if (!id && opts.provider && KNOWN_PROVIDERS.has(opts.provider)) {
    const { data } = await db
      .from('integrations')
      .select('id')
      .eq('workspace_id', opts.workspaceId)
      .eq('provider', opts.provider)
      .limit(1)
      .maybeSingle();
    id = (data?.id as string | undefined) ?? null;
  }
  if (!id) return;
  const { error } = await db
    .from('integrations')
    .update({
      status: opts.result.status,
      last_error_code: opts.result.lastErrorCode,
      last_error_summary: opts.result.lastErrorSummary,
      last_checked_at: opts.result.checkedAt,
    })
    .eq('id', id);
  if (error) {
    console.log(JSON.stringify({ source: 'instrument', kind: 'log', level: 'warn', name: 'integration_health.write_failed', attributes: { provider: opts.provider ?? null } }));
  }
}

/**
 * Reflect a provider-sourced job failure onto that provider's integration health,
 * computed from the (already-redacted) classified error. Failure-driven: it moves
 * a provider to rate_limited / degraded on a real failure; recovery to `connected`
 * is restored by the provider workflow tasks' success-path checks (6/7/9/11/12),
 * which have the live provider-call + MCP-registration context. No-op for the
 * engine's own 'worker' failures (not a provider).
 */
export async function reflectProviderFailure(
  admin: Admin,
  args: { workspaceId: string; integrationId?: string | null; provider?: string | null; code: string; summary: string; now: string },
): Promise<void> {
  if (!args.provider || !KNOWN_PROVIDERS.has(args.provider)) return;
  // assess from a single recent failure; isRateLimit/isAuth read the code.
  const result = assessIntegrationHealth({
    hasCredentials: true,
    recentFailures: [{ code: args.code, summary: args.summary, at: args.now }],
    now: args.now,
  });
  await writeIntegrationHealth(admin, { workspaceId: args.workspaceId, integrationId: args.integrationId, provider: args.provider, result });
}

/** Our own telemetry submission to Datadog failed → mark the datadog integration degraded. */
export async function reflectTelemetrySubmissionFailure(admin: Admin, workspaceId: string, now: string): Promise<void> {
  const result = assessIntegrationHealth({ hasCredentials: true, telemetrySubmissionFailed: true, now });
  await writeIntegrationHealth(admin, { workspaceId, provider: 'datadog', result });
}
