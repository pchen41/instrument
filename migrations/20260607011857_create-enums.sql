-- Task 2: first-slice Postgres enums (docs/ERD.md "Enums").
-- Only values stored in typed columns become enums; JSON-only vocabularies are
-- validated in application code.

create type integration_provider as enum ('github', 'datadog', 'truefoundry');

create type integration_status as enum (
  'connected', 'disconnected', 'degraded', 'rate_limited', 'missing_credentials'
);

create type investigation_start_mode as enum ('manual', 'auto', 'smart');

create type job_type as enum (
  'github_pr_review_analysis',
  'proactive_scan',
  'recommendation_generation',
  'datadog_alert_generation',
  'incident_investigation',
  'recommendation_pr_generation'
);

create type job_state as enum ('queued', 'running', 'retrying', 'failed', 'succeeded');

create type webhook_auth_method as enum (
  'github_signature', 'shared_secret_header', 'custom_hmac', 'none'
);

create type recommendation_category as enum ('instrumentation', 'alert', 'pr_review');

create type recommendation_state as enum ('active', 'accepted', 'dismissed', 'outdated');

create type alert_state as enum ('firing', 'resolved');

create type incident_state as enum ('active', 'resolved');

create type confidence_level as enum ('high', 'likely', 'low');

create type evidence_source_type as enum (
  'code_file', 'pr_diff', 'commit',
  'datadog_monitor', 'datadog_metric', 'datadog_log', 'datadog_trace',
  'datadog_dashboard', 'datadog_alert_event',
  'truefoundry_log', 'truefoundry_metric',
  'mcp_tool_call', 'ai_model_call', 'webhook_payload'
);

create type evidence_verification_state as enum ('verified', 'stale', 'unavailable');

create type approval_state as enum ('requested', 'approved', 'rejected', 'revoked', 'executed');

create type external_action_state as enum (
  'planned', 'running', 'succeeded', 'failed', 'skipped_duplicate'
);
