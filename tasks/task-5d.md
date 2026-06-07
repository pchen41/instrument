# Task 5D: Implement Datadog instrumentation, reliability telemetry, and integration health

## Status

Complete (2026-06-06).

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

### Build (2026-06-06)

Extends the 5B/5C runtime-agnostic-core + Deno-edge split. Pure libs are unit-
tested under Vitest and bundled into the edge functions by build-functions.mjs.

**Shared instrumentation (`server/lib/instrumentation.ts`)** — the broad app-
telemetry surface: `createInstrumentation({service, environment, enabled}, sink)`
returns `log/metric/span/child`. `child(attrs)` binds stable redacted attributes
(service, env, workflow, job_type, integration, request_id, trace_id) so every
backend path (server fn, worker, webhook, provider client, model/MCP, UI read,
write executor) emits a consistent structured record. **No-op when disabled or
sink-less** (local/test never breaks). Every attribute is run through
`redactAttributes` (reuses `redaction.ts`): secret-named keys and secret-shaped
values are masked, numbers pass through, nested blobs are bounded+scrubbed. Sinks:
`createConsoleSink` (structured JSON to stdout → InsForge log stream the
observability MCP reads = the documented local/mock sink) and `createMemorySink`
(tests). Per the ERD, broad logs/metrics/traces go here, NOT to telemetry_emissions.

**Reliability telemetry (`server/lib/telemetry.ts`)** — the two stable signals.
`buildEmission(ctx, signal)` produces the audit-row fields + the Datadog metric
and event payloads. `emitReliabilitySignal(deps, ctx, signal)` orchestrates
reserve → submit-once → finish with idempotency. Never throws on a Datadog error
(records `failed` + a redacted code instead); the worker also wraps it.

- **Metric/event names:** `instrument.job.retry`, `instrument.job.error` (PRD OBS-7).
- **Routing tags (low-cardinality, on the metric + audit row):** `service`,
  `env`, `workflow` (stable name via `WORKFLOW_BY_JOB_TYPE`), `job_type`,
  `integration` (failure source: truefoundry/datadog/github/worker), `error_code`.
- **Context tags (audit row + the event, NOT the metric):** `trace_id`,
  `request_id` when available — kept off the metric to bound custom-metric
  cardinality; they ride the (low-volume) event so the investigation can pivot to
  TrueFoundry evidence. **No raw job id is ever a Datadog tag** (job_id is a real
  telemetry_emissions column only); enforced by tests + the live smoke.
- **Idempotency:** key = `${jobId}:attempt-${attempt}`; the table's unique
  `(workspace_id, metric_name, idempotency_key)` collapses a re-emitted attempt
  onto the existing row. If that row already reached `succeeded`, Datadog is
  skipped entirely → `emission_state = skipped_duplicate` result.

**Telemetry path (HTTP, Edge-suitable — no UDP/dogstatsd agent):**
`server/functions/_shared/datadog-client.ts` → **Metrics v2** intake
`POST https://api.us5.datadoghq.com/api/v2/series` (type 1 = count, interval 60)
and **Events v1** `POST .../api/v1/events`, header `DD-API-KEY`, 10s abort.
Mock sink (no submit) when `DATADOG_API_KEY` is absent. Non-2xx → short
`datadog_http_<status>` code, body dropped (no token/payload leak).
`server/functions/_shared/telemetry-store.ts` writes telemetry_emissions, resolves
the source `integration_id` per workspace/provider, and composes the
`emitJobTelemetry` hook the worker injects.

**Worker wiring:** `worker.ts finishFailure` calls `emitJobTelemetry` best-effort
*after* the retry/terminal state write commits — a telemetry failure can never
disturb durable job state (unit-tested). Wired into both the scheduled
`job-worker-tick` and the inline `console-actions` tick, plus broad worker
instrumentation (`worker.tick` span + `instrument.worker.tick.claimed` metric).

**Integration health (`server/lib/integration-health.ts`):**
`assessIntegrationHealth(input)` → `integrations.status` enum
(`connected | degraded | rate_limited | missing_credentials`; `disconnected` is a
lifecycle state, not inferred) from credential presence, MCP registration, recent
provider failures, and our own telemetry submission failures. Precedence:
missing_credentials > rate_limited > degraded > connected. Diagnostics
(`last_error_code/summary`) are redacted.

### Reliability-validation monitor (preconfigured OUTSIDE Instrument)

Per ERD (the reliability monitor is provisioned manually, not via the draft-
monitor flow), paste one of these on **us5**. They match the emitted names/tags
exactly:

- **Metric monitor (primary — the threshold signal):**
  `sum(last_5m):sum:instrument.job.retry{service:instrument,env:production,integration:truefoundry}.as_count() + sum:instrument.job.error{service:instrument,env:production,integration:truefoundry}.as_count() >= 1`
  grouped `by {workflow,integration,error_code}`. For the forced TrueFoundry
  rate-limit proof, `integration:truefoundry` (and optionally
  `error_code:rate_limited`) routes it to the configured service incident.
