-- Task 2: first-slice RLS. Signed-in workspace members may SELECT rows in their
-- workspace. All provider/job/approval/audit/telemetry WRITES stay service-only:
-- those roles simply receive no INSERT/UPDATE/DELETE grants, so webhook handlers,
-- workers, and external-action executors (running with server-only credentials
-- that bypass RLS) perform every write. project_admin (CLI/migrations/admin key)
-- owns these tables and bypasses RLS for seeding and server writes.

-- Membership helper. SECURITY DEFINER so it bypasses RLS on workspace_members and
-- cannot recurse; empty search_path with fully-qualified names for safety.
create schema if not exists private;

create or replace function private.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = auth.uid()
  );
$$;

grant usage on schema private to authenticated;
grant execute on function private.is_workspace_member(uuid) to authenticated;
grant usage on schema public to anon, authenticated;

-- workspaces: members may read their workspace; a NARROW update is allowed only
-- for the settings columns (enforced by column-level UPDATE grant, not just RLS).
alter table workspaces enable row level security;
create policy workspaces_member_select on workspaces
  for select to authenticated
  using (private.is_workspace_member(id));
create policy workspaces_member_update_settings on workspaces
  for update to authenticated
  using (private.is_workspace_member(id))
  with check (private.is_workspace_member(id));
grant select on workspaces to authenticated;
grant update (
  investigation_start_mode, smart_start_rules,
  settings_updated_by, settings_updated_at, updated_at
) on workspaces to authenticated;

-- workspace_members: a user may read ONLY their own membership rows. Direct
-- user_id check (no helper) so this policy cannot recurse. Seed/admin writes are
-- service-role only.
alter table workspace_members enable row level security;
create policy workspace_members_self_select on workspace_members
  for select to authenticated
  using (user_id = (select auth.uid()));
grant select on workspace_members to authenticated;

-- Remaining workspace-owned tables: members may SELECT rows in their workspace.
-- No write grants -> normal browser sessions cannot insert/update/delete.
alter table integrations enable row level security;
create policy integrations_member_select on integrations
  for select to authenticated using (private.is_workspace_member(workspace_id));
grant select on integrations to authenticated;

alter table repositories enable row level security;
create policy repositories_member_select on repositories
  for select to authenticated using (private.is_workspace_member(workspace_id));
grant select on repositories to authenticated;

alter table jobs enable row level security;
create policy jobs_member_select on jobs
  for select to authenticated using (private.is_workspace_member(workspace_id));
grant select on jobs to authenticated;

alter table ai_model_calls enable row level security;
create policy ai_model_calls_member_select on ai_model_calls
  for select to authenticated using (private.is_workspace_member(workspace_id));
grant select on ai_model_calls to authenticated;

alter table inbound_webhooks enable row level security;
create policy inbound_webhooks_member_select on inbound_webhooks
  for select to authenticated using (private.is_workspace_member(workspace_id));
grant select on inbound_webhooks to authenticated;

alter table github_pull_requests enable row level security;
create policy github_pull_requests_member_select on github_pull_requests
  for select to authenticated using (private.is_workspace_member(workspace_id));
grant select on github_pull_requests to authenticated;

alter table approvals enable row level security;
create policy approvals_member_select on approvals
  for select to authenticated using (private.is_workspace_member(workspace_id));
grant select on approvals to authenticated;

alter table recommendations enable row level security;
create policy recommendations_member_select on recommendations
  for select to authenticated using (private.is_workspace_member(workspace_id));
grant select on recommendations to authenticated;

alter table evidence_items enable row level security;
create policy evidence_items_member_select on evidence_items
  for select to authenticated using (private.is_workspace_member(workspace_id));
grant select on evidence_items to authenticated;

alter table external_write_actions enable row level security;
create policy external_write_actions_member_select on external_write_actions
  for select to authenticated using (private.is_workspace_member(workspace_id));
grant select on external_write_actions to authenticated;

alter table pr_review_comments enable row level security;
create policy pr_review_comments_member_select on pr_review_comments
  for select to authenticated using (private.is_workspace_member(workspace_id));
grant select on pr_review_comments to authenticated;

alter table incidents enable row level security;
create policy incidents_member_select on incidents
  for select to authenticated using (private.is_workspace_member(workspace_id));
grant select on incidents to authenticated;

alter table telemetry_emissions enable row level security;
create policy telemetry_emissions_member_select on telemetry_emissions
  for select to authenticated using (private.is_workspace_member(workspace_id));
grant select on telemetry_emissions to authenticated;
