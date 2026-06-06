# Task 5: Implement durable jobs, worker runtime, MCP foundation, retries, failure states, and telemetry

## Status

Not started.

## Context

The PRD makes durable backend jobs central to the first product slice.
Browser-local timers from the prototype must be replaced with persisted
`jobs.phases`, `jobs.attempts`, retry state, and audit events. This task also
establishes the server-side runtime and MCP foundation used by later workflow
tasks so GitHub, Datadog, and TrueFoundry access patterns do not need to be
reworked near the end.

Depends on Task 2. Task 4 may be implemented before or alongside this task against seeded job rows, but retry buttons and live worker behavior become functional here. Later workflow tasks should plug into this job framework rather than building one-off runners.

## Requirements

- Implement a job dispatcher/worker path for all PRD job types:
  - `github_pr_review_analysis`
  - `proactive_scan`
  - `recommendation_generation`
  - `datadog_alert_generation`
  - `incident_investigation`
  - `recommendation_pr_generation`
- Implement the worker runtime as a scheduled InsForge Edge Function tick by
  default:
  - Create a `job-worker-tick` style function that claims due jobs and processes
    bounded work within the function time budget.
  - Configure or document an InsForge schedule that invokes the tick every
    minute.
  - Opportunistically invoke the tick after enqueueing important jobs when that
    is practical, but correctness must not depend on browser sessions.
  - Use `jobs.next_run_at`, leases, persisted phases, and retry state to continue
    work across scheduled invocations.
  - Document Compute as a later fallback only if scheduled function ticks are
    insufficient and the project has InsForge Compute enabled.
- Claim jobs transactionally using leases or `select ... for update skip locked`.
- Support `queued`, `running`, `retrying`, `failed`, and `succeeded`. First-slice
  cancellation is out of scope.
- Persist named phase progress in `jobs.phases`.
- Persist bounded attempt summaries in `jobs.attempts`.
- Implement bounded retry with backoff for retryable external/API failures.
- Preserve completed progress on failure.
- Expose a safe manual retry path for jobs with `safe_to_retry = true`.
- Append bounded UI-safe audit notes to `jobs.audit_events` for source reads,
  retries, schema validation, and external writes.
- Emit `telemetry_emissions` for retry/error events with Datadog-routable tags: service, environment, workflow, integration source, error/rate-limit code, and trace/request IDs when available.
- Add the shared server-side TrueFoundry AI Gateway/Agent API foundation that later jobs use for model calls:
  - Calls must go through TrueFoundry, not direct model-provider SDKs.
  - Persist `ai_model_calls` for every model call.
  - When an Agent API call streams MCP tool calls/results, persist bounded
    summaries in `ai_model_calls.tool_calls_redacted`; persist cited tool
    outputs as `evidence_items`.
  - Task-specific prompts, schemas, and tool allowlists are added in Tasks 6, 7, 9, 11, and 12.
- Establish the MCP foundation before GitHub/Datadog workflow tasks depend on
  it:
  - Verify or register GitHub MCP and Datadog MCP through TrueFoundry MCP
    Gateway with explicit read/write tool allowlists.
  - Store MCP server FQNs, server URLs, allowed toolsets, and health state in
    `integrations.config` without storing secrets.
  - Implement or deploy a minimal Instrument-owned TrueFoundry observability MCP
    server with bounded read-only tools for model metrics, MCP metrics, request
    logs/spans, and existing evidence bundles. It can start minimal here and be
    expanded/hardened in Tasks 11 and 12, but its FQN and health should be known
    before incident investigation work starts.
  - Add health-check helpers that can mark integrations `connected`, `degraded`,
    `rate_limited`, or `missing_credentials` based on provider auth, MCP
    registration, and recent provider/API failures.
- Add Datadog instrumentation for Instrument's own retry/error telemetry. The
  worker should write `telemetry_emissions` and also submit a corresponding
  Datadog metric or event through the simplest available server-side path for
  the first product slice, such as the Datadog metrics API, events API,
  OpenTelemetry exporter, or DogStatsD. Use server-only credentials and document
  the chosen path.
- Use stable metric/event names such as `instrument.job.retry` and `instrument.job.error`. Include Datadog tags for service, environment, workflow, integration source, error/rate-limit code, and trace/request IDs when available; do not use raw job IDs as Datadog metric tags.
- Ensure idempotency keys prevent duplicate jobs on browser refresh, webhook replay, or manual retry.

## Acceptance Criteria

- The worker runtime choice is documented as scheduled Edge Function ticks, with
  any Compute fallback explicitly deferred.
- A worker restart or browser refresh does not lose job progress or duplicate external writes.
- Retryable failures enter `retrying`, schedule `next_run_at`, and later resume.
- Terminal failures retain phases, attempts, affected integration/source, and redacted error summary.
- Manual retry creates or reuses the correct durable job without duplicating provider-side writes.
- Job progress can be read by the console without starting work.
- Telemetry emissions can be correlated back to the originating job app-side without using raw job IDs as Datadog metric tags.
- Retry/error telemetry is actually emitted to Datadog or to a documented local/mock Datadog sink used by automated tests; it is not only stored in Postgres.
- Shared TrueFoundry model-call helpers can create a validated
  `ai_model_calls` row and, for a streamed Agent API fixture, bounded
  `tool_calls_redacted` summaries plus cited `evidence_items`.
- GitHub MCP, Datadog MCP, and the minimal Instrument observability MCP server
  have non-secret registration/config stored in `integrations.config`, or the
  corresponding integration is explicitly marked degraded/missing credentials.

## Automated Tests

- Add worker unit tests for job claiming, lease expiry, retry scheduling, failure handling, and success.
- Add tests for the scheduled tick loop: due-job selection, no-op when no due
  jobs exist, bounded processing, and requeue through `next_run_at`.
- Add idempotency tests for duplicate enqueue attempts.
- Add tests for manual retry behavior.
- Add tests that telemetry emission records contain required routing tags.
- Add tests with a mocked Datadog client/exporter proving retry/error telemetry is submitted once per idempotent emission.
- Add tests for the shared TrueFoundry AI/Agent API persistence helpers using a non-tool response fixture and a streamed tool-call fixture.
- Add MCP config/health tests for connected, degraded, rate-limited, and missing
  credentials states.

## Manual Verification

- Seed a job with phases and run the worker.
- Configure the scheduled Edge Function tick or document the local command used
  to run it repeatedly.
- Force a retryable failure and confirm the console shows retrying progress.
- Confirm the retry/error metric or event is visible in Datadog, or in the documented local/mock Datadog sink when running without provider credentials.
- Force a terminal failure and confirm retry is available only when safe.
- Restart the worker during a running job and confirm lease recovery.
- Confirm MCP FQNs/tool allowlists are visible in non-secret integration config,
  or the integration state explains what is missing.

## Progress Notes

- Update this section with worker implementation location, schedule details,
  supported run modes, retry policy details, MCP config notes, and any Compute
  fallback decision.
