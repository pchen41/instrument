-- Task 2: the 15 first-slice core tables (docs/ERD.md "Core Tables").
-- Tables are created in FK-dependency order. workspaces.primary_repository_id is
-- created nullable and its FK is added after repositories exists. Folded/retired
-- tables (mcp_servers, workspace_settings, scans, app_events, ...) are not created.

-- 1. workspaces (single row in the first slice; also holds former workspace_settings).
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  primary_repository_id uuid,
  investigation_start_mode investigation_start_mode not null default 'manual',
  smart_start_rules jsonb not null default '{}',
  primary_branch_scan_cooldown_seconds integer not null default 30,
  pr_review_enabled boolean not null default true,
  settings_updated_by uuid references auth.users(id),
  settings_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. workspace_members (membership to InsForge auth users).
create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on workspace_members(user_id);

-- 3. integrations (GitHub / Datadog / TrueFoundry config + health).
create table integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider integration_provider not null,
  status integration_status not null,
  display_name text not null,
  external_account_id text,
  config jsonb not null default '{}',
  secret_ref text,
  last_checked_at timestamptz,
  last_error_code text,
  last_error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider)
);

-- 4. repositories (primary GitHub repo + first-slice service/path metadata).
create table repositories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  integration_id uuid not null references integrations(id),
  github_owner text not null,
  github_name text not null,
  external_repo_id text,
  default_branch text not null default 'main',
  clone_url text,
  html_url text,
  is_primary boolean not null default false,
  pr_review_enabled boolean not null default true,
  service_map jsonb not null default '[]',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, github_owner, github_name)
);

-- Deferred FK now that repositories exists.
alter table workspaces
  add constraint workspaces_primary_repository_id_fkey
  foreign key (primary_repository_id) references repositories(id);

-- 5. jobs (durable state for all long-running workflows).
create table jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  job_type job_type not null,
  state job_state not null default 'queued',
  target_type text not null,
  target_id uuid not null,
  target_step_key text,
  idempotency_key text not null,
  created_by uuid references auth.users(id),
  safe_to_retry boolean not null default true,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  retry_policy jsonb not null default '{}',
  phases jsonb not null default '[]',
  attempts jsonb not null default '[]',
  audit_events jsonb not null default '[]',
  trigger_summary jsonb not null default '{}',
  next_run_at timestamptz,
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  failure_integration_id uuid references integrations(id),
  failure_source text,
  error_code text,
  error_summary text,
  progress_version integer not null default 1,
  queued_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_workspace_type_idempotency_key unique (workspace_id, job_type, idempotency_key)
);
create index jobs_due_idx on jobs(workspace_id, state, next_run_at, lease_expires_at);
create index jobs_target_idx on jobs(workspace_id, target_type, target_id, job_type);
create index jobs_target_step_idx on jobs(workspace_id, target_type, target_id, target_step_key, job_type)
  where target_step_key is not null;

-- 6. ai_model_calls (LLM calls through TrueFoundry only).
create table ai_model_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  integration_id uuid not null references integrations(id),
  job_id uuid not null references jobs(id),
  purpose text not null,
  api_surface text not null,
  truefoundry_response_id text,
  truefoundry_trace_id text,
  truefoundry_span_id text,
  gateway_base_url_name text,
  provider_name text,
  model_name text not null,
  agent_iteration_limit integer,
  mcp_servers_requested jsonb,
  tool_calls_redacted jsonb not null default '[]',
  request_schema_version text not null,
  output_schema_version text not null,
  input_hash text not null,
  output_redacted jsonb,
  validation_status text not null,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  cost_usd numeric,
  latency_ms integer,
  status text not null,
  error_code text,
  error_summary text,
  started_at timestamptz,
  completed_at timestamptz
);
create index ai_model_calls_response_idx on ai_model_calls(workspace_id, truefoundry_response_id);
create index ai_model_calls_trace_idx on ai_model_calls(workspace_id, truefoundry_trace_id);

