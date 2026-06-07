// Scheduled worker tick (Task 5A / 5B runtime probe). An InsForge schedule
// invokes this ~every minute, and console-actions pokes it opportunistically
// right after enqueueing a job. Each tick claims a bounded batch of due/abandoned
// jobs under an atomic lease, advances their phases, and requeues anything that
// needs another pass — so progress survives restarts and duplicate invocations.
//
// Deployed as a single bundled file (see scripts/build-functions.mjs); the
// `npm:` + `node:` imports are resolved by the Deno runtime, everything else is
// bundled from server/lib.
import { createAdminClient } from 'npm:@insforge/sdk';
import { json, preflight } from '../_shared/http.ts';
import { createPgDb } from '../_shared/pgdb.ts';
import { runTick } from '../../lib/worker.ts';
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

  const db = createPgDb(createAdminClient({ baseUrl, apiKey }));
  try {
    const result = await runTick(db, {
      workerId: `tick-${crypto.randomUUID().slice(0, 8)}`,
      clock: systemClock,
      maxJobs: 5,
      // Small per-phase delay so a fresh investigation visibly progresses through
      // its phases to the polling console rather than snapping to done.
      phaseDelayMs: 120,
    });
    return json({ ok: true, ...result });
  } catch (err) {
    return json({ ok: false, error: errMessage(err) }, 500);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
