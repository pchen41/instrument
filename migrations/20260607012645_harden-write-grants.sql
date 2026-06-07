-- Task 2: harden the write surface. InsForge auto-grants table privileges to
-- anon/authenticated on every public table, so RLS alone gated writes. The ERD
-- requires that normal browser sessions cannot directly insert/update/delete
-- jobs, webhooks, PR comments, recommendations, incidents, evidence, model calls,
-- approvals, external write actions, or telemetry -- those are service-only. It
-- also requires the only direct member write on workspaces to be the settings
-- columns. We make that literally true (defense-in-depth, not RLS-policy-absence
-- alone) by revoking writes, then re-granting just the narrow workspaces update.
-- Server code (admin/service credentials) bypasses these grants.

revoke insert, update, delete on
  workspaces, workspace_members, integrations, repositories, jobs,
  ai_model_calls, inbound_webhooks, github_pull_requests, approvals,
  recommendations, evidence_items, external_write_actions,
  pr_review_comments, incidents, telemetry_emissions
from anon, authenticated;

-- The single allowed direct member write: workspace investigation-start settings.
-- Column-level grant means an UPDATE touching any other column (slug, name, ...)
-- is denied, while the workspaces_member_update_settings RLS policy still gates
-- the row. updated_at is included so the column is writable alongside the others.
grant update (
  investigation_start_mode, smart_start_rules,
  settings_updated_by, settings_updated_at, updated_at
) on workspaces to authenticated;
