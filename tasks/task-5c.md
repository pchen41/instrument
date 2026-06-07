# Task 5C: Implement the TrueFoundry AI Gateway and MCP foundation

## Status

Complete (2026-06-06). The shared TrueFoundry model-call helper surface, the
structured-output schema-validation layer, and the non-secret MCP registry config
are in place and tested; the Render-hosted observability MCP server is live and
healthy, and GitHub/Datadog/instrument-investigation MCP servers are verified
through the TrueFoundry MCP Gateway with explicit read/write tool allowlists
recorded in `integrations.config`. The real Agent-API streamed tool-loop *invoker*
(`agent_responses` with live GitHub/Datadog tool calls) is intentionally deferred
to the provider workflow tasks (6/7/9/11/12) — `createAgentInvoker` throws for
that surface rather than silently returning a tool-less result. The model-call
helper itself is proven against faithful streamed fixtures (bounded
`tool_calls_redacted` + cited `evidence_items`).

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
- 2026-06-06: Built the shared app-side helper surface and verified the MCP
  registry live. This closes the remaining 5C work above.

  **Helper surface (downstream tasks 6/7/9/11/12 use these):**
  - `server/lib/model-call.ts` — `runModelCall(deps, spec)`: the single entry
    point for an AI call. Invokes the injected `AgentInvoker`, bounds streamed MCP
    tool calls into `ai_model_calls.tool_calls_redacted` (`summarizeToolCalls`,
    default caps 20 calls / 400 arg chars / 600 result chars), validates
    structured output, persists ONE full `ai_model_calls` row (response/trace/span
    ids, provider/model, `gateway_base_url_name`, `mcp_servers_requested`, usage,
    `cost_usd`, `latency_ms`, schema versions, `input_hash`, `output_redacted`,
    `validation_status`, and — on a gateway failure — a sanitized `status:failed`
    row), then persists cited `evidence_items` linked via `ai_model_call_id`.
    `api_surface` ∈ {`agent_chat_completions`, `agent_responses`}.
  - `server/lib/schema-validation.ts` — `SchemaRegistry` (zod) keyed by
    `output_schema_version`; `validate()` → `valid` | `invalid` |
    `not_applicable`. Release gates: `assertValidForDisplay` blocks `invalid`;
    `assertValidForExternalPosting` requires `valid` (rejects `invalid` AND
    `not_applicable`, so nothing reaches a provider without a registered schema).
    Task-specific schemas are registered by the workflow tasks that own them.
  - `server/lib/mcp-config.ts` — read-vs-write tool-allowlist partitioning
    (`KNOWN_WRITE_TOOLS` + mutating-prefix patterns), non-secret config builder,
    and `findSecretLikeValues` leak guard.
  - `server/functions/_shared/model-call-store.ts` — Deno IO edge:
    `createModelCallStore(admin)` (PostgREST full-row writer; returns the id;
    dedupes on the `(job_id, purpose)` unique index) and `createAgentInvoker()`
    (wraps the streaming gateway for `agent_chat_completions`; throws for
    `agent_responses` so the real tool loop is wired explicitly in provider tasks).
  - Tests: `schema-validation.test.ts` (8), `model-call.test.ts` (9, covering a
    non-tool fixture, a streamed tool-loop fixture, invalid-output rejection,
    sanitized failure persistence, and dedup), `mcp-config.test.ts` (7). Full
    suite 155 passing; `tsc` + function bundle green. The deployed 5B worker path
    is untouched.

  **Schema versions:** `request_schema_version` / `output_schema_version` are
  free-form strings set per call; 5C ships the registry mechanism only. The
  validation example used in tests is `incident_hypotheses.v1`; concrete
  task-owned schemas land in Tasks 6/7/9/11/12.

  **MCP registry verification (`scripts/verify-mcp.mjs`, live):** lists tools for
  each server through the TrueFoundry MCP Gateway and writes the non-secret config
  into `integrations.config`. Run dry by default; `--apply` to write. Reads the
  TrueFoundry gateway PAT from env `TFY_GATEWAY_PAT` (never printed/committed) and
  the InsForge admin key from `.insforge/project.json`. Verified 2026-06-06:
  - Render observability MCP `/healthz` → HTTP 200 `status: ok` (health `healthy`).
  - `github` MCP healthy: 44 tools (29 read / 15 write).
  - `datadog` MCP healthy: 40 tools (35 read / 5 write, incl.
    `create_datadog_monitor`).
  - `instrument-investigation` (read-only virtual MCP) healthy: 62 tools, 0 write.
  - Stored under `integrations.config`: per-server `server_url`, `read_only`,
    `allowed_tools.{read,write}`, `health`, `tool_source`, `last_checked_at`. The
    `truefoundry` row also carries `mcp_servers[]`, `observability_mcp`,
    `gateway_base_url`, `control_plane_url`, and `api_endpoints`. `github` /
    `datadog` rows carry a `mcp` block. All three integrations set to `connected`.
  - Model reconciliation: `config.model` set to the working inference name
    `instrument/instrument`; the prefixed `peterc:virtual-model:instrument/instrument`
    (which 403s on inference) is kept only as `model_fqn`.
  - A secret-leak guard runs before every write and a post-write scan confirmed no
    PAT/JWT/bearer/API-key value is present in any stored config column.

  **Secret names only (values never committed/printed):** `TRUEFOUNDRY_PAT`
  (gateway PAT, `integrations.secret_ref`), `GITHUB_TOKEN`, `DATADOG_API_KEY`.
  Render env (set in Render, names only): `TFY_CONTROL_PLANE_URL`,
  `TFY_API_TOKEN`, `TFY_TRACING_PROJECT_FQN`, `MCP_AUTH_TOKEN`,
  `MCP_ALLOWED_HOSTS`. See `docs/CONFIG.md` (gitignored) for values.

  **Deferred by design (provider tasks, not a 5C gap):** the live Agent-API
  streamed tool-loop invoker (`agent_responses`) that drives real GitHub/Datadog
  MCP tool calls; production OAuth / token passthrough / automated MCP
  registration. 5C proves the persistence + validation + governance surface those
  tasks build on.
