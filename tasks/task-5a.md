# Task 5A: Implement durable jobs, leases, retries, and server mutation endpoints

## Status

Core complete (2026-06-06). The durable job engine (claim → lease → phased
progress → retry/backoff → terminal failure, resumable across invocations) and
the authenticated `console-actions` mutation endpoint are implemented in
`server/lib`, bundled into two InsForge edge functions (`job-worker-tick`,
`console-actions`), and deployed live with an every-minute worker cron. The
console's investigation start/retry, recommendation dismiss/restore, and the
investigation-start setting now call the real endpoints (the previous deferred
choke point). The approval + generation-enqueue endpoints are implemented and
unit-tested; their console buttons (generate PR / publish or change a Datadog
monitor / mark merged) remain deferred until the provider external-write
executors ship (Tasks 6–9, 12). Worker runtime is scheduled InsForge Edge
Function ticks per the ERD default; Task 5B formally signs that off.

## Context

The PRD makes durable backend jobs central to the first product slice. Browser
local timers from the prototype must be replaced with persisted `jobs.phases`,
`jobs.attempts`, retry state, and audit events.

This task implements the durable job engine and user-triggered server mutation
endpoints. It intentionally does not implement real TrueFoundry Agent/MCP calls
or provider-specific workflow logic; those are handled in Tasks 5C, 6, 7, 8, 9,
11, and 12.

Depends on Tasks 0 and 2. Task 4 may be implemented before or alongside this
task against seeded job rows, but retry buttons and live mutation behavior become
functional here.

## Requirements

- Implement a job dispatcher/worker interface for all PRD job types:
  - `github_pr_review_analysis`
  - `proactive_scan`
  - `recommendation_generation`
  - `datadog_alert_generation`
  - `incident_investigation`
  - `recommendation_pr_generation`
- Implement enqueue helpers with stable idempotency keys for browser actions,
  webhook replay, scheduled work, and manual retry.
- Claim due jobs transactionally using leases or `select ... for update skip locked`.
- Support `queued`, `running`, `retrying`, `failed`, and `succeeded`. First-slice
  cancellation is out of scope.
- Persist named phase progress in `jobs.phases`.
- Persist bounded attempt summaries in `jobs.attempts`.
- Append bounded UI-safe audit notes to `jobs.audit_events` for state changes,
  source reads, retries, schema validation, and external write handoffs.
- Update JSON progress, attempts, and audit arrays under a row lock or through
  atomic SQL updates so concurrent serverless invocations cannot overwrite each
  other.
- Implement bounded retry with backoff for retryable external/API failures.
- Preserve completed progress on failure.
- Expose a safe manual retry path for jobs with `safe_to_retry = true`.
- Implement small server-side endpoints or function handlers, using server-only
  credentials where required, for:
  - change investigation-start setting
  - request, approve, reject, or revoke approval
  - dismiss or restore recommendation
  - start or retry investigation
  - retry a failed safe job
  - enqueue approved generation jobs
- Each endpoint must validate workspace membership, target workspace, allowed
  transition, idempotency key, and approved payload hash where relevant.
- Ensure job progress can be read by the console without starting or restarting
  work.

## Acceptance Criteria

- A worker restart, browser refresh, or duplicate enqueue attempt does not lose
  job progress or duplicate a job.
- Retryable failures enter `retrying`, schedule `next_run_at`, and later resume.
- Terminal failures retain phases, attempts, affected integration/source, and
  redacted error summary.
- Manual retry creates or reuses the correct durable job without duplicating
  provider-side writes.
- Server mutation endpoints reject invalid workspace membership, invalid state
  transitions, stale approval payload hashes, and duplicate idempotency keys.
- Browser sessions cannot directly create jobs, approvals, incidents,
  recommendations, external write actions, model calls, evidence, or telemetry
  rows through normal RLS.
- Job progress can be read by the console without starting work.

## Automated Tests

- Add worker unit tests for job claiming, lease expiry, retry scheduling, failure
  handling, and success.
- Add tests for due-job selection, no-op when no due jobs exist, bounded
  processing, and requeue through `next_run_at`.
- Add idempotency tests for duplicate enqueue attempts.
- Add tests for manual retry behavior.
- Add endpoint tests for investigation-start setting changes, approval
  transitions, dismiss/restore, start investigation, and retry job.
- Add tests proving endpoint mutations validate membership and allowed
  transitions.
- Add JSON progress update tests that would catch lost updates under concurrent
  workers.

## Manual Verification

- Seed a job with phases and run the worker locally.
- Force a retryable failure and confirm the console shows retrying progress.
- Force a terminal failure and confirm retry is available only when safe.
- Restart the worker during a running job and confirm lease recovery.
- Exercise each server mutation endpoint from the console or an authenticated
  request fixture.

## Progress Notes

