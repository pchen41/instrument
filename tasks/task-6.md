# Task 6: Implement GitHub webhook ingestion and automatic PR observability review comments

## Status

Not started.

## Context

The PRD explicitly allows automatic GitHub PR observability review comments, but they must be scoped, deduplicated, auditable, and limited to configured repositories.

Depends on Tasks 2, 3, and 5.

## Requirements

- Add a GitHub webhook handler for `pull_request` events:
  - `opened`
  - `reopened`
  - `synchronize`
  - `ready_for_review`
  - `closed` for merge/lifecycle updates
- Validate `X-Hub-Signature-256` and store redacted delivery records in `inbound_webhooks`.
- Use `X-GitHub-Delivery` as `external_delivery_id` and `X-GitHub-Event` as `event_type`.
- Ignore or reject unverified webhooks before creating jobs or downstream rows.
- Upsert `repositories`, `github_pull_requests`, and `github_pr_files` from payload and GitHub reads.
- Enqueue a `github_pr_review_analysis` job idempotently per PR revision/action.
- Analyze changed files plus relevant neighboring code before commenting.
- Produce only specific, actionable observability findings tied to changed file and line.
- Validate AI output against structured schemas before storing or posting.
- Compute semantic and revision fingerprints as described in the ERD.
- Create or update `pr_review_findings`, `pr_review_comments`, and category `pr_review` recommendations.
- Post scoped GitHub review comments through the approved GitHub integration/MCP path.
- Record every posted or skipped external write in `external_write_actions`; `approval_id` is allowed to be null only for `github_review_comment`.
- Do not repost the same semantic finding on later PR revisions unless the file, code anchor, line placement, or suggested fix materially changes.

## Acceptance Criteria

- A PR introducing an observability gap gets concise comments that cite file and line.
- A PR with no meaningful observability gap gets no comments.
- Replaying the same webhook delivery does not create duplicate runs or comments.
- Re-analyzing the same PR revision does not duplicate comments.
- A later revision with the same unresolved gap updates `last_seen_head_sha` without posting a duplicate comment.
- The console shows PR review recommendation records with PR number, title, author, branch, comment count, comment body, and code locations.
- When a reviewed PR is merged without applying the recommendation, the related PR review recommendation can be marked `outdated` and moved to archive.

## Automated Tests

- Add webhook signature verification tests with valid and invalid payloads.
- Add fixture tests for `opened`, `synchronize`, `ready_for_review`, and merged `closed` events.
- Add dedupe tests for delivery replay, revision replay, and cross-revision semantic duplicate.
- Add schema validation tests for PR finding/comment output.
- Add external write audit tests for posted and skipped duplicate comments.

## Manual Verification

- Configure a test GitHub webhook for the demo repository.
- Open or update a PR fixture with an observability gap.
- Confirm exactly one scoped review comment appears on GitHub.
- Refresh the console and confirm the PR review record is present.

## Progress Notes

- Update this section with webhook URL, fixture names, schema versions, and any GitHub/MCP caveats.
