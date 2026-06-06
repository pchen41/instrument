# Task 2: Add simplified InsForge schema, RLS, and seed data

## Status

Not started.

## Context

Use the `insforge-cli` skill and run InsForge CLI commands through
`npx @insforge/cli`. The ERD in `docs/ERD.md` intentionally uses a simplified
15-table first-slice schema. Do not recreate the older expanded schema tables
that are now listed as folded in the ERD.

This task establishes the database foundation used by every later task.

## Requirements

- Create InsForge/Postgres migrations for the first-slice enums:
  - `integration_provider`
  - `integration_status`
  - `investigation_start_mode`
  - `job_type`
  - `job_state`
  - `webhook_auth_method`
  - `recommendation_category`
  - `recommendation_state`
  - `alert_state`
  - `incident_state`
  - `confidence_level`
  - `evidence_source_type`
  - `evidence_verification_state`
  - `approval_state`
  - `external_action_state`
- Create the 15 core tables from `docs/ERD.md`:
  - `workspaces`
  - `workspace_members`
  - `integrations`
  - `repositories`
  - `jobs`
  - `inbound_webhooks`
  - `github_pull_requests`
  - `pr_review_comments`
  - `recommendations`
  - `incidents`
  - `evidence_items`
  - `ai_model_calls`
  - `approvals`
  - `external_write_actions`
  - `telemetry_emissions`
- If `workspaces.primary_repository_id` is included before `repositories`
  exists, add it as nullable and add the foreign key later in the same migration
  file or a follow-up migration after `repositories` exists.
- Add the unique indexes and partial unique indexes called out in the ERD,
  especially:
  - `jobs(workspace_id, job_type, idempotency_key)`
  - `inbound_webhooks(provider, external_delivery_id)`
  - `pr_review_comments(pull_request_id, revision_fingerprint)`
  - partial unique
    `pr_review_comments(pull_request_id, semantic_fingerprint)` where
    `status in ('posted', 'resolved')`
  - partial unique
    `incidents(workspace_id, incident_correlation_key)` where
    `incident_state = 'active'`
  - `external_write_actions(workspace_id, provider, action_kind, idempotency_key)`
  - `telemetry_emissions(workspace_id, metric_name, idempotency_key)`
- Enable RLS on all workspace-owned tables.
- Add simple first-slice demo RLS policies using the ERD membership pattern
  without introducing recursive policies:
  - Create one small helper such as
    `private.is_workspace_member(target_workspace_id uuid)` with
    `security definer`, or use equivalent simple special-case policies.
  - For most workspace-owned tables, allow signed-in workspace members to
    `select` rows in their workspace.
  - Do not grant normal browser sessions direct insert/update/delete access to
    jobs, inbound webhooks, PR review comments, recommendations, incidents,
    evidence, model calls, approvals, external write actions, or telemetry.
    These writes are performed by Edge Functions, webhook handlers, scheduled
    workers, and external action executors using server-only credentials.
  - User-triggered writes such as changing investigation-start mode, requesting
    or rejecting approval, dismissing/restoring a recommendation, starting an
    investigation, and retrying a job should go through server endpoints that
    validate workspace membership and allowed state transitions.
  - For the demo, a narrow direct update policy on `workspaces` is acceptable
    only for `investigation_start_mode`, `smart_start_rules`,
    `settings_updated_by`, `settings_updated_at`, and `updated_at`.
  - For `workspaces`, check membership against `workspaces.id`.
  - For `workspace_members`, allow a signed-in user to read their own membership
    rows with a direct `user_id = auth.uid()` policy. Do not call
    `private.is_workspace_member` from the `workspace_members` policy, because
    that can recurse. Let service-role code handle seed/admin writes.
- Seed one configured workspace, one owner membership for the configured user,
  workspace settings columns, one primary repository, and GitHub/Datadog/
  TrueFoundry integration rows with non-secret config only.
- If the configured demo auth user does not already exist, create or document
  its creation before seeding `workspace_members`; the membership row must
  reference an existing `auth.users(id)`.
- Store TrueFoundry MCP Gateway FQNs/URLs/tool allowlists in
  `integrations.config` only when already provisioned. If not available, seed
  the TrueFoundry integration as `missing_credentials` or `degraded` with
  redacted diagnostics.
- Store only `secret_ref` names or redacted status diagnostics, never provider
  keys.

## Acceptance Criteria

- Migrations apply cleanly to the linked InsForge project or a branch project.
- The configured user can read rows for their workspace through RLS.
- A non-member user cannot read workspace-owned data.
- Required unique indexes and partial unique indexes from the simplified ERD
  exist.
- The schema does not create folded/retired tables such as `mcp_servers`,
  `mcp_tool_invocations`, `workspace_settings`, `app_events`, `scans`,
  `datadog_monitors`, or `generated_pull_requests`.
- Seeded integrations can represent `connected`, `degraded`, `rate_limited`,
  and `missing_credentials` states.
- Seed data does not include raw secrets.

## Automated Tests

- Add migration verification SQL or integration tests that assert required
  tables, enums, indexes, partial indexes, and RLS policies exist.
- Add RLS tests for member and non-member access.
- Add tests proving normal member sessions can read workspace rows but cannot
  directly create jobs, approvals, external write actions, incidents, or
  recommendations.
- Add focused RLS tests for `workspaces` and `workspace_members` so the simple
  policies do not recurse or expose another user's membership.
- Add duplicate-insert tests for:
  - `jobs(workspace_id, job_type, idempotency_key)`
  - `external_write_actions(workspace_id, provider, action_kind, idempotency_key)`
  - `pr_review_comments` semantic and revision dedupe constraints
  - active incident correlation partial uniqueness

## Manual Verification

- Run `npx @insforge/cli current`.
- Apply migrations.
- Query seeded workspace, repository, settings columns, and integrations as the
  service role and as the configured user.
- Query the configured user's `workspace_members` row through RLS and confirm a
  non-member cannot read it.
- Confirm a normal member cannot directly insert a job or external write action
  through the browser/client role.
- Confirm no secret values appear in table rows.

## Progress Notes

- Update this section with migration names, CLI output summaries, seed data
  notes, and any RLS exceptions.
