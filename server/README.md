# server/ — durable job engine + console mutation endpoints (Task 5A)

Server-side code that the browser cannot run: the durable job worker and the
authenticated mutation endpoints. Browser RLS is **select-only** on the
workspace-owned tables, so every write funnels through these edge functions,
which use the InsForge admin (service-role) client.

## Layout

```
server/
  lib/            runtime-agnostic core (pure TS — no Deno, no SDK)
    types.ts        row/shape types
    time.ts         Clock, ISO-seconds, LEASE_FREE sentinel, sleep
    hash.ts         canonical JSON + SHA-256 (approved-payload hash)
    retry.ts        backoff + retry/terminal decision, JobError
    transitions.ts  job / approval / recommendation state machines
    phases.ts       per-job-type phase plans + resume merge
    idempotency.ts  stable idempotency keys
    db.ts           JobsDb interface (the only DB surface the core touches)
    worker.ts       runTick: claim → lease → phased progress → retry/fail
    actions.ts      handleAction: the mutation endpoints
    fake-db.ts      in-memory JobsDb for tests (models the claim CAS)
    *.test.ts       Vitest unit tests (run with the app's `npm test`)
  functions/      Deno edge-function entries (deployed to InsForge)
    job-worker-tick/index.ts   cron-driven worker
    console-actions/index.ts   authenticated mutation dispatcher
    _shared/http.ts            CORS + JSON helpers
    _shared/pgdb.ts            PostgREST-backed JobsDb over the admin client
  dist/           bundled function files (gitignored build artifact)
```

The core in `lib/` is imported both by Vitest (Node) and, bundled, by the Deno
functions — keeping the claim/lease, retry, idempotency, and transition logic
testable without a live Postgres, and identical in both environments.

## Build & deploy

```bash
node scripts/build-functions.mjs        # esbuild-bundle each entry → server/dist/
npx @insforge/cli functions deploy job-worker-tick --file server/dist/job-worker-tick.js
npx @insforge/cli functions deploy console-actions --file server/dist/console-actions.js
```

`npm:` / `node:` specifiers are left external for the Deno runtime; everything
else is bundled in.

## Runtime wiring

- **Worker.** An InsForge schedule invokes `job-worker-tick` every minute (the
  catch-up + retry driver), carrying the `WORKER_TICK_SECRET` header that gates
  the endpoint. `console-actions` also runs a tick **inline** right after an
  enqueueing action so the console sees progress immediately.
- **Claiming.** Due = `state in (queued,retrying) and next_run_at <= now and
  lease_expires_at < now`; abandoned reclaim = `state = running and
  lease_expires_at < now`. The claim is a conditional UPDATE guarded by the same
  predicate — an atomic compare-and-set, so concurrent ticks never double-process.
  Enqueue sets `lease_expires_at` to a past sentinel; the seeded demo jobs (NULL
  `next_run_at`) are therefore never claimed.
- **Secrets** (server-only, via `Deno.env.get`): `INSFORGE_BASE_URL`, `ANON_KEY`,
  `API_KEY` (admin/service key — never exposed to the browser), and
  `WORKER_TICK_SECRET`. No provider tokens live here; those arrive with Tasks 5C+.