-- 7. inbound_webhooks (verified/rejected GitHub & Datadog deliveries + idempotency).
create table inbound_webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider integration_provider not null,
  integration_id uuid references integrations(id),
  event_type text not null,
  event_action text,
  external_delivery_id text not null,
  provider_correlation_key text,
  auth_method webhook_auth_method not null,
  signature_valid boolean not null default false,
  headers_redacted jsonb not null default '{}',
  payload_redacted jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received',
  error_summary text,
  constraint inbound_webhooks_provider_delivery_key unique (provider, external_delivery_id)
);

-- 8. github_pull_requests (cached PR metadata; updated_at mirrors GitHub, not row mgmt).
create table github_pull_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  repository_id uuid not null references repositories(id),
  external_pr_number integer not null,
  external_node_id text,
  title text not null,
  author_login text,
  state text not null,
  draft boolean not null default false,
  base_branch text not null,
  head_branch text not null,
  head_sha text not null,
  html_url text,
  opened_at timestamptz,
  updated_at timestamptz,
  closed_at timestamptz,
  merged_at timestamptz,
  last_synced_at timestamptz,
  constraint github_pull_requests_repo_number_key unique (repository_id, external_pr_number)
);

-- 9. approvals (human approval gate; kept separate from external_write_actions).
create table approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  action_type text not null,
  target_type text not null,
  target_id uuid not null,
  target_step_key text,
  requested_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  state approval_state not null default 'requested',
  approval_summary text not null,
  approved_payload_hash text,
  idempotency_key text not null,
  approval_version integer not null default 1,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  executed_at timestamptz
);
-- Active-approval uniqueness deliberately EXCLUDES idempotency_key, so a new
-- idempotency key cannot fork a second active approval for the same target/action.
create unique index approvals_active_unique
  on approvals(workspace_id, action_type, target_type, target_id, coalesce(target_step_key, ''))
  where state in ('requested', 'approved');

-- 10. recommendations (proactive / alert / pr_review).
create table recommendations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  repository_id uuid references repositories(id),
  created_by_job_id uuid references jobs(id),
  last_seen_job_id uuid references jobs(id),
  category recommendation_category not null,
  state recommendation_state not null default 'active',
  title text not null,
  rationale text not null,
  service_name text,
  environment text default 'production',
  affected_code_path text,
  affected_runtime_path text,
  proposed_next_step text not null,
  steps jsonb not null default '[]',
  steps_schema_version text not null default 'recommendation_steps.v1',
  lifecycle_events jsonb not null default '[]',
  confidence confidence_level,
  dedupe_fingerprint text not null,
  context_hash text,
  created_by_model_call_id uuid references ai_model_calls(id),
  validated_schema_version text not null,
  outdated_reason text,
  superseded_by_recommendation_id uuid references recommendations(id),
  accepted_at timestamptz,
  dismissed_at timestamptz,
  outdated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index recommendations_list_idx on recommendations(workspace_id, state, category, updated_at desc);
create index recommendations_dedupe_idx on recommendations(workspace_id, dedupe_fingerprint);

-- 11. evidence_items (all cited evidence).
create table evidence_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  source_type evidence_source_type not null,
  source_provider integration_provider,
  collected_by_job_id uuid references jobs(id),
  ai_model_call_id uuid references ai_model_calls(id),
  subject_type text not null,
  subject_id uuid not null,
  subject_key text,
  claim_type text not null default 'fact',
  external_id text,
  uri text,
  title text not null,
  summary text not null,
  payload jsonb not null default '{}',
  content_hash text not null,
  verification_state evidence_verification_state not null default 'verified',
  observed_at timestamptz,
  collected_at timestamptz not null default now()
);
create index evidence_items_source_idx on evidence_items(workspace_id, source_type, external_id);
create index evidence_items_subject_idx on evidence_items(workspace_id, subject_type, subject_id);

