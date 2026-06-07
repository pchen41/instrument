# Task 12: Implement the TrueFoundry reliability validation path

## Status

Not started.

## Context

The first product slice depends on Instrument behaving like a reliable agent on
TrueFoundry: a recommendation PR generation job hits a forced retryable failure,
survives it, emits telemetry, triggers a Datadog incident, investigates the
induced failure, and eventually completes the original PR generation.

Depends on Tasks 5A, 5B, 5C, 5D, 7, 8, 10, and 11. It may require external
provisioning listed in `docs/ERD.md`. The MCP foundation should already exist
from Task 5C; this task validates and hardens the reliability proof instead of
introducing MCP for the first time. If Task 5C used the demo path, expect the
Instrument observability MCP server to be a small Render-hosted Python/FastMCP
service registered manually in TrueFoundry MCP Gateway. This task may harden
that server, but should not replace it with a larger architecture unless the
demo path blocks the validation workflow.

## Requirements

- Verify and, if needed, harden the Instrument-owned TrueFoundry observability
  MCP server from Task 5C, including its Render deployment, TrueFoundry Gateway
  registration, shared-header/bearer auth, and bounded read-only tools:
  - `query_truefoundry_model_metrics`
  - `query_truefoundry_mcp_metrics`
  - `search_truefoundry_request_logs`
  - `get_truefoundry_trace_spans`
  - `get_instrument_evidence_bundle`
- Enforce bounded time windows, result-size limits, redaction, and simple
  allowlisted query shapes in the MCP server. Add stricter query templates only
  where the demo evidence path proves they are needed.
- Verify GitHub MCP, Datadog MCP, and Instrument observability MCP registrations
  from Task 5C, including stored non-secret FQNs, URLs, allowed tools, and health
  in `integrations.config`.
- Keep production OAuth, token passthrough, and automated MCP registration out of
  scope unless the demo cannot run safely with the Task 5C shared-secret setup.
- Ensure LLM/tool workflows use TrueFoundry AI Gateway or Agent API and persist
  streamed tool-call summaries in `ai_model_calls.tool_calls_redacted`, with
  cited outputs in `evidence_items`.
- Add a controlled retryable failure mode for recommendation PR generation,
  such as a forced TrueFoundry/API rate-limit response.
- Make the forced failure and subsequent "manual fix" reproducible through a
  documented demo control, such as a seed/reset flag, server-side env var, or
  local mock-provider setting. The runbook must say exactly how to enable the
  failure and how to clear it so the waiting job resumes.
- Ensure the failure:
  - moves the original job to `retrying`
  - preserves phase progress
  - emits retry/error telemetry
  - does not duplicate external writes
  - updates integration health when appropriate
- Inject the forced retryable failure after at least one idempotent external
  write step has completed, such as branch creation or a file update, so the
  validation path actually exercises duplicate-write prevention on retry.
- Ensure the Datadog instrumentation from Task 5D is enabled for the validation
  environment.
- Configure or document the published Datadog monitor that fires from this
  telemetry. Because Task 9 only creates draft monitors, the
  reliability-validation monitor should be manually preconfigured/published in
  Datadog, or otherwise provisioned outside Instrument's draft-monitor flow and
  documented in the runbook.
- Ensure the Datadog incident created from the telemetry contains enough alert
  context, time window, workflow, integration/source, error code, and trace or
  request IDs for the investigation to find the relevant Datadog and TrueFoundry
  evidence.
- Ensure smart investigation start automatically begins for the
  reliability-validation incident.
- Ensure seed/reset tooling sets
  `workspaces.investigation_start_mode = 'smart'`, or the runbook instructs the
  operator to switch to "Let Instrument decide" before triggering the
  reliability incident.
- Ensure the investigation cites Datadog and TrueFoundry evidence and identifies the induced rate limit as root cause or leading hypothesis.
- After the simulated/manual rate-limit fix control is cleared, allow the
  original recommendation PR generation job to complete in the background.
- Add seed/reset tooling so the full path can be rehearsed repeatedly.
- Add final validation-path documentation with setup, Render env var names,
  TrueFoundry MCP FQN/URL values, fixtures, and a step-by-step runbook. Record
  secret names only, never secret values.

## Acceptance Criteria

- The full PRD validation path can be run from a clean seeded state.
- Forced retryable TrueFoundry/API failure does not lose job state or duplicate external writes.
- Retry/error telemetry includes Datadog-routable service/environment/workflow/integration/error tags.
- Retry/error telemetry is visible to the Datadog monitor through the Task 5D instrumentation path.
- Datadog creates an incident from the telemetry monitor.
- Smart mode starts the reliability-validation investigation automatically and
  shows a "Started automatically" indicator.
- Investigation output distinguishes the induced rate limit/runtime configuration issue from a code defect and suggests the manual operational fix.
- The incident can resolve through the authenticated Datadog recovery webhook
  while the original recommendation PR generation job eventually succeeds. Do not
  add a manual incident-resolve button for the first slice.
- PR generation, incident investigation, incident resolution, and generated PR are separate but linkable console events.

## Automated Tests

- Add an end-to-end test or scripted integration test for the reliability
  validation path using fixtures/mocks where provider sandboxes are unavailable.
- Add tests for forced retry behavior and duplicate-write prevention.
- Add tests that the telemetry alert payload provides the workflow/source/error
  and trace/request context needed by the investigation.
- Add tests that the forced failure occurs after at least one idempotent external
  write and that retry does not duplicate that write.
- Add a test or scripted check that the reliability Datadog monitor query
  matches the metric/event emitted by Task 5D instrumentation.
- Add tests for smart auto-start of the reliability-validation alert.
- Add tests that the final PR generation job can resume and succeed after the
  documented simulated rate-limit fix is cleared.

## Manual Verification

- Reset seeded state.
- Approve a code-based recommendation PR generation.
- Trigger the forced retryable failure.
- Confirm the console shows retrying progress and Datadog receives telemetry.
- Confirm the preconfigured/published Datadog monitor is evaluating the emitted retry/error telemetry.
- Confirm the Datadog alert webhook creates an incident and smart investigation starts automatically.
- Resolve/fix the simulated rate limit using the documented demo control.
- Confirm incident resolution and background PR generation success.

## Progress Notes

- Update this section with TrueFoundry MCP verification details, Datadog monitor
  setup, reset command, rate-limit control, and any external provisioning still
  required.
- 2026-06-06: The Task 5C demo Instrument observability MCP server exists and is
  usable as the MCP foundation for later reliability validation hardening. It is
  a Render-hosted Python/FastMCP service at
  `https://instrument-9z6j.onrender.com/mcp`, backed by TrueFoundry control
  plane `https://peterc.truefoundry.cloud`. Verified tools include
  `query_truefoundry_mcp_metrics` returning live MCP metrics for recent
  `tools/list`, `initialize`, and `tools/call` traffic. Task 12 should harden
  this existing server rather than introducing a new MCP service.
