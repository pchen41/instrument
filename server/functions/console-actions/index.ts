// Authenticated mutation endpoint for the console (Task 5A). Browser RLS is
// select-only, so every user-triggered write — start/retry an investigation,
// dismiss/restore a recommendation, change the investigation-start setting, and
// the approval + generation-enqueue flow — funnels through here. The caller's
// session token is validated, then membership / transition / idempotency /
// payload-hash are enforced in server/lib/actions before any privileged write.
import { createAdminClient, createClient } from 'npm:@insforge/sdk';
import { json, preflight } from '../_shared/http.ts';
import { createPgDb } from '../_shared/pgdb.ts';
import { ActionError, handleAction } from '../../lib/actions.ts';
import { createDatadogClient } from '../_shared/datadog-client.ts';
import { createJobTelemetryEmitter } from '../_shared/telemetry-store.ts';
import { runTick } from '../../lib/worker.ts';
import { createConsoleSink, createInstrumentation } from '../../lib/instrumentation.ts';
import { systemClock } from '../../lib/time.ts';

// deno-lint-ignore no-explicit-any
declare const Deno: any;

// Actions that enqueue a durable job — we run a worker tick inline so the console
// sees progress immediately instead of waiting for the next cron tick.
const ENQUEUES = new Set(['start_investigation', 'retry_job', 'enqueue_generation']);

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const baseUrl = Deno.env.get('INSFORGE_BASE_URL');
  const apiKey = Deno.env.get('API_KEY');
  const anonKey = Deno.env.get('ANON_KEY');
  if (!baseUrl || !apiKey) return json({ error: 'server_misconfigured' }, 500);

  // Validate the caller's session and resolve their user id.
  const userToken = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!userToken) return json({ error: 'unauthorized' }, 401);
  const userClient = createClient({ baseUrl, anonKey, edgeFunctionToken: userToken });
  let userId: string | undefined;
  try {
    const who = await userClient.auth.getCurrentUser();
    userId = who?.data?.user?.id ?? who?.data?.id;
  } catch {
    /* fall through to 401 */
  }
  if (!userId) return json({ error: 'unauthorized' }, 401);

  let body: { action?: string } | null = null;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }
  if (!body?.action) return json({ error: 'missing_action' }, 400);

  const admin = createAdminClient({ baseUrl, apiKey });
  const db = createPgDb(admin);
  // Broad instrumentation for this server path (Task 5D). Console sink → InsForge
  // log stream; no-op-safe. The action name is low-cardinality; never the payload.
  const datadog = createDatadogClient();
  const instrument = createInstrumentation(
    { service: datadog.service, environment: datadog.environment, enabled: true },
    createConsoleSink(),
  ).child({ path: 'server', fn: 'console-actions', action: body.action });
  const endSpan = instrument.span('server.console_action');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await handleAction(db, { userId, clock: systemClock }, body as any);
    if (ENQUEUES.has(body.action)) {
      // Process the just-enqueued job inline (same admin client, no network hop)
      // so the console sees it move; the ~1-min cron is the catch-up + retry path.
      // Task 5D: an inline failure emits reliability telemetry too, so the proof
      // doesn't depend on which tick (inline vs cron) happened to process the job.
      try {
        await runTick(db, {
          workerId: `inline-${crypto.randomUUID().slice(0, 8)}`,
          clock: systemClock,
          maxJobs: 5,
          phaseDelayMs: 120,
          emitJobTelemetry: createJobTelemetryEmitter(admin, datadog),
        });
      } catch {
        /* the scheduled tick will pick the job up */
      }
    }
    endSpan({ ok: true });
    return json(result);
  } catch (err) {
    if (err instanceof ActionError) return json({ error: err.code, message: err.message }, err.status);
    // Never echo a raw error to the browser (it can carry internal/provider
    // detail); log a redacted code server-side and return a stable shape — same
    // posture as job-worker-tick (review fix).
    endSpan({ ok: false });
    instrument.log('error', 'server.console_action_error', { error: err instanceof Error ? err.message : String(err) });
    return json({ error: 'internal' }, 500);
  }
}
