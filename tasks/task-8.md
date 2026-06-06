# Task 8: Implement approved recommendation PR generation

## Status

Not started.

## Context

Generated recommendation PRs are in demo scope, but only after explicit human approval. Incident fix PR generation is future scope and should not be implemented here.

Depends on Tasks 3, 4, 5, and 7.

## Requirements

- Add a confirmation flow for code-based recommendation steps of kind `code_pr`.
- Create an `approvals` row before starting any external write.
- Hash the approved redacted payload and require `external_write_actions.request_hash` to match it during execution.
- Enqueue a `recommendation_pr_generation` job for the approved step.
- Generate a clear branch name, PR title, summary, changed files, and evidence-linked PR body.
- Create or reuse `generated_pull_requests` rows.
- Execute provider writes idempotently:
  - create branch
  - create/update file(s)
  - create pull request
- Record each external write in `external_write_actions`.
- Persist patch hashes/excerpts and file change summaries, but leave GitHub as the source of truth for full diffs.
- Update recommendation step state from available/generating/ready/done/failed.
- Keep a generated PR step incomplete until the PR is actually merged or the user marks an allowed non-mutating step complete.
- Sync generated PR state when GitHub reports opened, merged, closed, or stale.
- Preserve progress and avoid duplicate branches, commits, or PRs when retrying after a GitHub/TrueFoundry failure.

## Acceptance Criteria

- The UI asks for explicit approval before PR generation.
- Rejecting approval leaves the recommendation unchanged.
- Approved PR generation shows named job phases and survives refresh.
- A retryable provider failure does not duplicate branch/file/PR writes.
- A generated PR record includes branch name, PR title, summary, changed files, and evidence linking back to the recommendation.
- Opening a PR does not by itself mark the recommendation accepted.
- Merging the generated PR marks the step done, and marks the recommendation accepted only if all required steps are done.

## Automated Tests

- Add approval-gate tests that reject unapproved external writes.
- Add request-hash mismatch tests.
- Add idempotency tests for branch/create file/create PR retry.
- Add generated PR state transition tests for opened, merged, closed, and stale.
- Add UI/component tests for confirmation, progress drawer, opened PR drawer, and merged state.

## Manual Verification

- Start from a seeded code-based recommendation.
- Approve PR generation.
- Confirm job progress appears and persists after refresh.
- Confirm the GitHub PR opens with the expected branch/title/body/files.
- Mark or sync the PR as merged and confirm recommendation lifecycle updates.

## Progress Notes

- Update this section with generated branch naming rules, PR body template, and external write action kinds used.
