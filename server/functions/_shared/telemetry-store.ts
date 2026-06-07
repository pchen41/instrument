// PostgREST-backed telemetry_emissions store + the worker's reliability emitter
// (Task 5D). The pure orchestration (build emission, idempotency, submit-once)
// lives in server/lib/telemetry.ts; this is the IO edge: it writes the audit row,
// resolves the source integration_id, and composes the store with the Datadog
// client into the single `emitJobTelemetry` hook the worker tick injects.
//
// Idempotency rests on the table's unique (workspace_id, metric_name,
// idempotency_key): reserve() inserts a `running` row, and a duplicate insert
// (same attempt re-emitted) collapses onto the existing row — if that row already
// reached `succeeded`, we report it so the orchestrator skips Datadog entirely.
import {
  emitReliabilitySignal,
  type DatadogSubmitter,
  type EmissionRecord,
  type EmissionStore,
  type JobFailureSignal,
  type TelemetryContext,
} from '../../lib/telemetry.ts';
import { isUniqueViolation } from './agent-runtime.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

const KNOWN_PROVIDERS = new Set(['github', 'datadog', 'truefoundry']);

/** PostgREST EmissionStore over telemetry_emissions. */
export function createTelemetryStore(admin: Admin): EmissionStore {
  const db = admin.database;
  // (workspace, provider) → integration_id cache; '' marks a known miss.
  const integrationCache = new Map<string, string>();

  async function resolveIntegrationId(rec: EmissionRecord): Promise<string | null> {
    if (rec.integrationId) return rec.integrationId;
    const provider = rec.tags.integration;
    if (!provider || !KNOWN_PROVIDERS.has(provider)) return null;
    const cacheKey = `${rec.workspaceId}:${provider}`;
    const cached = integrationCache.get(cacheKey);
    if (cached !== undefined) return cached || null;
    const { data } = await db
      .from('integrations')
      .select('id')
      .eq('workspace_id', rec.workspaceId)
      .eq('provider', provider)
      .limit(1)
      .maybeSingle();
    const id = (data?.id as string | undefined) ?? '';
    integrationCache.set(cacheKey, id);
    return id || null;
  }

  return {
    async reserve(rec) {
      const integrationId = await resolveIntegrationId(rec);
      const insert = {
        workspace_id: rec.workspaceId,
        job_id: rec.jobId,
        attempt_number: rec.attemptNumber,
        integration_id: integrationId,
        metric_name: rec.metricName,
        tags: rec.tags,
        value: rec.value,
        truefoundry_trace_id: rec.traceId,
        truefoundry_request_id: rec.requestId,
        emission_state: 'running',
        idempotency_key: rec.idempotencyKey,
        created_at: new Date().toISOString(),
      };
      const { data, error } = await db.from('telemetry_emissions').insert([insert]).select('id');
      if (!error) {
        const id = (data as { id: string }[] | null)?.[0]?.id;
        if (id) return { id, alreadySucceeded: false };
        throw new Error('telemetry_emissions insert returned no id');
      }
      // Duplicate emission for this (workspace, metric, idempotency_key): the same
      // attempt was already emitted (e.g. a retried tick). Reuse the existing row
      // and report whether it already reached a terminal succeeded state.
      if (isUniqueViolation(error)) {
        const existing = await db
          .from('telemetry_emissions')
          .select('id, emission_state')
          .eq('workspace_id', rec.workspaceId)
          .eq('metric_name', rec.metricName)
          .eq('idempotency_key', rec.idempotencyKey)
          .limit(1)
          .maybeSingle();
        const id = existing.data?.id as string | undefined;
        if (id) return { id, alreadySucceeded: existing.data?.emission_state === 'succeeded' };
      }
      throw new Error('telemetry_emissions reserve failed');
    },

    async finish(id, state, emittedAt) {
      await db
        .from('telemetry_emissions')
        .update({ emission_state: state, emitted_at: emittedAt })
        .eq('id', id);
    },
  };
}

/**
 * Build the worker's `emitJobTelemetry` hook: store + Datadog client + the
 * deployment's service/environment context. Best-effort end-to-end — a store or
 * Datadog failure is recorded (emission_state) or swallowed, never thrown back
 * into the job state machine (the worker also wraps this defensively).
 */
export function createJobTelemetryEmitter(
  admin: Admin,
  datadog: DatadogSubmitter & { service: string; environment: string },
): (signal: JobFailureSignal) => Promise<void> {
  const store = createTelemetryStore(admin);
  const ctx: TelemetryContext = { service: datadog.service, environment: datadog.environment };
  return async (signal) => {
    try {
      await emitReliabilitySignal({ store, datadog, now: () => new Date() }, ctx, signal);
    } catch (err) {
      // reserve/finish DB errors land here; log a code, never the row/secret.
      console.log(JSON.stringify({ source: 'instrument', kind: 'log', level: 'warn', name: 'telemetry.emit_failed', attributes: { metric: signal.kind === 'retry' ? 'instrument.job.retry' : 'instrument.job.error' } }));
    }
  };
}