- 2026-06-06 (review pass — Claude + Codex + Gemini static review): all three
  reviewed the helper surface, persistence, and methodology. Applied all HIGH +
  MED findings plus the cheap LOWs, then ran the live persistence smoke the
  Manual Verification step had skipped.
  - **Persistence path vs. real schema (HIGH).** `FakeStore` hid several NOT
    NULL/uuid violations that real Postgres rejects: `ai_model_calls.{integration_id,
    job_id, model_name, request_schema_version, output_schema_version}` and
    `evidence_items.subject_id (uuid)` are NOT NULL. Fixes: `createModelCallStore`
    now resolves `integration_id` per workspace (mirrors 5B) and coerces
    `model_name`→`'unknown'` / schema versions→`'none'`; `runModelCall` requires
    `jobId` and a UUID evidence `subjectId` (validated up front, no half-write).
    `FakeStore` in the test now enforces NOT NULL + uuid so this class can't pass
    green again.
  - **Failed-row poisoned the idempotency slot (HIGH).** A failed attempt and a
    later successful retry share the `(job_id, purpose)` unique index, so the
    success was being deduped onto the stale `failed` row. `saveModelCall` now
    upserts a `failed` row up to `succeeded` on conflict (a later failure never
    downgrades a recorded success).
  - **Secret-leak guard (MED, all three).** Value patterns were `^`-anchored
    (missed embedded tokens, `sk-proj-…`, bare `key`/unprefixed Datadog hex).
    Centralized in `server/lib/redaction.ts` (`\b`-anchored, broadened key+value
    patterns, `scrubSecrets`), shared by `mcp-config` + `model-call` and mirrored
    in `verify-mcp.mjs`. `tool_calls_redacted` and stored output are now scrubbed
    before truncation; the verify dry-run prints a redacted summary (never the
    full merged config).
  - **Write-tool classification (MED, all three).** Expanded the mutating-prefix
    list and known mutators (`fork_repository`, `request_copilot_review`,
    `unmute_datadog_monitor`, …); GitHub now classifies 26 read / 18 write
    (was 29/15). Config re-applied with the corrected allowlists.
  - **LOWs:** balanced/string-aware `extractJson`; `errorParts` no longer falls
    back to raw `err.message`; the failed-row save can't shadow the original
    gateway error; evidence carries a separate `collected_at`; `tool_source` added
    to the `McpServerConfig` type.
  - **Live persistence smoke (the omitted Manual Verification step).** Ran the
    real `createModelCallStore` + `runModelCall` against the dev DB via vite-node:
    freeform success (integration resolved, schema versions coerced), valid
    structured output + cited evidence (subject uuid, separate observed/collected
    timestamps), sanitized failure row, and failure→retry upsert to `succeeded` —
    6/6 checks, all throwaway rows cleaned up (0 left). This is what would have
    caught every HIGH; it now passes.
  - Result: full suite **165 passing**, `tsc` + function bundle green. `9d1bc61`
    (initial 5C) was local-only; these fixes land as a follow-up commit.
