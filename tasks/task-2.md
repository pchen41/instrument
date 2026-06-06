# Task 2: Add core InsForge schema, RLS, and seed data

## Status

Not started.

## Context

Use the `insforge-cli` skill and run InsForge CLI commands through `npx @insforge/cli`. The ERD says to start with migrations for enums, workspace/auth/integration tables, jobs, and evidence before workflows.

This task establishes the database foundation used by every later task.

## Requirements

- Create InsForge/Postgres migrations for core enums:
  - `integration_provider`
  - `integration_status`
  - `mcp_server_role`
  - `investigation_start_mode`
  - `job_type`
  - `job_state`
  - `webhook_auth_method`
  - `confidence_level`
  - `evidence_source_type`
  - `evidence_verification_state`
  - `approval_state`
  - `external_action_state`
- Create workspace and auth-adjacent tables:
  - `workspaces`
  - `workspace_members`
  - `workspace_settings`
- Create integration and gateway tables:
  - `integrations`
  - `mcp_servers`
- Create core workflow/audit tables:
  - `jobs`
  - `job_audit_events`
  - `evidence_items`
  - `ai_model_calls`
  - `approvals`
  - `external_write_actions`
  - `app_events`
  - `telemetry_emissions`
- Enable RLS on all workspace-owned tables.
- Add RLS policies using the ERD pattern:
  `exists (select 1 from workspace_members wm where wm.workspace_id = <table>.workspace_id and wm.user_id = auth.uid())`.
- Seed one demo workspace, one owner membership for the configured demo user, workspace settings, and GitHub/Datadog/TrueFoundry integration rows with non-secret config only.
- Store only `secret_ref` names or redacted status diagnostics, never provider keys.

## Acceptance Criteria

- Migrations apply cleanly to the linked InsForge project or a branch project.
- The demo user can read rows for their workspace through RLS.
- A non-member user cannot read workspace-owned data.
- Required unique indexes from the ERD exist for core tables, including job idempotency and external write idempotency.
- Seeded integrations can represent `connected`, `degraded`, `rate_limited`, and `missing_credentials` states.

## Automated Tests

- Add migration verification SQL or integration tests that assert required tables, enums, indexes, and RLS policies exist.
- Add RLS tests for member and non-member access.
- Add tests that inserting duplicate `jobs(workspace_id, job_type, idempotency_key)` and duplicate `external_write_actions(workspace_id, provider, action_kind, idempotency_key)` fails.

## Manual Verification

- Run `npx @insforge/cli current`.
- Apply migrations.
- Query seeded workspace, settings, and integrations as the service role and as the demo user.
- Confirm no secret values appear in table rows.

## Progress Notes

- Update this section with migration names, CLI output summaries, and any RLS exceptions.