-- 12. external_write_actions (single idempotency anchor for provider writes).
create table external_write_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  approval_id uuid references approvals(id),
  job_id uuid references jobs(id),
  provider integration_provider not null,
  action_kind text not null,
  idempotency_key text not null,
  target_summary text not null,
  request_hash text not null,
  request_redacted jsonb not null default '{}',
  response_summary jsonb not null default '{}',
  external_id text,
  external_url text,
  state external_action_state not null default 'planned',
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_summary text,
  constraint external_write_actions_idempotency_key
    unique (workspace_id, provider, action_kind, idempotency_key)
);

-- 13. pr_review_comments (collapsed PR review run/finding/comment).
create table pr_review_comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  pull_request_id uuid not null references github_pull_requests(id),
  recommendation_id uuid references recommendations(id),
  job_id uuid references jobs(id),
  external_write_action_id uuid references external_write_actions(id),
  external_comment_id text,
  event_action text,
  head_sha text not null,
  semantic_fingerprint text not null,
  revision_fingerprint text not null,
  issue_type text not null,
  file_path text not null,
  line_number integer not null,
  side text not null default 'RIGHT',
  code_anchor text,
  body text not null,
  suggested_code text,
  created_by_model_call_id uuid references ai_model_calls(id),
  validated_schema_version text not null,
  status text not null,
  posted_at timestamptz,
  outdated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pr_review_comments_revision_unique unique (pull_request_id, revision_fingerprint)
);
-- A previously resolved semantic gap may be posted again on a later revision, so
-- the cross-revision dedupe only applies to currently-posted comments.
create unique index pr_review_comments_posted_semantic_unique
  on pr_review_comments(pull_request_id, semantic_fingerprint)
  where status = 'posted';

-- 14. incidents (created/updated from authenticated Datadog alert webhooks).
create table incidents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  webhook_event_id uuid references inbound_webhooks(id),
  external_alert_key text not null,
  incident_correlation_key text not null,
  alert_transition_key text,
  external_monitor_id text,
  datadog_event_id text,
  datadog_url text,
  service_name text,
  environment text default 'production',
  title text not null,
  description text,
  source text not null default 'Datadog monitor',
  alert_state alert_state not null,
  incident_state incident_state not null default 'active',
  investigation_job_id uuid references jobs(id),
  investigation_start_mode_snapshot investigation_start_mode not null,
  started_automatically boolean not null default false,
  signals jsonb not null default '[]',
  timeline jsonb not null default '[]',
  hypotheses jsonb not null default '[]',
  correlated_changes jsonb not null default '[]',
  alert_payload_summary jsonb not null default '{}',
  started_at timestamptz not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Only one active incident per correlation key; resolved incidents may share it.
create unique index incidents_active_correlation_unique
  on incidents(workspace_id, incident_correlation_key)
  where incident_state = 'active';
create index incidents_state_idx on incidents(workspace_id, incident_state, started_at desc);
create index incidents_alert_idx on incidents(workspace_id, alert_state, updated_at desc);

-- 15. telemetry_emissions (app-side audit of emitted reliability signals).
create table telemetry_emissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  job_id uuid references jobs(id),
  attempt_number integer,
  integration_id uuid references integrations(id),
  metric_name text not null,
  tags jsonb not null default '{}',
  value numeric not null default 1,
  truefoundry_trace_id text,
  truefoundry_request_id text,
  emission_state external_action_state not null default 'planned',
  idempotency_key text not null,
  emitted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint telemetry_emissions_idempotency_key unique (workspace_id, metric_name, idempotency_key)
);

-- updated_at maintenance for row-managed tables.
create trigger workspaces_updated_at before update on workspaces
  for each row execute function system.update_updated_at();
create trigger integrations_updated_at before update on integrations
  for each row execute function system.update_updated_at();
create trigger repositories_updated_at before update on repositories
  for each row execute function system.update_updated_at();
create trigger jobs_updated_at before update on jobs
  for each row execute function system.update_updated_at();
create trigger recommendations_updated_at before update on recommendations
  for each row execute function system.update_updated_at();
create trigger incidents_updated_at before update on incidents
  for each row execute function system.update_updated_at();
create trigger pr_review_comments_updated_at before update on pr_review_comments
  for each row execute function system.update_updated_at();
