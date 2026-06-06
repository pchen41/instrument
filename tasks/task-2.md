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
- If `workspaces.primary_repository_id` is included in the first migration, add it as a nullable column now but defer the foreign key to `repositories` until Task 3, after `repositories` exists.
- Create integration and gateway tables:
  - `integrations`
  - `mcp_servers`
- Create core workflow/audit tables:
  - `jobs`
  - `job_audit_events`
  - `ai_model_calls`
  - `mcp_tool_invocations`
  - `evidence_items`
  - `approvals`
  - `external_write_actions`
  - `app_events`
  - `telemetry_emissions`
- Create `telemetry_emissions` with foreign keys to Task 2 tables only (`workspaces`, `jobs`, and `integrations`). Defer the nullable `datadog_monitor_id` and `incident_id` foreign keys until Task 3, after `datadog_monitors` and `incidents` exist.
- Enable RLS on all workspace-owned tables.
- Add simple demo-safe RLS policies using the ERD membership pattern without introducing recursive policies:
  - Create one small helper such as `private.is_workspace_member(target_workspace_id uuid)` with `security definer`, or use equivalent simple special-case policies.
  - For most workspace-owned tables, allow access when the helper or membership lookup confirms `auth.uid()` belongs to the row's `workspace_id`.
  - For `workspaces`, check membership against `workspaces.id`.
  - For `workspace_members`, allow a signed-in user to read their own membership rows, and let service-role code handle seed/admin writes.
  - This is demo authorization, not a full RBAC system.
- Seed one demo workspace, one owner membership for the configured demo user, workspace settings, and GitHub/Datadog/TrueFoundry integration rows with non-secret config only.
- Seed MCP server rows only when the relevant TrueFoundry MCP Gateway FQNs/URLs are already provisioned. If they are not available yet, seed the provider integrations as `missing_credentials` or `degraded` with redacted diagnostics rather than inventing callable MCP configuration.
- Store only `secret_ref` names or redacted status diagnostics, never provider keys.

## Acceptance Criteria

- Migrations apply cleanly to the linked InsForge project or a branch project.
- The demo user can read rows for their workspace through RLS.
- A non-member user cannot read workspace-owned data.
- Required unique indexes from the ERD exist for core tables, including job idempotency and external write idempotency.
- `mcp_tool_invocations` exists before `evidence_items` and `external_write_actions` add foreign keys to it.
- Task 2 migrations do not fail on foreign keys to Task 3 tables; those constraints are either deferred to Task 3 or added by later `ALTER TABLE` migrations.
- Seeded integrations can represent `connected`, `degraded`, `rate_limited`, and `missing_credentials` states.

## Automated Tests

- Add migration verification SQL or integration tests that assert required tables, enums, indexes, and RLS policies exist.
- Add RLS tests for member and non-member access.
- Add a focused RLS test for `workspaces` and `workspace_members` so the simple demo policies do not recurse or expose another user's membership.
- Add tests that inserting duplicate `jobs(workspace_id, job_type, idempotency_key)` and duplicate `external_write_actions(workspace_id, provider, action_kind, idempotency_key)` fails.

## Manual Verification

- Run `npx @insforge/cli current`.
- Apply migrations.
- Query seeded workspace, settings, and integrations as the service role and as the demo user.
- Query the demo user's `workspace_members` row through RLS and confirm a non-member cannot read it.
- Confirm no secret values appear in table rows.

## Progress Notes

- Update this section with migration names, CLI output summaries, and any RLS exceptions.
