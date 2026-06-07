# Task 7: Implement primary-branch scans and recommendation lifecycle management

## Status

Core complete + proven live (2026-06-07), one acceptance criterion remaining.
Two committed slices: b895470 (push ingestion → proactive_scan enqueue with
cooldown/coalescing) and 126f6a2 (proactive_scan executor → instrumentation
recommendations). Proven end-to-end live: a manually-enqueued scan of a real
commit produced 2 gateway-generated instrumentation recommendations
(`recommendations`, category `instrumentation`), deduped by a stable
dedupe_fingerprint; the push→enqueue/coalesce IO + the get_commit MCP read +
recommendation insert/dedupe were verified against the live dev DB.

**Remaining (not yet built):** the outdating side of lifecycle management — marking
a prior recommendation `outdated` (with `outdated_reason`) when a later scan shows
the code/monitor context that justified it has changed or been removed. The
create/update/dedupe + active-view path is done; the invalidation path is not.
Also not yet done: a real primary-branch (main) push has not been fired (the live
scan was enqueued directly to avoid pushing to main), and the 3-way code review.

## Context

The first product slice requires proactive recommendations from primary-branch
scans with dedupe, lifecycle states, active/archive views, and dependent steps.

Depends on Tasks 3, 5A, 5C, and 6 for webhook and worker/AI foundation. Task 4
consumes recommendation state in the console but is not required for backend scan
and lifecycle implementation.

## Requirements

- Extend GitHub webhook handling for `push` events.
- Record every push delivery in `inbound_webhooks`; store push SHA/range and
  coalescing metadata in `jobs.trigger_summary`.
- Trigger proactive scans only for the configured primary branch.
- Implement cooldown/coalescing using
  `workspaces.primary_branch_scan_cooldown_seconds`.
- Enqueue `proactive_scan` and/or `recommendation_generation` jobs idempotently for the newest commit SHA after cooldown.
- Read repository code, relevant service path mappings, existing recommendations, Datadog evidence, and PR review history.
- Generate recommendations with:
  - title
  - category
  - rationale
  - evidence
  - affected service/code/runtime path
  - proposed next step
  - ordered dependent steps when needed
- The overall recommendation system must support categories `instrumentation`,
  `alert`, and `pr_review`. Primary-branch scans own the
  `recommendation_generation` jobs that create or update recommendations.
  Datadog monitor/metric analysis from Task 9 plugs into these
  `recommendation_generation` jobs; do not introduce a separate
  `datadog_monitor_analysis` job type. `pr_review` recommendations are normally
  created by Task 6 and should be preserved/deduped correctly by lifecycle code.
- Use the shared TrueFoundry AI Gateway/Agent API foundation from Task 5C for model-assisted recommendation generation. Do not call model providers directly.
- Validate recommendation output against structured schemas before display.
- Persist `ai_model_calls` for generated recommendations. Store MCP/tool
  summaries in `ai_model_calls.tool_calls_redacted` and cited read outputs in
  `evidence_items`.
- Compute stable `dedupe_fingerprint` values and update existing recommendations instead of creating duplicates.
- Preserve lifecycle history in `recommendations.lifecycle_events`.
- Move stale findings to `outdated` with `outdated_reason` when code or monitor context invalidates them.
- Keep active and archived recommendations separated in the UI through Task 4 data surfaces.
- Update recommendation timestamps and relevant job `progress_version` values so
  Task 4 polling can surface created, updated, accepted, dismissed, restored, or
  outdated recommendations.

## Acceptance Criteria

- A primary-branch push creates or coalesces a scan according to cooldown.
- Stable findings across scans do not reappear as new recommendations.
- A changed/removed code path can mark a previous recommendation `outdated` with a clear reason.
- A new recommendation appears in the active recommendations view without browser refresh.
- A recommendation becomes `accepted` only after all required steps are done.
- A dependent alert step remains locked until its prerequisite instrumentation step completes.
- The first slice does not require proving that a merged instrumentation PR was
  deployed and emitted a metric in Datadog. Live dependent-step unlocking may be
  demonstrated through explicit step completion or seeded state; Datadog metric
  verification for alert creation is handled in Task 9.
- Dismissed recommendations are archived and restorable; outdated recommendations are archived and not treated as restorable unless product scope changes.

## Automated Tests

- Add push webhook fixture tests for primary branch, non-primary branch, deleted branch, and forced push.
- Add cooldown/coalescing tests.
- Add recommendation dedupe tests across repeated scans.
- Add provenance tests that generated recommendations reference their validating `ai_model_calls` and evidence items.
- Add lifecycle transition tests for active, accepted, dismissed, and outdated.
- Add step prerequisite/locking tests.

## Manual Verification

- Send a primary-branch push fixture.
- Confirm a scan job is created and visible through persisted job state.
- Confirm active recommendations update after completion.
- Trigger the same scan again and confirm no duplicate recommendations appear.

## Progress Notes

- Trigger: `push` to the repo's `default_branch` (the github-webhook is subscribed
  to pull_request + push). Cooldown/coalescing via
  `workspaces.primary_branch_scan_cooldown_seconds` (30s): same head SHA → skip; an
  in-flight scan → stamp newest SHA as `trigger_summary.pending_sha`, and the
  running scan enqueues ONE follow-up for it when it finishes; a scan that finished
  within the cooldown → enqueue deferred. Idempotency key `scan:{repoId}:{sha}`.
- Architecture: pure `server/lib/scan.ts` (instrumentation findings schema +
  `scanDedupeFingerprint` + prompt) + `agent-scan.ts` (enumerate→analyze→rank
  PhaseExecutor); Deno IO `_shared/scan-store.ts` (get_commit MCP read +
  recommendation upsert). Dispatched via `_shared/executors.ts`. Schema version
  `instrumentation_findings.v1`; recommendation `validated_schema_version`
  `recommendation.v1`. Dedupe reuses the Task 6 `issueKind()` bucketing + the
  `recommendations_dedupe_uniq` unique index.
- Three-way reviewed (Claude/Codex/Gemini). Applied: rank reads the LIVE
  `pending_sha` (not the frozen claim-time snapshot — the unanimous HIGH);
  `markScanPending` is state-guarded + the webhook enqueues a fresh scan if the
  coalesce target already finished; a failed same-SHA scan is skipped (not falsely
  re-reported); analyze has a resume guard so it can't re-bill the gateway; scan
  evidence subject is repository-scoped; `affected_code_path` is scrubbed.
- **Known limitations (documented, not yet built):** (1) the OUTDATING side of
  lifecycle — marking a prior recommendation `outdated` when its code/context is
  gone — is not implemented (create/update/dedupe is). (2) `enumerate` reads only
  the head commit (`get_commit(after_sha)`); a multi-commit / coalesced push's
  intermediate commits aren't scanned (the `before..after` range is stored but not
  read). (3) Two near-simultaneous distinct-SHA pushes can briefly run two scans
  (the `scan:repo:sha` key only collapses identical SHAs; recommendation dedupe
  still prevents duplicate rows, so the only cost is wasted gateway spend). (4) the
  push path doesn't refresh `repositories.default_branch`. A real primary-branch
  (main) push hasn't been fired — the live e2e enqueued a scan of a real commit
  directly (2 instrumentation recommendations generated + deduped).
