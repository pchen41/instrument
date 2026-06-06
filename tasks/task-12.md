# Task 12: Implement the TrueFoundry reliability demo and end-to-end demo hardening

## Status

Not started.

## Context

The hackathon demo story depends on Instrument behaving like a reliable agent on TrueFoundry: a recommendation PR generation job hits a forced retryable failure, survives it, emits telemetry, triggers a Datadog incident, investigates the induced failure, and eventually completes the original PR generation.

Depends on Tasks 5, 8, 10, and 11. It may require external provisioning listed in `docs/ERD.md`.

## Requirements

- Implement or deploy the Instrument-owned TrueFoundry observability MCP server with bounded read-only tools:
  - `query_truefoundry_model_metrics`
  - `query_truefoundry_mcp_metrics`
  - `search_truefoundry_request_logs`
  - `get_truefoundry_trace_spans`
  - `get_instrument_evidence_bundle`
- Enforce allowlisted query templates, bounded time windows, redaction, and result-size limits in the MCP server.
- Register GitHub MCP, Datadog MCP, and Instrument observability MCP through TrueFoundry MCP Gateway.
- Store MCP server FQNs, URLs, allowed tools, and health in `mcp_servers`.
- Ensure LLM/tool workflows use TrueFoundry AI Gateway or Agent API and persist streamed tool calls/results.
- Add a demo-controlled retryable failure mode for recommendation PR generation, such as a forced TrueFoundry/API rate-limit response.
- Ensure the failure:
  - moves the original job to `retrying`
  - preserves phase progress
  - emits retry/error telemetry
  - does not duplicate external writes
  - updates integration health when appropriate
- Configure or document the Datadog monitor that fires from this telemetry.
- Ensure the Datadog incident created from the telemetry links back to the original job through `incidents.caused_by_job_id` when app-side correlation can identify it.
- Ensure smart investigation start automatically begins for the reliability-demo incident.
- Ensure the investigation cites Datadog and TrueFoundry evidence and identifies the induced rate limit as root cause or leading hypothesis.
- After the simulated/manual rate-limit fix, allow the original recommendation PR generation job to complete in the background.
- Add demo seed/reset tooling so the full path can be rehearsed repeatedly.
- Add final demo documentation with setup, env vars/secrets, fixtures, and a step-by-step runbook.

## Acceptance Criteria

- The full PRD demo path can be run from a clean seeded state.
- Forced retryable TrueFoundry/API failure does not lose job state or duplicate external writes.
- Retry/error telemetry includes Datadog-routable service/environment/workflow/integration/error tags.
- Datadog creates an incident from the telemetry monitor.
- Smart mode starts the reliability-demo investigation automatically and shows a "Started automatically" indicator.
- Investigation output distinguishes the induced rate limit/runtime configuration issue from a code defect and suggests the manual operational fix.
- The incident can resolve while the original recommendation PR generation job eventually succeeds.
- PR generation, incident investigation, incident resolution, and generated PR are separate but linkable console events.

## Automated Tests

- Add an end-to-end test or scripted integration test for the reliability demo path using fixtures/mocks where provider sandboxes are unavailable.
- Add tests for forced retry behavior and duplicate-write prevention.
- Add tests for telemetry-to-incident correlation.
- Add tests for smart auto-start of the reliability demo alert.
- Add tests that the final PR generation job can resume and succeed after the simulated rate-limit fix.

## Manual Verification

- Reset demo state.
- Approve a code-based recommendation PR generation.
- Trigger the forced retryable failure.
- Confirm the console shows retrying progress and Datadog receives telemetry.
- Confirm the Datadog alert webhook creates an incident and smart investigation starts automatically.
- Resolve/fix the simulated rate limit.
- Confirm incident resolution and background PR generation success.

## Progress Notes

- Update this section with TrueFoundry MCP deployment details, Datadog monitor setup, demo reset command, and any external provisioning still required.
