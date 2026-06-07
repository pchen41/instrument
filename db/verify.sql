-- Task 2 schema/constraint verification. Runs as project_admin via
--   npm run verify:db   (scripts/verify-db.mjs)
-- The whole check is one DO block. Every insert is undone because the block ends
-- by raising the sentinel 'INSTRUMENT_DB_VERIFY_OK', which rolls the transaction
-- back -- so nothing persists whether the run passes or fails. A failed
-- assertion raises a 'FAIL: ...' message instead. Row-level RLS visibility
-- (member vs non-member, write denial) is covered separately by the real-JWT SDK
-- test in scripts/verify-rls.mjs, because db query cannot switch roles.
do $$
declare
  v_ws uuid;
  v_user uuid;
  v_repo uuid;
  v_pr uuid;
  v_target uuid := gen_random_uuid();
  t text;
  expected_enums text[] := array[
    'integration_provider','integration_status','investigation_start_mode',
    'job_type','job_state','webhook_auth_method','recommendation_category',
    'recommendation_state','alert_state','incident_state','confidence_level',
    'evidence_source_type','evidence_verification_state','approval_state',
    'external_action_state'];
  expected_tables text[] := array[
    'workspaces','workspace_members','integrations','repositories','jobs',
    'inbound_webhooks','github_pull_requests','pr_review_comments',
    'recommendations','incidents','evidence_items','ai_model_calls',
    'approvals','external_write_actions','telemetry_emissions'];
  folded_tables text[] := array[
    'mcp_servers','mcp_tool_invocations','workspace_settings','app_events',
    'scans','datadog_monitors','generated_pull_requests','services',
    'repository_service_paths','github_push_events','pr_review_runs',
    'pr_review_findings','job_audit_events','recommendation_events',
    'generated_datadog_monitors','datadog_alert_events'];
  -- Workspace-owned tables that browser sessions must NOT write directly.
  write_protected text[] := array[
    'workspace_members','integrations','repositories','jobs','inbound_webhooks',
    'github_pull_requests','pr_review_comments','recommendations','incidents',
    'evidence_items','ai_model_calls','approvals','external_write_actions',
    'telemetry_emissions'];
  required_indexes text[] := array[
    'jobs_workspace_type_idempotency_key','inbound_webhooks_provider_delivery_key',
    'pr_review_comments_revision_unique','pr_review_comments_posted_semantic_unique',
    'incidents_active_correlation_unique','external_write_actions_idempotency_key',
    'telemetry_emissions_idempotency_key','approvals_active_unique'];
