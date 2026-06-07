// Scheduled worker tick (Task 5A engine / Task 5B runtime probe). An InsForge
// schedule invokes this ~every minute, and console-actions pokes it
// opportunistically right after enqueueing a job. Each tick claims a bounded
// batch of due/abandoned jobs under an atomic lease, advances their phases, and
// requeues anything that needs another pass — so progress survives restarts and
// duplicate invocations.
//
// Task 5B: when a claimed job is flagged `trigger_summary.mode === 'viability'`,
// the injected executor runs a real TrueFoundry gateway turn / scripted MCP tool
// call per phase with idempotent persistence; `maxPhasesPerTick` (from the POST
// body) bounds phases per invocation so resume across scheduled ticks can be
// measured. The executor is a no-op for the seeded/simulated 5A jobs.
//
// Deployed as a single bundled file (see scripts/build-functions.mjs); the
// `npm:` + `node:` imports are resolved by the Deno runtime, everything else is
// bundled from server/lib + _shared.
import { createAdminClient } from 'npm:@insforge/sdk';
import { json, preflight } from '../_shared/http.ts';
import { createPgDb } from '../_shared/pgdb.ts';
import { createGateway, createScriptedToolHost, createWorkStore } from '../_shared/agent-runtime.ts';
import { createDatadogClient } from '../_shared/datadog-client.ts';
import { createJobTelemetryEmitter } from '../_shared/telemetry-store.ts';
import { makeInvestigationExecutor } from '../../lib/agent.ts';
import { runTick } from '../../lib/worker.ts';
import { createConsoleSink, createInstrumentation } from '../../lib/instrumentation.ts';
import { systemClock } from '../../lib/time.ts';

// deno-lint-ignore no-explicit-any
declare const Deno: any;

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();

  // Shared-secret gate so only the schedule can drive work. Fails CLOSED: if the
  // secret is unset (misconfig) every request is rejected rather than left open.
  const secret = Deno.env.get('WORKER_TICK_SECRET');
  if (!secret || req.headers.get('x-worker-secret') !== secret) {
    return json({ error: 'unauthorized' }, 401);
  }

  const baseUrl = Deno.env.get('INSFORGE_BASE_URL');
  const apiKey = Deno.env.get('API_KEY');
  if (!baseUrl || !apiKey) return json({ error: 'server_misconfigured' }, 500);

  // Optional tuning from the POST body (the cron sends none → 5A defaults).
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  // Only a positive integer bounds phases; anything else (incl. 0) is unbounded.
  const rawMax = body.maxPhasesPerTick;
  const maxPhasesPerTick = typeof rawMax === 'number' && Number.isInteger(rawMax) && rawMax > 0 ? rawMax : undefined;
  const phaseDelayMs = typeof body.phaseDelayMs === 'number' && body.phaseDelayMs >= 0 ? body.phaseDelayMs : 120;

  const admin = createAdminClient({ baseUrl, apiKey });
  const db = createPgDb(admin);

  // Real per-phase work for viability jobs; the executor no-ops for every other
  // job, and a viability job in a workspace with no TrueFoundry integration fails
  // explicitly inside the store (rather than silently running the simulated path).
  const executePhase = makeInvestigationExecutor({
    gateway: createGateway(),
    tools: createScriptedToolHost(),
    store: createWorkStore(admin),
  });

  // Task 5D: reliability emitter (Datadog metric+event + telemetry_emissions) and
  // broad worker instrumentation. The Datadog client is a mock sink when
  // DATADOG_API_KEY is unset, so a credential-free tick still records audit rows.
  const datadog = createDatadogClient();
  const emitJobTelemetry = createJobTelemetryEmitter(admin, datadog);
  const instrument = createInstrumentation(
    { service: datadog.service, environment: datadog.environment, enabled: true },
    createConsoleSink(),
  ).child({ path: 'worker' });

  try {
    const endSpan = instrument.span('worker.tick', { datadog: datadog.enabled });
    const result = await runTick(db, {
      workerId: `tick-${crypto.randomUUID()}`,
      clock: systemClock,
      maxJobs: 5,
      phaseDelayMs,
      maxPhasesPerTick,
      executePhase,
      emitJobTelemetry,
    });
    endSpan({ ...result });
    instrument.metric('instrument.worker.tick.claimed', result.claimed, { retrying: result.retrying, failed: result.failed });
    return json({ ok: true, ...result });
  } catch {
    // Never echo a raw error (it can carry provider/internal detail) to the
    // caller; the platform captures the real message in server logs.
    return json({ ok: false, error: 'worker_error' }, 500);
  }
}
