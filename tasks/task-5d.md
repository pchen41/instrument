# Task 5D: Implement Datadog instrumentation, reliability telemetry, and integration health

## Status

Not started.

## Context

Instrument must emit broad Datadog app telemetry for its own backend paths and
specific retry/error telemetry about durable jobs so Datadog can create the
reliability-validation incident. This task implements shared server-side
instrumentation utilities, reliability telemetry submission, and integration
health checks. It does not add a manual incident resolve button or fallback UI;
incident resolution remains driven by Datadog recovery webhook behavior for the
first product slice.

Depends on Tasks 0, 2, 5A, 5B, and 5C.

## Requirements

- Add shared server-side Datadog instrumentation utilities for structured logs,
  metrics, and traces/spans.
- The utilities must be usable by server functions, workers, webhook handlers,
  provider clients, model/MCP call paths, UI read endpoints, and external write
  executors.
- Emit stable attributes where available: service, environment, workflow, job
  type, integration/provider, request ID, trace ID, and redacted error fields.
- Keep local/test mode functional through a no-op or mock telemetry sink when
  Datadog telemetry configuration is absent.
- Never log raw provider credentials, InsForge admin keys, webhook secrets, model
  prompts containing sensitive code beyond approved redacted summaries, or
  unbounded provider payloads.
- Emit `telemetry_emissions` for retry/error events with Datadog-routable tags:
  service, environment, workflow, integration source, error/rate-limit code, and
  trace/request IDs when available.
- Include Datadog-routable tags and attributes such as service, environment,
  workflow, integration/source, error/rate-limit code, trace ID, and request ID.
  Do not submit raw job IDs as Datadog tags.
- Submit retry/error telemetry to Datadog through an HTTP-based server-side path
  suitable for the selected runtime, such as the Datadog Events API or Metrics
  API. Do not use UDP-agent-based telemetry for the Edge Function path.
- Use stable metric/event names such as `instrument.job.retry` and
  `instrument.job.error`.
- Ensure idempotency keys prevent duplicate Datadog submissions for the same
  telemetry emission.
- Add health-check helpers that can mark integrations `connected`, `degraded`,
  `rate_limited`, or `missing_credentials` based on provider auth, MCP
  registration, recent provider/API failures, and telemetry submission failures.
- Document the chosen Datadog telemetry path and how it maps to the
  reliability-validation monitor configured outside Instrument's draft-monitor
  flow.

## Acceptance Criteria

- Telemetry emissions include enough workflow, integration/source,
  error/rate-limit, service/environment, trace ID, and request ID context for the
  reliability investigation to find the relevant Datadog and TrueFoundry evidence
  without using raw job IDs as Datadog tags.
- Shared server-side instrumentation helpers emit or mock structured logs,
  metrics, and traces/spans for representative server, worker, provider, and
  model/MCP paths.
- Retry/error telemetry is actually emitted to Datadog or to a documented
  local/mock Datadog sink used by automated tests; it is not only stored in
  Postgres.
- Duplicate telemetry submission attempts are skipped or reused through
  idempotency keys.
- Integration health can represent connected, degraded, rate-limited, and missing
  credentials states with redacted diagnostics.
- The reliability monitor query or event filter is documented and matches the
  emitted metric/event name and tags.

## Automated Tests

- Add tests that telemetry emission records contain required routing tags and
  trace/request IDs when available.
- Add tests that shared instrumentation helpers are no-ops or mockable without
  Datadog config and emit expected attributes with config present.
- Add tests with a mocked Datadog HTTP client proving retry/error telemetry is
  submitted once per idempotent emission.
- Add tests for Datadog submission failure and retry behavior.
- Add integration health tests for connected, degraded, rate-limited, and missing
  credentials states.

## Manual Verification

- Force a retryable failure and confirm a `telemetry_emissions` row is written.
- Exercise a representative server function, worker path, provider call, and
  model/MCP call path and confirm telemetry is emitted or captured by the local
  mock sink.
- Confirm the retry/error metric or event is visible in Datadog, or in the
  documented local/mock Datadog sink when running without provider credentials.
- Confirm the emitted telemetry includes the expected service/environment/
  workflow/integration/error tags and trace/request IDs when available.
- Confirm integration health updates are visible to the console.

## Progress Notes

- Update this section with Datadog instrumentation utilities, telemetry path,
  metric/event names, required tags, health-check behavior, and any provider
  caveats.
