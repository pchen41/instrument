# Task 5A: Implement durable jobs, leases, retries, and server mutation endpoints

## Status

Not started.

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

- Update this section with worker implementation location, endpoint locations,
  retry policy details, test results, and any RLS exceptions.
