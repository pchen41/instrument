# Task 6: Implement GitHub webhook ingestion and automatic PR observability review comments

## Status

Complete (2026-06-07). Proven end-to-end live against a real PR on
`pchen41/instrument`: a `pull_request` webhook is verified + recorded, the worker
reads the diff through the github MCP, the TrueFoundry gateway analyzes it, and
exactly-once scoped inline comments post to the PR; cross-revision dedupe holds;
closing the PR archives the recommendation. Built in three committed slices
(beca9c8 ingestion, 5e3c7a3 analysis, 7ca771d lifecycle + live-smoke hardening),
each three-way reviewed (Claude/Codex/Gemini). Full suite green.

## Context

The PRD explicitly allows automatic GitHub PR observability review comments, but they must be scoped, deduplicated, auditable, and limited to configured repositories.

Depends on Tasks 2, 3, 5A, and 5C. Use the MCP and TrueFoundry Agent/API
foundation established in Task 5C. Task 4 consumes the PR review records in the
console but is not required for the backend webhook/commenting implementation.

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
- Upsert `repositories` and `github_pull_requests` from payload and GitHub
  reads. Store changed-file/comment evidence in `pr_review_comments` and
  `evidence_items`; do not create `github_pr_files`.
- Enqueue a `github_pr_review_analysis` job idempotently per PR revision/action.
- Analyze changed files plus relevant neighboring code before commenting.
- Produce only specific, actionable observability findings tied to changed file and line.
- Use the shared TrueFoundry AI Gateway/Agent API foundation from Task 5C for model-assisted analysis. Do not call model providers directly.
- Validate AI output against structured schemas before storing or posting.
- Persist `ai_model_calls` for generated findings/comments. Store MCP/tool
  summaries in `ai_model_calls.tool_calls_redacted`, cited read outputs in
  `evidence_items`, and writes in `external_write_actions`.
- Compute semantic and revision fingerprints as described in the ERD.
- Create or update `pr_review_comments` and category `pr_review`
  recommendations. Use `pr_review_comments.semantic_fingerprint` as the folded
  finding identity.
- Post scoped GitHub review comments through the approved GitHub integration/MCP path.
- Record every posted or skipped external write in `external_write_actions`; `approval_id` is allowed to be null only for `github_review_comment`.
- Build the GitHub webhook handler so it can later update generated recommendation PR state from merged/closed PR events in Task 8, even if this task only completes PR review behavior.
- Do not repost the same semantic finding on later PR revisions unless the file, code anchor, line placement, or suggested fix materially changes.

## Acceptance Criteria

- A PR introducing an observability gap gets concise comments that cite file and line.
- A PR with no meaningful observability gap gets no comments.
- Replaying the same webhook delivery does not create duplicate runs or comments.
- Re-analyzing the same PR revision does not duplicate comments.
- A later revision with the same unresolved gap updates the related
  `pr_review_comments`/recommendation state without posting a duplicate
  comment.
- The console shows PR review recommendation records with PR number, title, author, branch, comment count, comment body, and code locations.
- When a reviewed PR is merged, the related PR review recommendation is marked
  `outdated` and moved to archive for the first slice. Do not attempt semantic
  detection of whether the author applied the suggestion before merging.

## Automated Tests

- Add webhook signature verification tests with valid and invalid payloads.
- Add fixture tests for `opened`, `synchronize`, `ready_for_review`, and merged `closed` events.
- Add dedupe tests for delivery replay, revision replay, and cross-revision semantic duplicate.
- Add schema validation tests for PR finding/comment output.
- Add provenance tests that PR comments are linked to `ai_model_calls`, cited
  evidence, and `external_write_actions` where applicable.
- Add external write audit tests for posted and skipped duplicate comments.

## Manual Verification

- Configure a test GitHub webhook for the configured repository. For local
  development, use a webhook tunnel such as ngrok or send signed fixture
  requests directly to the local handler.
- Open or update a PR fixture with an observability gap.
- Confirm exactly one scoped review comment appears on GitHub.
- Refresh the console and confirm the PR review record is present.

## Progress Notes

- Webhook URL: `https://m5h8zr7r.us-east.insforge.app/functions/github-webhook`
  (the API host, not `*.functions.insforge.app`). Created on `pchen41/instrument`
  via the PAT (hook id 637650749), subscribed to `pull_request` + `push`
  (`push` is recorded + ignored until Task 7). Secret = `GITHUB_WEBHOOK_SECRET`
  (InsForge secret + gitignored CONFIG.md). The CONFIG.md PAT has Webhooks:RW but
  NOT Contents:RW — branch/file/PR writes go through the github MCP gateway
  credential (which Task 8 also uses), not the raw PAT.
- Architecture: pure libs `server/lib/github-webhook.ts` (verify/parse/redact/keys),
  `pr-review.ts` (findings schema + fingerprints + prompt), `agent-pr.ts`
  (fetch_diff→analyze→compose PhaseExecutor); Deno IO `_shared/github-webhook-store.ts`,
  `_shared/mcp-client.ts` (MCP Streamable-HTTP JSON-RPC), `_shared/pr-review-store.ts`.
  Dispatched by `_shared/executors.ts` into the worker tick.
- Schema versions: `pr_review_findings.v1` (model output), `pr_review_recommendation.v1`.
- Exactly-once: compose CLAIMS the posted `pr_review_comments` row by semantic
  fingerprint (partial-unique `(pull_request_id, semantic_fingerprint) WHERE
  status='posted'`) BEFORE the github MCP write; a marker (`<!-- instrument:pr-review -->`)
  reconciles the submit→commit crash window on resume.
- **Model caveats (live-discovered):** the gateway model `instrument/instrument`
  is `gemini-3.5-flash`, a REASONING model — needs `max_tokens` ~3000 (most of the
  budget is hidden reasoning_tokens) and `temperature: 0`, or the JSON truncates.
  It rewords `issue_type`/`fix_summary` between runs, so the semantic fingerprint
  uses file + code anchor + a CANONICAL issue kind (`issueKind()` buckets
  synonyms) — anchor-only would collapse two real gaps on one line; free-text
  issue_type would defeat cross-revision dedupe.
- Known limitations: dedupe is one comment per (file, anchor, issue kind) — two
  gaps that share all three collapse. A reopen-after-close + push can leave a
  duplicate physical GitHub comment (the prior comment can't be deleted via the
  allowlisted MCP tools); the recommendation lifecycle is corrected (reopen
  reactivates). Smoke PR #1 left closed with accumulated test comments.
