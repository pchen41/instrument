# Task 11: Implement incident investigation with evidence-backed AI output

## Status

Not started.

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

- Update this section with schema versions, MCP tools used, prompt files, and evidence collection limits.
