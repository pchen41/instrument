# Task 8: Implement approved recommendation PR generation

## Status

Complete (2026-06-07), 3-way reviewed (Claude/Codex/Gemini, two fix rounds).
The `recommendation_pr_generation` executor generates an approved instrumentation
PR through the governed github MCP path. Committed: 25394d4 (executor + merge sync)
+ two review-fix commits. New IO live-verified (get_file_contents read+decode, the
approval-gated external_write_actions insert, the merge-sync scan); the branch/file/
PR MCP writes are already proven live (Task 6). A full real generated-PR e2e was
not fired (needs a main target file + cleanup), but every component is verified.

### UI wiring follow-up (2026-06-07, 3-way reviewed)

The executor was complete but the **console never invoked it** — the "Generate PR"
button was a Task 5A deferred stub, and Task 7 instrumentation recs were created with
ZERO steps so no button rendered. Fixed + 3-way reviewed:

- `scan-store.ts`: instrumentation recs are created (and back-filled on re-scan when
  step-less) with a single `code_pr` step keyed `generate-pr` — shape matches the
  executor's materialized step exactly, so the approval's `target_step_key` lines up
  and `updateStep` finds it instead of materializing a duplicate. A one-off SQL
  backfill added the step to the two already-deployed step-less recs.
- `src/data/actions.ts`: `requestApproval` / `decideApproval` / `enqueueGeneration` +
  an `approveAndGenerate` helper (request → approve → enqueue) behind one confirm.
- `Recommendations.tsx`: the `code_pr` "Generate PR" button now opens a ConfirmDialog
  (explicit approval) → `approveAndGenerate(target_step_key=step.key)`; a `submittingKey`
  guard disables it during the in-flight calls. Datadog monitor creation stays a
  deferred stub until Task 9.
- Review hardening: `decideApproval` is now idempotent (same-state re-approve with a
  matching payload → ok; mismatch → 409 `stale_payload`); `requestApproval` rejects a
  `target_step_key` that isn't an existing step of the action-compatible kind
  (`step_not_found` / `step_kind_mismatch`), closing the forged-key materialization gap.
- Live-verified end-to-end through the deployed `console-actions` as the demo user:
  request → approve → enqueue created a `recommendation_pr_generation` job with
  `target_step_key=generate-pr`; the executor accepted the approval binding and ran all
  phases.

### Full real generated-PR e2e (2026-06-07) — the long-standing Task 8 gap, now closed

Seeded a real target file `instrument-smoke/checkout.ts` on `main` (created via the
github MCP `create_or_update_file`, so it's one isolated commit — `3d80d5b` — that does
NOT push local `f2a909f`). Then drove both demo recs through the approval flow:

- "Add distributed tracing to checkout handler" → **PR #2** (OpenTelemetry span around
  `checkout`, closed in a `finally`, records exceptions).
- "Track checkout transaction volume and latency" → **PR #4** (counter metric).

Both steps are now `ready` with `generated_pr` linked; the console shows "View PR #N".

**`parsePr` bug found + fixed (covered by `prgen-store.test.ts`):** the github MCP's
`create_pull_request` returns `{"id":"...","url":".../pull/<n>"}` with **NO `number`
field**, so `parsePr` returned null → `github_pr_unparsed`, failing every generation's
first handoff attempt (it only succeeded on retry via the `list_pull_requests` recovery
path, which DOES include `number`). Fix: derive the PR number from the URL's trailing
`/pull/<n>` when the explicit field is absent. Verified live (captured the exact
response shape) + deterministic unit test. job-worker-tick redeployed with the fix.

## Progress Notes

- Flow: 5A approval (`request_approval` action_type `generate_pr` → `decide_approval`
  approved → `enqueue_generation` → `recommendation_pr_generation` job with
  trigger_summary.approval_id + target_id=recommendation + target_step_key). The
  executor (`server/lib/agent-prgen.ts`, IO `_shared/prgen-store.ts`): plan verifies
  the approval matches THIS rec/step/workspace + is `approved` + has a payload hash,
  snapshots the target file (MCP get_file_contents); compose_patch generates the
  full instrumented file via the gateway (`pr_gen_patch.v1`, maxTokens 4000);
  handoff writes branch → the SINGLE approved file → PR via the github MCP.
