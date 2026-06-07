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
import { runTick } from '../../lib/worker.ts';
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

  const db = createPgDb(createAdminClient({ baseUrl, apiKey }));
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await handleAction(db, { userId, clock: systemClock }, body as any);
    if (ENQUEUES.has(body.action)) {
      // Process the just-enqueued job inline (same admin client, no network hop)
      // so the console sees it move; the ~1-min cron is the catch-up + retry path.
      try {
        await runTick(db, {
          workerId: `inline-${crypto.randomUUID().slice(0, 8)}`,
          clock: systemClock,
          maxJobs: 5,
          phaseDelayMs: 120,
        });
      } catch {
        /* the scheduled tick will pick the job up */
      }
    }
    return json(result);
  } catch (err) {
    if (err instanceof ActionError) return json({ error: err.code, message: err.message }, err.status);
    return json({ error: 'internal', message: errMessage(err) }, 500);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