- **Event monitor (alternative / for human context in the incident):**
  `events("tags:(service:instrument env:production integration:truefoundry)").rollup("count").by("workflow").last("5m") >= 1`
  — filters on tags the event provably carries (not `source:`, since the custom
  `source_type_name` may not be searchable as a `source:` facet).

When the monitor fires it creates/updates the Datadog incident, which Instrument
ingests via the Datadog alert webhook and investigates — the trace_id/request_id
on the event lead the investigation to the TrueFoundry evidence (no pre-wired job
pointer; ERD).

### Verification

- Tests: `telemetry` (12), `instrumentation` (6), `integration-health` (7),
  `worker` reliability-hook (3) — full suite **193 passing**, `tsc` clean, bundle
  green. Covers required routing tags + trace/request IDs, no-op-without-config,
  mocked-HTTP submit-once + idempotent skip, Datadog failure recording, and all
  four health states.
- **Live smoke vs us5 + dev DB** (vite-node, real telemetry-store + real Datadog
  client): retry + terminal + duplicate signals — Datadog accepted (2xx), rows
  persisted `succeeded` with resolved integration_id and routing/context tags, the
  duplicate skipped, **12/12, all rows cleaned up**.
- **Deployed end-to-end:** enqueued a forced terminal TrueFoundry failure, drove
  the deployed `job-worker-tick`; the live worker wrote
  `instrument.job.error` (`emission_state=succeeded`, Datadog 2xx, integration
  resolved, no job-id leak) — proving the secret pickup + full wiring. Test job +
  row cleaned up.

### Caveats / forward hooks

- `DATADOG_API_KEY` + `DATADOG_SITE=us5.datadoghq.com` set as InsForge secrets;
  both functions redeployed. `DD_SERVICE` defaults `instrument`, `DD_ENV` defaults
  `production`.
- Submission needs only the Datadog **API key**; creating the monitor needs an
  **Application key** (not configured) — hence the monitor is documented for manual
  paste, matching the ERD's "preconfigured outside Instrument".
- trace_id/request_id are emitted "when available" — the worker forwards
  `trigger_summary.last_trace_id/last_request_id`; the provider workflow tasks
  (6/7/9/11/12) stash those from their model/MCP calls so reliability emissions
  carry the live TrueFoundry trace.

### Review-fix pass (2026-06-06, Claude+Codex+Gemini static review)

All three converged on real gaps; all HIGH+MED + cheap LOWs applied (full suite
**207 passing**, tsc clean, bundle green; re-smoked live + redeployed):

- **Integration health is now WIRED** (was shipped as an un-wired pure helper —
  the unanimous headline). New `_shared/integration-health-store.ts`
  (`writeIntegrationHealth`, `reflectProviderFailure`,
  `reflectTelemetrySubmissionFailure`) persists `integrations.status` +
  `last_error_*` + `last_checked_at`. The worker telemetry emitter calls it:
  a Datadog-submission failure → datadog `degraded`; a provider-sourced job
  failure → that integration `rate_limited`/`degraded`(invalid-cred)/degraded.
  Failure-driven (visible in the console on real failures); recovery→`connected`
  is provider-task scope (they own the success/MCP-registration context).
- **Redaction made recursive** (`instrumentation.redactAttributes`): the
  secret-NAME guard now fires for any value type and at every depth, so a
  secret-named field leaks no longer when its value is numeric/boolean or nested
  (e.g. `{config:{datadog_api_key:'<32-hex>'}}`).
- **Partial-Datadog-success idempotency:** the metric is primary (its 2xx =
  success); an event failure after the metric lands no longer flips the row to
  `failed` (which would have risked a metric double-send on any re-emit).
- **Disabled/mock sink is now distinguishable:** no `DATADOG_API_KEY` → row
  `succeeded` with **`emitted_at` NULL** (a real us5 2xx always stamps
  `emitted_at`), so a rotated/missing key can't masquerade as a real emission.
- **`finish()` no longer swallows PostgREST errors silently** (logs a redacted
  code; doesn't mislabel the row); **`console-actions` no longer returns
  `err.message` to the browser** (generic `internal` + server-side log).
- **Health precedence tightened:** classify on the most-recent failure (not "any
  in history"), gate rate-limit on kind/code (not free-text summary), handle
  `auth`/invalid-credential as degraded-with-invalid-cred-code.
- **No raw job id reaches Datadog at all:** the event `aggregation_key` now uses
  `sha256(jobId)` (was the raw UUID). Also: `redactErr` + `classifyError` scrub
  defensively; trace/request tag values keep case; per-submit timeout 10s→5s to
  bound tick latency; **broad instrumentation now wired into `console-actions`**
  too (was worker-tick only).
- **Deterministic tests added** for the previously smoke-only paths: the store's
  unique-conflict→lookup branch + NOT NULL insert payload + finish-error
  (`telemetry-store.test.ts`), the disabled-sink + event-failure orchestration,
  and the recursive-redaction holes.
