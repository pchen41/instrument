-- Task 2: seed the single configured first-slice workspace. Runs as project_admin
-- (bypasses RLS). References the demo auth user by email so it self-heals to the
-- real auth.users(id). NON-SECRET config only -- secret_ref holds the *name* of a
-- server-side secret, never a provider key. Idempotent: re-running is a no-op once
-- the 'instrument' workspace exists.
do $$
declare
  v_user uuid;
  v_ws uuid;
  v_gh_integration uuid;
  v_repo uuid;
begin
  select id into v_user from auth.users where email = 'test@test.com';
  if v_user is null then
    raise exception
      'Demo auth user test@test.com not found; create it before seeding workspace_members.';
  end if;

  select id into v_ws from public.workspaces where slug = 'instrument';
  if v_ws is not null then
    raise notice 'Workspace already seeded (%); skipping.', v_ws;
    return;
  end if;

  -- Workspace + settings columns (former workspace_settings).
  insert into public.workspaces
    (slug, name, investigation_start_mode, pr_review_enabled,
     settings_updated_by, settings_updated_at)
  values
    ('instrument', 'Instrument', 'manual', true, v_user, now())
  returning id into v_ws;

  -- Owner membership for the configured user.
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_ws, v_user, 'owner');

  -- GitHub integration (source of truth for repos/PRs/reviews).
  insert into public.integrations
    (workspace_id, provider, status, display_name, external_account_id,
     config, secret_ref, last_checked_at)
  values
    (v_ws, 'github', 'connected', 'GitHub', 'pchen41',
     jsonb_build_object(
       'repo_allowlist', jsonb_build_array('pchen41/instrument'),
       'toolsets', jsonb_build_array('repos', 'pull_requests', 'issues', 'git'),
       'webhook_events', jsonb_build_array('pull_request', 'push')
     ),
     'GITHUB_TOKEN', now())
  returning id into v_gh_integration;

  -- Datadog integration (source of truth for monitors/alerts/logs/metrics).
  insert into public.integrations
    (workspace_id, provider, status, display_name, external_account_id,
     config, secret_ref, last_checked_at)
  values
    (v_ws, 'datadog', 'connected', 'Datadog', 'us5',
     jsonb_build_object(
       'site', 'us5.datadoghq.com',
       'webhook_auth_method', 'shared_secret_header',
       'mcp', jsonb_build_object('read_scope', 'mcp_read', 'write_scope', 'mcp_write')
     ),
     'DATADOG_API_KEY', now());

  -- TrueFoundry integration (AI Gateway + governed MCP layer). MCP FQNs/URLs/tool
  -- allowlists live in config; never the PAT/VAT.
  insert into public.integrations
    (workspace_id, provider, status, display_name, external_account_id,
     config, secret_ref, last_checked_at)
  values
    (v_ws, 'truefoundry', 'connected', 'TrueFoundry', 'peterc',
     jsonb_build_object(
       'control_plane_url', 'https://peterc.truefoundry.cloud',
       'gateway_base_url', 'https://gateway.truefoundry.ai',
       'model', 'peterc:virtual-model:instrument/instrument',
       'observability_mcp', jsonb_build_object(
         'base_url', 'https://instrument-9z6j.onrender.com',
         'mcp_url', 'https://instrument-9z6j.onrender.com/mcp',
         'health_url', 'https://instrument-9z6j.onrender.com/healthz'
       ),
       'mcp_servers', jsonb_build_array(
         jsonb_build_object(
           'name', 'github',
           'url', 'https://gateway.truefoundry.ai/peterc/mcp/github/server'),
         jsonb_build_object(
           'name', 'datadog',
           'url', 'https://gateway.truefoundry.ai/peterc/mcp/datadog/server'),
         jsonb_build_object(
           'name', 'instrument-investigation',
           'url', 'https://gateway.truefoundry.ai/peterc/mcp/instrument-investigation/server',
           'read_only', true)
       )
     ),
     'TRUEFOUNDRY_PAT', now());

  -- Primary repository (the watched repo).
  insert into public.repositories
    (workspace_id, integration_id, github_owner, github_name, default_branch,
     html_url, clone_url, is_primary, pr_review_enabled)
  values
    (v_ws, v_gh_integration, 'pchen41', 'instrument', 'main',
     'https://github.com/pchen41/instrument',
     'https://github.com/pchen41/instrument.git', true, true)
  returning id into v_repo;

  update public.workspaces set primary_repository_id = v_repo where id = v_ws;

  raise notice 'Seeded workspace % (repo %, owner %, 3 integrations).',
    v_ws, v_repo, v_user;
end $$;
