# Task 5C: Implement the TrueFoundry AI Gateway and MCP foundation

## Status

In progress.

## Context

Later workflow tasks use TrueFoundry AI Gateway or Agent API for AI calls and
TrueFoundry MCP Gateway for governed access to GitHub, Datadog, and
Instrument-owned observability tools. This task establishes that shared
foundation without implementing task-specific prompts or provider workflows.
For the demo, keep the Instrument-owned observability MCP server deliberately
small: host it on Render as a Python/FastMCP Streamable HTTP service, protect it
with a shared bearer/header secret, and register it manually in TrueFoundry MCP
Gateway. Production OAuth, token passthrough, automated registration, and richer
tool governance are deferred until after the validation path is proven.

Depends on Tasks 0, 2, 5A, and the runtime decision from Task 5B.

## Requirements

- Add shared server-side TrueFoundry AI Gateway/Agent API helpers.
- Ensure application model calls go through TrueFoundry, not direct model-provider
  SDKs.
- Persist an `ai_model_calls` row for every model call.
- Persist response IDs, model/provider names, schema versions, trace/span IDs,
  usage, latency, validation state, redacted output summaries, and relevant error
  state.
- When an Agent API call streams MCP tool calls/results, persist bounded summaries
  in `ai_model_calls.tool_calls_redacted`.
- Persist cited tool outputs and model-supported facts as `evidence_items`.
- Add helpers for validating task-specific structured output schemas before
  display or external posting. Task-specific schemas and prompts are added in
  Tasks 6, 7, 9, 11, and 12.
- Verify or register GitHub MCP and Datadog MCP through TrueFoundry MCP Gateway
  with explicit read/write tool allowlists.
- Store MCP server FQNs, server URLs, allowed toolsets, and health state in
  `integrations.config` without storing secrets.
- Implement or deploy a minimal Instrument-owned TrueFoundry observability MCP
  server as a Render-hosted Python/FastMCP web service with `/mcp` and
  `/healthz`. The demo service should expose bounded read-only tools for model
  metrics, MCP metrics, request logs/spans, and a health check. Existing
  evidence-bundle lookup may be a clear stub until server-backed evidence APIs
  exist.
- Add a minimal Render deployment shape, such as `render.yaml` plus
  `requirements.txt`, using Render env vars for TrueFoundry credentials and the
  demo MCP bearer/header token. Do not commit secret values.
- Register the Render `/mcp` URL in TrueFoundry MCP Gateway manually for the
  demo. Capture only the non-secret FQN, proxy/server URL, health status, and
  allowed tools in app config or task notes.
- The Instrument observability MCP server can start minimal here and be expanded
  in Task 12, but its FQN and health should be known before incident
  investigation work starts.

## Acceptance Criteria

- Shared TrueFoundry model-call helpers can create a validated `ai_model_calls`
  row for a non-tool response fixture.
- A streamed Agent/API fixture stores bounded `tool_calls_redacted` summaries and
  cited `evidence_items`.
- GitHub MCP, Datadog MCP, and the minimal Instrument observability MCP server
  have non-secret registration/config stored in `integrations.config`, or the
  corresponding integration is explicitly marked degraded/missing credentials.
- The Render-hosted Instrument observability MCP server responds on `/healthz`
  and can serve at least one bounded TrueFoundry-backed tool call through
  TrueFoundry MCP Gateway.
- No provider tokens, TrueFoundry PAT/VAT values, MCP credentials, or InsForge
  admin keys are stored in relational columns or browser-visible env vars.
- Downstream tasks have a documented helper/API surface for model calls, tool
  summaries, evidence persistence, and schema validation.

## Automated Tests

- Add tests for the shared TrueFoundry AI/Agent API persistence helpers using a
  non-tool response fixture.
- Add tests for streamed tool-call fixtures and bounded summary persistence.
- Add evidence persistence tests for cited MCP results.
- Add tests that invalid structured model output is rejected before display or
  external posting.
- Add MCP config tests for FQNs, tool allowlists, and secret-free integration
  config.
- Add focused tests for the demo MCP server's bounds, redaction, and mocked
  TrueFoundry HTTP calls. Do not build production OAuth tests in this task.

## Manual Verification

- Invoke a simple TrueFoundry model-call fixture or real development call.
- Confirm `ai_model_calls` and cited `evidence_items` are written.
- Confirm MCP FQNs/tool allowlists are visible in non-secret integration config,
  or integration state explains what is missing.
- Confirm the Render-hosted Instrument observability MCP server answers
  `/healthz`, appears healthy in TrueFoundry MCP Gateway, and can answer a
  bounded metric/log request.

## Progress Notes

- Update this section with helper locations, schema versions, Render service
  name/URL, MCP registration notes, Instrument observability MCP server
  location, and any provider caveats. Record secret names only, never values.
- 2026-06-06: Added the demo Instrument observability MCP server under
  `services/truefoundry-mcp/`. It is a Render-targeted Python/FastMCP service
  with `/healthz`, `/mcp`, shared bearer/header auth, bounded TrueFoundry
  model/MCP metrics tools, request-log/span tools, and a stub evidence-bundle
  tool. Root `render.yaml` defines the Render web service and secret env var
  names only. Local helper tests pass with `python3 -m unittest discover -s
  tests` from the service directory. Live Render deploy and TrueFoundry MCP
  Gateway registration are still pending.
- 2026-06-06: TrueFoundry observability MCP server is created and verified for
  the demo. Public Render base URL is `https://instrument-9z6j.onrender.com`;
  MCP endpoint is `https://instrument-9z6j.onrender.com/mcp`; health endpoint is
  `https://instrument-9z6j.onrender.com/healthz`. TrueFoundry control-plane URL
  for observability APIs is `https://peterc.truefoundry.cloud`; configure this
  as `TFY_CONTROL_PLANE_URL` in Render. TrueFoundry MCP Gateway can list the
  server tools. A local live MCP invocation of `query_truefoundry_mcp_metrics`
  against the control plane succeeded and returned MCP metrics grouped by
  `method` for `tools/list`, `initialize`, and `tools/call`. Logging now records
  redacted MCP tool starts/success/errors and TrueFoundry request
  start/complete/failure details. Remaining Task 5C work: shared AI
  Gateway/Agent API helpers, `ai_model_calls` persistence, streamed tool-call
  summary persistence, cited `evidence_items`, structured-output validation,
  GitHub/Datadog MCP verification, and writing non-secret MCP config into
  `integrations.config` once the app schema path is ready.