begin
  -- ---- A. object existence ----------------------------------------------
  foreach t in array expected_enums loop
    if to_regtype(t) is null then raise exception 'FAIL: missing enum %', t; end if;
  end loop;

  foreach t in array expected_tables loop
    if to_regclass('public.'||t) is null then
      raise exception 'FAIL: missing table %', t; end if;
    if not (select relrowsecurity from pg_class where oid = ('public.'||t)::regclass) then
      raise exception 'FAIL: RLS not enabled on %', t; end if;
  end loop;

  foreach t in array folded_tables loop
    if to_regclass('public.'||t) is not null then
      raise exception 'FAIL: folded/retired table % must not exist', t; end if;
  end loop;

  foreach t in array required_indexes loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname='public' and c.relkind='i' and c.relname = t
    ) then raise exception 'FAIL: missing required index %', t; end if;
  end loop;

  -- ---- B. policy + grant model ------------------------------------------
  -- Write-protected tables: a member SELECT policy, and NO write policy at all.
  foreach t in array write_protected loop
    if exists (select 1 from pg_policies where schemaname='public' and tablename=t
               and cmd in ('INSERT','UPDATE','DELETE','ALL')) then
      raise exception 'FAIL: unexpected write policy on %', t; end if;
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t
                   and cmd='SELECT') then
      raise exception 'FAIL: missing member select policy on %', t; end if;
  end loop;

  if not exists (select 1 from pg_policies
                 where tablename='workspaces' and policyname='workspaces_member_update_settings') then
    raise exception 'FAIL: workspaces settings-update policy missing'; end if;
  if not exists (select 1 from pg_policies
                 where tablename='workspace_members' and policyname='workspace_members_self_select') then
    raise exception 'FAIL: workspace_members self-select policy missing'; end if;

  -- No direct writes to service-only tables for authenticated.
  if has_table_privilege('authenticated','public.jobs','INSERT')
     or has_table_privilege('authenticated','public.approvals','INSERT')
     or has_table_privilege('authenticated','public.external_write_actions','INSERT')
     or has_table_privilege('authenticated','public.incidents','INSERT')
     or has_table_privilege('authenticated','public.recommendations','INSERT')
     or has_table_privilege('authenticated','public.jobs','DELETE') then
    raise exception 'FAIL: authenticated retains write privilege on a service-only table'; end if;
  if not has_table_privilege('authenticated','public.jobs','SELECT') then
    raise exception 'FAIL: authenticated cannot SELECT jobs'; end if;

  -- Narrow workspaces update: settings columns only, never slug/name, never table-wide.
  if has_table_privilege('authenticated','public.workspaces','UPDATE') then
    raise exception 'FAIL: authenticated has table-wide UPDATE on workspaces'; end if;
  if not has_column_privilege('authenticated','public.workspaces','investigation_start_mode','UPDATE') then
    raise exception 'FAIL: authenticated cannot update workspaces.investigation_start_mode'; end if;
  if has_column_privilege('authenticated','public.workspaces','slug','UPDATE')
     or has_column_privilege('authenticated','public.workspaces','name','UPDATE') then
    raise exception 'FAIL: authenticated can update a non-settings workspaces column'; end if;

  -- ---- C. seed present ---------------------------------------------------
  select id into v_user from auth.users where email='test@test.com';
  select id into v_ws   from public.workspaces where slug='instrument';
  select id into v_repo from public.repositories where workspace_id = v_ws limit 1;
  if v_user is null or v_ws is null or v_repo is null then
    raise exception 'FAIL: seed missing (user/workspace/repository)'; end if;
  if not exists (select 1 from public.integrations where workspace_id=v_ws
                 and provider in ('github','datadog','truefoundry')
                 group by workspace_id having count(distinct provider)=3) then
    raise exception 'FAIL: expected 3 seeded integrations'; end if;
  -- No raw secrets in integration rows: secret_ref must be a NAME, not a token.
  if exists (select 1 from public.integrations
             where secret_ref ~ '^(ik_|eyJ|github_pat_|ghp_)' or length(secret_ref) > 64) then
    raise exception 'FAIL: integrations.secret_ref looks like a raw secret'; end if;

  -- ---- D. uniqueness / partial-uniqueness constraints -------------------
  -- jobs(workspace_id, job_type, idempotency_key)
  insert into public.jobs(workspace_id,job_type,target_type,target_id,idempotency_key)
    values (v_ws,'proactive_scan','repository',v_target,'verify-job');
  begin
    insert into public.jobs(workspace_id,job_type,target_type,target_id,idempotency_key)
      values (v_ws,'proactive_scan','repository',v_target,'verify-job');
    raise exception 'FAIL: jobs allowed duplicate (workspace_id, job_type, idempotency_key)';
  exception when unique_violation then null; end;

  -- external_write_actions(workspace_id, provider, action_kind, idempotency_key)
  insert into public.external_write_actions
    (workspace_id,provider,action_kind,idempotency_key,target_summary,request_hash)
    values (v_ws,'github','github_create_pr','verify-ewa','t','h');
  begin
    insert into public.external_write_actions
      (workspace_id,provider,action_kind,idempotency_key,target_summary,request_hash)
      values (v_ws,'github','github_create_pr','verify-ewa','t','h');
    raise exception 'FAIL: external_write_actions allowed duplicate idempotency key';
  exception when unique_violation then null; end;

  -- telemetry_emissions(workspace_id, metric_name, idempotency_key)
  insert into public.telemetry_emissions(workspace_id,metric_name,idempotency_key)
    values (v_ws,'instrument.job.retry','verify-tel');
  begin
    insert into public.telemetry_emissions(workspace_id,metric_name,idempotency_key)
      values (v_ws,'instrument.job.retry','verify-tel');
    raise exception 'FAIL: telemetry_emissions allowed duplicate idempotency key';
  exception when unique_violation then null; end;

  -- inbound_webhooks(provider, external_delivery_id) -- delivery idempotency.
  insert into public.inbound_webhooks
    (workspace_id,provider,event_type,external_delivery_id,auth_method,payload_redacted)
    values (v_ws,'github','pull_request','verify-delivery','github_signature','{}');
  begin
    insert into public.inbound_webhooks
      (workspace_id,provider,event_type,external_delivery_id,auth_method,payload_redacted)
      values (v_ws,'github','push','verify-delivery','github_signature','{}');
    raise exception 'FAIL: inbound_webhooks allowed duplicate (provider, external_delivery_id)';
  exception when unique_violation then null; end;

  -- A PR to hang pr_review_comments tests on.
  insert into public.github_pull_requests
    (workspace_id,repository_id,external_pr_number,title,state,base_branch,head_branch,head_sha)
    values (v_ws,v_repo,99991,'verify pr','open','main','feature','shaA')
  returning id into v_pr;

  -- pr_review_comments per-revision placement: (pull_request_id, revision_fingerprint)
  insert into public.pr_review_comments
    (workspace_id,pull_request_id,head_sha,semantic_fingerprint,revision_fingerprint,
     issue_type,file_path,line_number,body,validated_schema_version,status)
    values (v_ws,v_pr,'shaA','sem-1','rev-1','missing_metric','a.ts',10,'b','v1','planned');
  begin
    insert into public.pr_review_comments
      (workspace_id,pull_request_id,head_sha,semantic_fingerprint,revision_fingerprint,
       issue_type,file_path,line_number,body,validated_schema_version,status)
      values (v_ws,v_pr,'shaA','sem-2','rev-1','missing_metric','a.ts',11,'b','v1','planned');
    raise exception 'FAIL: pr_review_comments allowed duplicate revision_fingerprint';
  exception when unique_violation then null; end;

  -- pr_review_comments cross-revision posted semantic: two posted, same semantic,
  -- different revision -> must violate.
  insert into public.pr_review_comments
    (workspace_id,pull_request_id,head_sha,semantic_fingerprint,revision_fingerprint,
     issue_type,file_path,line_number,body,validated_schema_version,status)
    values (v_ws,v_pr,'shaA','sem-posted','rev-A','missing_metric','a.ts',10,'b','v1','posted');
  begin
    insert into public.pr_review_comments
      (workspace_id,pull_request_id,head_sha,semantic_fingerprint,revision_fingerprint,
       issue_type,file_path,line_number,body,validated_schema_version,status)
      values (v_ws,v_pr,'shaB','sem-posted','rev-B','missing_metric','a.ts',12,'b','v1','posted');
    raise exception 'FAIL: pr_review_comments allowed duplicate posted semantic_fingerprint';
  exception when unique_violation then null; end;

  -- ...but a non-posted (planned) pair sharing a semantic gap is allowed, so a
  -- resolved gap can be re-posted on a later revision.
  begin
    insert into public.pr_review_comments
      (workspace_id,pull_request_id,head_sha,semantic_fingerprint,revision_fingerprint,
       issue_type,file_path,line_number,body,validated_schema_version,status)
      values (v_ws,v_pr,'shaA','sem-planned','rev-P1','missing_metric','a.ts',10,'b','v1','planned');
    insert into public.pr_review_comments
      (workspace_id,pull_request_id,head_sha,semantic_fingerprint,revision_fingerprint,
       issue_type,file_path,line_number,body,validated_schema_version,status)
      values (v_ws,v_pr,'shaB','sem-planned','rev-P2','missing_metric','a.ts',12,'b','v1','planned');
  exception when unique_violation then
    raise exception 'FAIL: pr_review_comments wrongly rejected a non-posted duplicate semantic';
  end;

  -- incidents active correlation: (workspace_id, incident_correlation_key) where active.
  insert into public.incidents
    (workspace_id,external_alert_key,incident_correlation_key,title,alert_state,
     investigation_start_mode_snapshot,started_at)
    values (v_ws,'ak','corr-active','t','firing','manual',now());
  begin
    insert into public.incidents
      (workspace_id,external_alert_key,incident_correlation_key,title,alert_state,
       investigation_start_mode_snapshot,started_at)
      values (v_ws,'ak','corr-active','t','firing','manual',now());
    raise exception 'FAIL: incidents allowed two active rows with same correlation key';
  exception when unique_violation then null; end;
  -- a resolved incident may share the correlation key.
  begin
    insert into public.incidents
      (workspace_id,external_alert_key,incident_correlation_key,title,alert_state,
       incident_state,investigation_start_mode_snapshot,started_at)
      values (v_ws,'ak','corr-active','t','resolved','resolved','manual',now());
  exception when unique_violation then
    raise exception 'FAIL: incidents wrongly rejected a resolved row sharing the correlation key';
  end;

  -- approvals active uniqueness EXCLUDES idempotency_key: a second active approval
  -- for the same target/action with a DIFFERENT idempotency key must still fail.
  insert into public.approvals
    (workspace_id,action_type,target_type,target_id,approval_summary,idempotency_key)
    values (v_ws,'create_datadog_monitor','recommendation',v_target,'s','idem-1');
  begin
    insert into public.approvals
      (workspace_id,action_type,target_type,target_id,approval_summary,idempotency_key)
      values (v_ws,'create_datadog_monitor','recommendation',v_target,'s','idem-2');
    raise exception 'FAIL: approvals allowed a second active approval via a new idempotency key';
  exception when unique_violation then null; end;
  -- a rejected approval for the same target/action is allowed (outside the active set).
  begin
    insert into public.approvals
      (workspace_id,action_type,target_type,target_id,approval_summary,idempotency_key,state)
      values (v_ws,'create_datadog_monitor','recommendation',v_target,'s','idem-3','rejected');
  exception when unique_violation then
    raise exception 'FAIL: approvals wrongly rejected a non-active (rejected) duplicate';
  end;

  -- All checks passed. Raise the sentinel to roll back every test insert above.
  raise exception 'INSTRUMENT_DB_VERIFY_OK';
end $$;
