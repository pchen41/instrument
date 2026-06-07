# Task 9: Implement Datadog monitor analysis and approved draft alert creation

## Status

Slice 1 (approved draft-alert creation) **done + live-proven** (2026-06-07); slice 2
(monitor analysis — auto-generating alert recommendations) **remaining**.

The `datadog_alert_generation` executor creates a DRAFT (non-notifying) Datadog monitor
from an approved `alert` recommendation, mirroring the Task 8 approval-gated PR pattern.
Reviewed by Gemini + Codex (HIGH/MED/cheap-LOW applied; Claude's run failed to return).

- Files: `server/lib/datadog-alert.ts` (spec schema + metric-verification rule + draft
  payload), `server/lib/agent-ddalert.ts` (executor: inspect → draft_monitor → validate),
  `server/functions/_shared/ddalert-store.ts` (datadog MCP adapter + persistence), wired
  in `executors.ts`. Frontend "Create draft" button wired in `Recommendations.tsx`.
- Live e2e: drove request_approval (`create_monitor`) → decide_approval → enqueue as the
  demo user; job succeeded on attempt 1, step → `ready`,
  `metric_verification_state=verified_in_datadog`, generated_monitor linked a real draft
  monitor (us5, id 20351331), recovered via the marker tag (no duplicate). Monitor is
  non-notifying (no @-mentions). Metric-verification GATE proven to refuse unverified.
- Datadog MCP shapes (live): `create_datadog_monitor` returns
  `{"response":{"monitor":{"id":...}}}` (no url → built from site); `search_datadog_metrics`
  → JSON array of names (name_filter); `search_datadog_monitors` query `tag:"<marker>"`
  → JSON array (index-lagged right after create); all tools take a required (empty-OK)
  `telemetry` object.

### Remaining (slice 2)

Auto-generate `alert` recommendations within the existing scan/`recommendation_generation`
flow (NOT a new job type): read monitors/metrics/coverage, distinguish new-monitor vs
existing-monitor-improvement (latter = read-only diff), set each metric's verification
state, and write the monitor spec into the step's `proposed_payload` (which slice 1
consumes). The slice-1 demo rec was hand-seeded to exercise the generation path.

## Context

The PRD requires alert recommendations and human-approved Datadog alert
creation. The ERD notes that Datadog MCP `create_datadog_monitor` creates draft
monitors that do not send notifications; publishing notifying monitors is future
scope for the first product slice.

Depends on Tasks 3, 4, 5A, 5C, 5D, and 7. Datadog monitor analysis plugs into the
`recommendation_generation` jobs created by Task 7; do not add a separate
`datadog_monitor_analysis` job type.

## Requirements

- Read Datadog monitors, monitor configuration, alert history, metrics, logs, and service metadata where available.
- Store relevant monitor snapshots and metric verification evidence in
  `evidence_items` and recommendation step payloads; do not create a
  `datadog_monitors` cache table for the first product slice.
- Treat ownership, criticality, and notification routing as optional Datadog facts. Leave them null when absent.
- Verify alert recommendation metrics:
  - `verified_in_datadog` when the metric exists now.
  - `expected_after_step` only when a completed prerequisite instrumentation step added the metric.
  - `unverified` metrics must not be used for new alert creation.
- Within `recommendation_generation` jobs, generate alert recommendations that distinguish:
  - new monitor creation
  - existing monitor improvement
- For existing monitor improvements, show a reviewable configuration diff, but do not mutate existing monitors from Instrument unless the PRD changes.
- Add a confirmation flow for verified new-alert steps.
- Create `approvals` rows and store generated draft monitor state in the
  relevant `recommendations.steps` object for approved new-alert
  recommendations.
- Use approval idempotency keys so duplicate clicks or retried requests do not
  create multiple active approvals for the same recommendation step.
- Enqueue and run a durable `datadog_alert_generation` job for approved new-alert recommendations; do not create Datadog monitors directly from browser state.
- Execute Datadog draft monitor creation through the approved Datadog integration/MCP path.
- Record `external_write_actions` for Datadog writes.
- Store resulting Datadog monitor ID/link and `external_state = 'draft'` in the
  recommendation step JSON.
- Emit evidence items for monitor config, metric existence, alert history, and relevant code paths.
- Use the shared TrueFoundry AI Gateway/Agent API foundation from Task 5C for
  model-assisted monitor analysis. Persist `ai_model_calls`, tool summaries in
  `ai_model_calls.tool_calls_redacted`, and cited outputs as `evidence_items`.

## Acceptance Criteria

- Alert recommendations cite relevant monitor config, metric evidence, alert history, or code paths.
- A metric that cannot be verified does not produce a creatable Datadog alert unless the step is locked behind a prerequisite metric instrumentation step.
- Existing monitor improvements render as reviewable diffs and are manually completable/reviewable only.
- Creating a new Datadog monitor requires explicit approval.
- Approved creation stores a draft Datadog monitor result in the recommendation
  step with query, threshold, tags, service scope, known notification targets,
  and Datadog link or identifier.
- Approved creation shows durable job progress and handles retry/failure through `jobs`, not browser-local state.
- Recommendation step and lifecycle state update correctly after draft monitor creation.

## Automated Tests

- Add metric verification tests for verified, expected-after-step, and unverified states.
- Add tests that unapproved Datadog writes are rejected.
- Add approval idempotency tests for duplicate approve/request attempts.
- Add tests for generated monitor payload hashing and external write audit.
- Add job tests for `datadog_alert_generation` progress, retry, and failure handling.
- Add component tests for monitor diff drawer and draft monitor result state.

## Manual Verification

- Seed or fetch a metric with no monitor.
- Approve alert creation from the recommendation UI.
- Confirm Datadog returns a draft monitor ID/link and the console displays it.
- Confirm existing monitor improvement recommendations do not directly mutate Datadog.

## Progress Notes

- Update this section with Datadog MCP tool names, monitor payload shape, and any differences between draft and published monitor behavior.