- 2026-06-06: Implemented the durable job engine + mutation endpoints.
  - **Runtime-agnostic core** in `server/lib/` (pure TS, no Deno/SDK, so it runs
    identically under Vitest and bundled into Deno): `worker.ts` (claim/lease,
    resumable phased progress, retry/terminal decisions), `actions.ts` (mutation
    handlers), `retry.ts`, `transitions.ts`, `phases.ts`, `idempotency.ts`,
    `hash.ts`, `time.ts`, `db.ts` (the `JobsDb` interface), `types.ts`.
  - **Edge functions** in `server/functions/`: `job-worker-tick` (cron-driven
    worker) and `console-actions` (authenticated mutation dispatcher). They share
    a PostgREST-backed `JobsDb` adapter (`_shared/pgdb.ts`) over the InsForge admin
    (service-role) client. `scripts/build-functions.mjs` esbuild-bundles each
    entry to one file (`server/dist/`, gitignored), leaving `npm:`/`node:`
    external for Deno; deploy with `npx @insforge/cli functions deploy <slug>
    --file server/dist/<slug>.js`.
  - **Claim/lease design.** Due selection: `state in (queued,retrying) and
    next_run_at <= now and lease_expires_at < now`; abandoned reclaim: `state =
    running and lease_expires_at < now`. The claim is a conditional UPDATE guarded
    by the same predicate (atomic CAS under READ COMMITTED) — two concurrent ticks
    cannot both win. Enqueue sets `lease_expires_at` to a past sentinel
    (`1970-01-01T00:00:00Z`) so "free lease" is one uniform predicate and the
    seeded demo jobs (NULL `next_run_at` + NULL lease) are never claimed.
  - **Retry policy.** `jobs.max_attempts` is the authoritative budget; default
    backoff base 20s × 2 per attempt, capped 300s. Retryable failure with budget
    → `retrying` + `next_run_at`; otherwise terminal `failed`. Phases reached are
    preserved on both paths; manual retry reuses the same durable row with a fresh
    attempt budget (no duplicate job, no duplicate provider writes).
  - **Endpoints** (all validate membership against the *target's* workspace, the
    allowed transition, idempotency key, and approved-payload hash where relevant):
    `start_investigation`, `retry_job`, `set_recommendation_state` (dismiss/
    restore), `set_investigation_mode`, `request_approval`, `decide_approval`
    (approve re-checks the payload hash → stale rejected), `enqueue_generation`.
  - **Worker invocation.** `console-actions` runs a worker tick *inline* after an
    enqueueing action (same admin client, no network hop — the in-function HTTP
    poke was unreliable across the functions host), and an InsForge schedule hits
    `job-worker-tick` every minute as the catch-up + retry driver. The worker
    endpoint is gated by a `WORKER_TICK_SECRET` header (set via secret; the cron
    carries it). Phase delay 120ms so a fresh investigation visibly progresses.
  - **Client.** `src/data/actions.ts` wraps `functions.invoke('console-actions')`;
    `src/data/deferred.ts` now only carries the provider-write actions.
  - **RLS exceptions.** None added — Task 2 already left jobs/approvals/incidents/
    recommendations/evidence/ai_model_calls/telemetry/external_write_actions
    select-only for browser sessions, so "browser sessions cannot create jobs/etc."
    holds without change. All writes go through the service-role edge functions.
    The narrow `workspaces.investigation_start_mode` column grant still exists but
    the console now routes the setting through `console-actions` instead.
  - **Tests.** 25 server-lib unit tests (`server/lib/*.test.ts`): backoff/retry
    decisions, transitions, payload hashing, worker (success, no-op when nothing
    due, retry→preserve→resume→recover, terminal failure, concurrent atomic claim,
    abandoned reclaim while leaving NULL-lease jobs alone), and endpoint validation
    (membership, transitions, dismiss/restore, idempotent start, safe-retry gating,
    approval request→approve→enqueue, stale-payload rejection). Full suite 120
    passing; `npm run build` green.
  - **Live verification.** Against prod with throwaway rows (then cleaned up):
    worker success + retry/backoff/resume/recover; `console-actions` 401 without a
    token, 200 with a member token, membership enforced, `start_investigation`
    runs the inline worker to `succeeded`, repeat is idempotent. Seeded demo jobs
    untouched throughout.

- 2026-06-06 (review pass, Codex + Gemini): applied the quick-win fixes both
  flagged. (1) Manual retry now adds a fixed per-retry budget (`retry_policy
  .max_attempts ?? default`) instead of compounding off the inflated column
  (3→6→9, not 3→6→12). (2) `job-worker-tick` secret gate fails **closed** when the
  secret is unset. (3) Worker writes are **owner-guarded** (`updateOwnedJob`
  conditional on `locked_by`) and renew the lease each checkpoint, so a reclaimed
  over-running job bails as `lost` instead of clobbering the new owner. (4)
  Recommendation + approval transitions are conditional on the expected current
  state (409 on a concurrent change). (5) Failed-attempt summaries record the real
  attempt start time, not the failure time. (6) Start-mode failures now surface a
  toast. (7) Removed the now-dead `updateInvestigationStartMode` direct-write
  helper (the setting goes through `console-actions`). Tests now 27 server-lib /
  122 total; functions redeployed; live re-verified (gate + end-to-end). The
  approval-path findings (require payload on approve, ERD action-type names,
  step-key-scoped approval idempotency, re-request-after-reject) are folded into
  the provider/generation tasks where that path goes live.

## Deferred to provider tasks (not 5A)

- The console buttons for generate-PR / create-or-change-monitor / publish-monitor
  / mark-merged still route through `src/data/deferred.ts`. The approval + enqueue
  endpoint and the generation job engine exist and are tested, but the real GitHub
  / Datadog external writes land in Tasks 6–9 and 12.
