# Task 5C: Implement the TrueFoundry AI Gateway and MCP foundation

## Status

Not started.

## Context

Later workflow tasks use TrueFoundry AI Gateway or Agent API for AI calls and
TrueFoundry MCP Gateway for governed access to GitHub, Datadog, and
Instrument-owned observability tools. This task establishes that shared
foundation without implementing task-specific prompts or provider workflows.

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
  server with bounded read-only tools for model metrics, MCP metrics, request
  logs/spans, and existing evidence bundles.
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

## Manual Verification

- Invoke a simple TrueFoundry model-call fixture or real development call.
- Confirm `ai_model_calls` and cited `evidence_items` are written.
- Confirm MCP FQNs/tool allowlists are visible in non-secret integration config,
  or integration state explains what is missing.
- Confirm the Instrument observability MCP server can answer a bounded health or
  evidence-bundle request.

## Progress Notes

- Update this section with helper locations, schema versions, MCP registration
  notes, Instrument observability MCP server location, and any provider caveats.