- Governance: each write is an external_write_actions row with approval_id +
  request_hash = approved_payload_hash; the idempotency key is bound to the approval
  hash; the approval is re-asserted before EACH write; ONLY the approved baseline
  file path is ever written (a model/injected extra path is refused). Writes are
  idempotent (branch already-exists = ok; PR recovered via list_pull_requests; file
  skipped if the branch already has the content). PR title + commit + body scrubbed.
- Step lifecycle: handoff leaves the code_pr step `ready` (materializing it if the
  rec had none — Task 7 instrumentation recs start step-less). Merge sync on the
  webhook (`markGeneratedPrMerged`, repo-scoped) marks the step `done`
  (completion_source 'generated_pr_merged') and the rec `accepted` only from
  `active` once all required steps are done. github_pull_requests is upserted by the
  Task 6 webhook on `opened`.
- Schema versions: `pr_gen_patch.v1`. external write kinds: github_create_branch,
  github_update_file, github_create_pr.
- Known (lower-tier) limitations: base-branch drift between plan and handoff isn't
  detected; the steps read-modify-write isn't version-guarded; PrGenMcp resolves the
  single github integration (single-workspace demo); full file/patch content is kept
  in server-side (RLS-protected) evidence for resume.

## Context

Generated recommendation PRs are in first-slice scope, but only after explicit
human approval. Incident fix PR generation is future scope and should not be
implemented here.

Depends on Tasks 3, 4, 5A, 5C, 5D, 6, and 7. Task 6 provides the GitHub webhook
sync path used to update generated PR opened, merged, closed, and stale state.

## Requirements

- Add a confirmation flow for code-based recommendation steps of kind `code_pr`.
- Create an `approvals` row before starting any external write.
- Use an approval idempotency key so duplicate clicks or retried requests do not
  create multiple active approvals for the same recommendation step.
- Hash the approved redacted payload and require `external_write_actions.request_hash` to match it during execution.
- Treat one approval as authorizing the full approved PR-generation operation,
  while recording each provider write as a separate `external_write_actions` row.
- Enqueue a `recommendation_pr_generation` job for the approved step.
- Generate a clear branch name, PR title, summary, changed files, and evidence-linked PR body.
- Store planned/generated PR state in the relevant `recommendations.steps`
  object. After GitHub creates or syncs the PR, upsert `github_pull_requests`.
- Execute provider writes idempotently:
  - create branch
  - create/update file(s)
  - create pull request
- Record each external write in `external_write_actions`.
- Persist patch hashes/excerpts and file change summaries in
  `recommendations.steps`, but leave GitHub as the source of truth for full
  diffs.
- Update recommendation step state from available/generating/ready/done/failed.
- Keep a generated PR step incomplete until the PR is actually merged or the user marks an allowed non-mutating step complete.
- Sync generated PR state when GitHub reports opened, merged, closed, or stale.
- Preserve progress and avoid duplicate branches, commits, or PRs when retrying after a GitHub/TrueFoundry failure.

## Acceptance Criteria

- The UI asks for explicit approval before PR generation.
- Rejecting approval leaves the recommendation unchanged.
- Approved PR generation shows named job phases and survives refresh.
- A retryable provider failure does not duplicate branch/file/PR writes.
- The generated PR step includes branch name, PR title, summary, changed files,
  GitHub PR link/number when available, and evidence linking back to the
  recommendation.
- Opening a PR does not by itself mark the recommendation accepted.
- Merging the generated PR marks the step done, and marks the recommendation accepted only if all required steps are done.

## Automated Tests

- Add approval-gate tests that reject unapproved external writes.
- Add approval idempotency tests for duplicate approve/request attempts.
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
