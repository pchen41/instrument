# Task 11: Implement incident investigation with evidence-backed AI output

## Status

**Done + live-proven (2026-06-07).** The `incident_investigation` job runs a
READ-ONLY, evidence-backed RCA: it gathers verified signals through the federated
`instrument-investigation` MCP (github + datadog read tools, ZERO write tools),
makes one schema-validated TrueFoundry model call to rank hypotheses, then resolves
every cited evidence key to a verified `evidence_items` id before writing
`incidents.hypotheses`. Reviewed by Gemini + Codex (Claude hung); HIGH/MED/LOW
applied.

- Files: `server/lib/agent-investigate.ts` (pure core + `incident_hypotheses.v1`
  schema + executor), `server/functions/_shared/investigate-store.ts` (read-only
  MCP adapter + PostgREST persistence), wired in `executors.ts`; the worker's
  placeholder `finalizeIncident` is skipped for real investigations
  (`server/lib/worker.ts`); the frontend hypothesis schema gained
  `instrument_can_fix` / `no_fix_reason` / `suggested_next_step`
  (`src/lib/schemas/incidents.ts`).
- Live e2e (a console-sourced investigation on an active incident, 1 phase/tick to
  prove cross-tick resume): triage → gather (8 commits via `list_commits_githuvn`)
  → correlate (correlated_changes w/ GitHub URLs + evidence ids) → hypotheses
  (model call valid against `incident_hypotheses.v1`) → summarize. The leading
  hypothesis cited 8 verified evidence ids, confidence `low` (not over-claimed),
  `instrument_can_fix=false` with a folded no-fix reason + suggested next step.
- Graceful degradation proven: the TrueFoundry observability MCP is unreachable
  from the worker (no `MCP_AUTH_TOKEN`), so its telemetry is recorded as
  `unavailable` evidence and the Datadog/GitHub-backed investigation still
  completes. Invalid model output falls back to a single low-confidence
  "inconclusive" hypothesis (never a crash, never a fabricated cause).
- The investigation is read-only by construction: the federated MCP has 0 write
  tools and the adapter fails closed unless the server advertises a non-empty
  read-only allowlist; the executor exposes no branch/PR/monitor/approval/job
  creation path.

## Context

Incident investigations are read-only in every investigation-start mode. They must never auto-generate or apply fixes. The output must be structured, validated, evidence-backed, and careful about confidence.

Depends on Tasks 5A, 5B, 5C, and 10. Uses the shared TrueFoundry AI/MCP
foundation and minimal Instrument observability MCP server from Task 5C, plus the
GitHub/Datadog integration configuration from Tasks 2, 6, and 9. Task 12
hardens the reliability-validation path, but the core MCP registration should
not be deferred past this investigation task.

## Requirements

- Implement the `incident_investigation` job.
- Read incident source data:
  - Datadog alert payload and monitor configuration.
  - Datadog logs, metrics, service tags, traces when available.
  - GitHub commits, PRs, files, diffs, and recent deploy-related changes.
  - TrueFoundry MCP/LLM logs and metrics when relevant.
- Use TrueFoundry AI Gateway/Agent API for AI calls; do not call model providers directly from app code.
- Attach only allowed MCP servers/tools with bounded iteration limits.
- Persist `ai_model_calls`, bounded tool summaries in
  `ai_model_calls.tool_calls_redacted`, and `evidence_items` for all cited
  evidence.
- If the Instrument-owned TrueFoundry observability MCP server or provider
  credentials are unavailable at runtime, still complete Datadog/GitHub-backed
  investigations and surface the missing TrueFoundry source as a degraded
  integration or unavailable evidence, rather than blocking all investigations.
- Validate structured investigation output before updating `incidents.hypotheses`.
- Store ranked hypotheses with:
  - rank
  - title
  - reasoning
  - confidence: `high`, `likely`, or `low`
  - evidence IDs
  - root cause type
  - whether Instrument can fix it
  - no-fix reason and suggested next step when applicable
- Use UI labels:
  - "Root cause" only for high confidence.
  - "Leading hypothesis" otherwise.
