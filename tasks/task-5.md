# Task 5: Implement durable jobs, progress phases, retries, failure states, and telemetry

## Status

Not started.

## Context

The PRD makes durable backend jobs central to the demo. Browser-local timers from the prototype must be replaced with persisted `jobs.phases`, `jobs.attempts`, retry state, and audit events.

Depends on Tasks 2 and 4. Later workflow tasks should plug into this job framework rather than building one-off runners.

## Requirements

- Implement a job dispatcher/worker path for all PRD job types:
  - `github_pr_review_analysis`
  - `proactive_scan`
  - `recommendation_generation`
  - `datadog_monitor_analysis`
  - `datadog_alert_generation`
  - `incident_investigation`
  - `recommendation_pr_generation`
  - `truefoundry_metrics_ingest`
  - `truefoundry_logs_ingest`
- Claim jobs transactionally using leases or `select ... for update skip locked`.
- Support `queued`, `running`, `retrying`, `failed`, `succeeded`, and `cancelled` where cancellation is supported.
- Persist named phase progress in `jobs.phases`.
- Persist bounded attempt summaries in `jobs.attempts`.
- Implement bounded retry with backoff for retryable external/API failures.
- Preserve completed progress on failure.
- Expose a safe manual retry path for jobs with `safe_to_retry = true`.
- Write `job_audit_events` for source reads, retries, schema validation, and external writes.
- Emit `telemetry_emissions` for retry/error events with Datadog-routable tags: service, environment, workflow, integration source, error/rate-limit code, and trace/request IDs when available.
- Ensure idempotency keys prevent duplicate jobs on browser refresh, webhook replay, or manual retry.

## Acceptance Criteria

- A worker restart or browser refresh does not lose job progress or duplicate external writes.
- Retryable failures enter `retrying`, schedule `next_run_at`, and later resume.
- Terminal failures retain phases, attempts, affected integration/source, and redacted error summary.
- Manual retry creates or reuses the correct durable job without duplicating provider-side writes.
- Job progress can be read by the console without starting work.
- Telemetry emissions can be correlated back to the originating job app-side without using raw job IDs as Datadog metric tags.

## Automated Tests

- Add worker unit tests for job claiming, lease expiry, retry scheduling, failure handling, and success.
- Add idempotency tests for duplicate enqueue attempts.
- Add tests for manual retry behavior.
- Add tests that telemetry emission records contain required routing tags.

## Manual Verification

- Seed a job with phases and run the worker.
- Force a retryable failure and confirm the console shows retrying progress.
- Force a terminal failure and confirm retry is available only when safe.
- Restart the worker during a running job and confirm lease recovery.

## Progress Notes

- Update this section with worker implementation location, supported run modes, and retry policy details.
