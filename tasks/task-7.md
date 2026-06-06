# Task 7: Implement primary-branch scans and recommendation lifecycle management

## Status

Not started.

## Context

The demo requires proactive recommendations from primary-branch scans with dedupe, lifecycle states, active/archive views, and dependent steps.

Depends on Tasks 3, 4, 5, and 6 for webhook foundation.

## Requirements

- Extend GitHub webhook handling for `push` events.
- Record every push delivery in `inbound_webhooks` and normalized `github_push_events`.
- Trigger proactive scans only for the configured primary branch.
- Implement cooldown/coalescing using `workspace_settings.primary_branch_scan_cooldown_seconds`.
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
- The overall recommendation system must support categories `instrumentation`, `alert`, and `pr_review`. Primary-branch scans usually create `instrumentation` and `alert` recommendations; `pr_review` recommendations are normally created by Task 6 and should be preserved/deduped correctly by lifecycle code.
- Use the shared TrueFoundry AI Gateway/Agent API foundation from Task 5 for model-assisted recommendation generation. Do not call model providers directly.
- Validate recommendation output against structured schemas before display.
- Persist `ai_model_calls` for generated recommendations and `mcp_tool_invocations` for any MCP-backed evidence collection.
- Compute stable `dedupe_fingerprint` values and update existing recommendations instead of creating duplicates.
- Preserve lifecycle history in `recommendation_events`.
- Move stale findings to `outdated` with `outdated_reason` when code or monitor context invalidates them.
- Keep active and archived recommendations separated in the UI through Task 4 data surfaces.
- Emit `app_events` when recommendations are created, updated, accepted, dismissed, restored, or marked outdated.

## Acceptance Criteria

- A primary-branch push creates or coalesces a scan according to cooldown.
- Stable findings across scans do not reappear as new recommendations.
- A changed/removed code path can mark a previous recommendation `outdated` with a clear reason.
- A new recommendation appears in the active recommendations view without browser refresh.
- A recommendation becomes `accepted` only after all required steps are done.
- A dependent alert step remains locked until its prerequisite instrumentation step completes.
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

- Update this section with scan triggers, cooldown behavior, schema versions, and known recommendation generation limits.