- Distinguish verified facts, inferred hypotheses, and suggested actions.
- Explain when the root cause is outside the codebase or not fixable by Instrument.
- Update incident signals, timeline, correlated changes, and final investigation state.
- Preserve failure state with retry when the job fails safely.

## Acceptance Criteria

- Completed investigations show hypotheses, confidence, evidence, key signals, timeline, and correlated code changes where available.
- Evidence citations point to verified `evidence_items`.
- The system does not cite unavailable, stale, or unverified evidence as fact.
- Runtime configuration/upstream causes produce a no-code-fix explanation and suggested next step.
- Investigation jobs are read-only and do not create branches, PRs, monitors, or other external writes.
- Missing or degraded TrueFoundry MCP/provider access degrades the TrueFoundry
  evidence portion but does not prevent a Datadog/GitHub-backed investigation
  from completing.
- Failed investigations preserve progress and expose retry when safe.

## Automated Tests

- Add schema validation tests for incident investigation output.
- Add tests that every displayed hypothesis evidence ID exists and is verified or explicitly marked stale/unavailable in copy.
- Add confidence-label mapping tests.
- Add no-fix output tests for runtime/upstream causes.
- Add tests that investigation jobs cannot enqueue or execute external write actions.

## Manual Verification

- Start an investigation from an active incident.
- Confirm named phases update while the job runs.
- Confirm final incident detail shows evidence-backed hypotheses.
- Test an upstream/runtime fixture and confirm no fix action is offered.

## Progress Notes

- **Schema:** model output validated against `incident_hypotheses.v1` (registered in
  `server/lib/agent-investigate.ts`): `{summary, hypotheses:[{title, reasoning,
  confidence(high|likely|low), root_cause_type(code|runtime_config|upstream|unknown),
  instrument_can_fix, evidence_keys[], no_fix_reason?, suggested_next_step?}]}`.
  Required array root (non-array → invalid); per-item lenient (drop the malformed
  one, keep the batch). Request schema label `incident_investigation_request.v1`.
- **MCP tools (read-only federated `instrument-investigation` server, suffixed
  names):** `list_commits_githuvn` (recent commits / deploy candidates),
  `get_datadog_trace_datade8` (when the alert carried a `trace_id`),
  `search_datadog_logs_datade8` (service error logs). The adapter asserts each tool
  is in the server's read allowlist and fails closed if the server isn't a
  non-empty read-only registration.
- **Model:** `agent_chat_completions` through the TrueFoundry gateway, gemini-3.5-flash,
  `max_tokens 3000` (a reasoning model that emits a preamble before the JSON — a
  tighter cap truncates it → invalid; this matches the Tasks 6/9 budget), gateway
  temperature 0. Prompt instructs JSON-only, no preamble.
- **Evidence:** gathered facts persisted as `evidence_items` (`commit`,
  `datadog_trace`, `datadog_log`) verified; TrueFoundry recorded as a single
  `unavailable` row. Hypotheses cite verified evidence only — selection resolves
  each cited key against the exact key→id snapshot the model was shown (stored with
  the output) and drops unresolvable/unverified citations. Caps: ≤8 commits, ≤20
  facts in the prompt, ≤5 hypotheses, ≤8 evidence ids per hypothesis.
- **Confidence/labels:** "Root cause" only when the leading hypothesis is `high`
  (UI `rootTitle`); `high` is capped to `likely` when no verified evidence backs it.
  A non-code or unfixable cause gets `instrument_can_fix=false` plus a no-code-fix
  explanation + suggested next step folded into `detail`.
- **Idempotency/resume:** evidence unique on `(collected_by_job_id, subject_key)`;
  model call on `(job_id, purpose)`; the hypotheses phase short-circuits if its
  output evidence already exists (no gateway re-bill). Each phase is independently
  resumable across bounded-phase ticks.
- **Worker gate:** real investigations (`trigger_summary.source` ∈ {console,
  datadog_alert}) own their write-back; the 5A placeholder `finalizeIncident` only
  runs for seeded/simulated jobs (and now uses a valid `finding` timeline kind).
