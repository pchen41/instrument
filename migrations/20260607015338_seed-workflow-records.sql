-- Task 3: seed first-slice workflow records. Instrument is dogfooding itself —
-- every incident / recommendation / PR review is about the pchen41/instrument
-- repo and its own components (the console, the InsForge edge functions and job
-- worker, the Render TrueFoundry-MCP server, and the provider integrations).
-- Runs as project_admin (bypasses RLS). Idempotent: no-ops once incidents exist.
-- NO incident-fix PR generation is implied (that is future scope); incidents hold
-- investigation output only. Generated PR / draft-monitor results live in
-- recommendations.steps, not in separate generated-artifact tables.
do $$
declare
  v_user uuid;
  v_ws   uuid;
  v_repo uuid;
  v_gh   uuid;
  v_dd   uuid;
  v_tf   uuid;

  -- incidents
  v_inc1 uuid := gen_random_uuid(); -- active / complete (reliability proof)
  v_inc2 uuid := gen_random_uuid(); -- active / investigating (auto-started)
  v_inc3 uuid := gen_random_uuid(); -- active / investigating
  v_inc4 uuid := gen_random_uuid(); -- active / new (no job)
  v_inc5 uuid := gen_random_uuid(); -- active / failed investigation
  v_inc6 uuid := gen_random_uuid(); -- resolved
  v_inc7 uuid := gen_random_uuid(); -- resolved

  -- jobs
  v_job_inv1  uuid := gen_random_uuid(); -- succeeded  -> inc1 complete
  v_job_inv2  uuid := gen_random_uuid(); -- running    -> inc2 investigating
  v_job_inv3  uuid := gen_random_uuid(); -- retrying   -> inc3 investigating
  v_job_inv5  uuid := gen_random_uuid(); -- failed     -> inc5 failed
  v_job_inv6  uuid := gen_random_uuid(); -- succeeded  -> inc6 resolved
  v_job_scan  uuid := gen_random_uuid(); -- proactive_scan (created recs)
  v_job_prgen uuid := gen_random_uuid(); -- recommendation_pr_generation
  v_job_prrev uuid := gen_random_uuid(); -- github_pr_review_analysis

  -- recommendations
  v_rec1 uuid := gen_random_uuid(); -- active alert, multi-step + LOCKED step
  v_rec2 uuid := gen_random_uuid(); -- active instrumentation (generated PR)
  v_rec3 uuid := gen_random_uuid(); -- active alert (generated draft monitor)
  v_rec4 uuid := gen_random_uuid(); -- active alert (monitor change)
  v_rec5 uuid := gen_random_uuid(); -- active pr_review (posted comments)
  v_rec6 uuid := gen_random_uuid(); -- accepted
  v_rec7 uuid := gen_random_uuid(); -- outdated
  v_rec8 uuid := gen_random_uuid(); -- dismissed

  -- pull requests
  v_pr_metric   uuid := gen_random_uuid(); -- #12 generated metric PR (open)
  v_pr_review   uuid := gen_random_uuid(); -- #14 incoming PR Instrument reviewed
  v_pr_accepted uuid := gen_random_uuid(); -- #9 merged (accepted rec)

  -- model call, approvals, writes, evidence
  v_mc1 uuid := gen_random_uuid();
  v_appr_pr      uuid := gen_random_uuid();
  v_appr_monitor uuid := gen_random_uuid();
  v_ewa_pr      uuid := gen_random_uuid();
  v_ewa_monitor uuid := gen_random_uuid();
  v_ewa_cmt1 uuid := gen_random_uuid();
  v_ewa_cmt2 uuid := gen_random_uuid();
  v_ewa_cmt3 uuid := gen_random_uuid();
  v_ev_metric uuid := gen_random_uuid();
  v_ev_tfylog uuid := gen_random_uuid();
  v_ev_commit uuid := gen_random_uuid();
  v_ev_ghdiff uuid := gen_random_uuid();
begin
  select id into v_user from auth.users where email = 'test@test.com';
  select id into v_ws   from public.workspaces where slug = 'instrument';
  select id into v_repo from public.repositories where workspace_id = v_ws limit 1;
  select id into v_gh from public.integrations where workspace_id = v_ws and provider = 'github';
  select id into v_dd from public.integrations where workspace_id = v_ws and provider = 'datadog';
  select id into v_tf from public.integrations where workspace_id = v_ws and provider = 'truefoundry';
  if v_user is null or v_ws is null or v_repo is null then
    raise exception 'Task 2 base seed missing; run Task 2 migrations first.';
  end if;

  if exists (select 1 from public.incidents where workspace_id = v_ws) then
    raise notice 'Workflow records already seeded; skipping.';
    return;
  end if;

  -- ---- Integration health variety + repository service map ----------------
  -- TrueFoundry is rate-limited (this is what drives the reliability incident);
  -- GitHub/Datadog stay connected. (degraded / missing_credentials are exercised
  -- by the schema; the live demo shows connected + rate_limited.)
  update public.integrations
     set status = 'rate_limited',
         last_checked_at = now(),
         last_error_code = '429',
         last_error_summary = 'AI Gateway rate limit on model instrument/instrument'
   where id = v_tf;
  update public.integrations set status = 'connected', last_checked_at = now()
   where id in (v_gh, v_dd);

  update public.repositories
     set service_map = '[
       {"path_glob":"src/**","service_name":"instrument-console","environment":"production","confidence":"high","source":"manual"},
       {"path_glob":"functions/job-worker-tick/**","service_name":"job-worker-tick","environment":"production","confidence":"high","source":"manual"},
       {"path_glob":"functions/github-webhook/**","service_name":"github-webhook","environment":"production","confidence":"high","source":"manual"},
       {"path_glob":"functions/datadog-webhook/**","service_name":"datadog-webhook","environment":"production","confidence":"high","source":"manual"},
       {"path_glob":"functions/external-action-executor/**","service_name":"external-action-executor","environment":"production","confidence":"likely","source":"manual"},
       {"path_glob":"services/truefoundry-mcp/**","service_name":"instrument-mcp","environment":"production","confidence":"high","source":"manual"}
     ]'::jsonb,
         last_synced_at = now()
   where id = v_repo;

  -- ---- Jobs ----------------------------------------------------------------
  -- J1: the reliability proof — investigation that retried through TrueFoundry
  -- 429s before succeeding. attempts[] is the durable retry record.
  insert into public.jobs
    (id, workspace_id, job_type, state, target_type, target_id, idempotency_key,
     created_by, safe_to_retry, attempt_count, max_attempts, progress_version,
     phases, attempts, audit_events, trigger_summary,
     queued_at, started_at, completed_at)
  values
    (v_job_inv1, v_ws, 'incident_investigation', 'succeeded', 'incident', v_inc1,
     'inv-inc1', null, true, 3, 3, 4,
     '[
       {"key":"collect","label":"Collect signals","state":"succeeded","detail":"TrueFoundry request logs, gateway metrics, recent job attempts"},
       {"key":"correlate","label":"Correlate changes","state":"succeeded","detail":"Matched retries to 429 responses"},
       {"key":"hypothesize","label":"Rank hypotheses","state":"succeeded","detail":"High-confidence rate-limit root cause"}
     ]'::jsonb,
     '[
       {"attempt":1,"outcome":"retrying","started_at":"2026-06-06T14:22:40Z","completed_at":"2026-06-06T14:22:52Z","error_code":"tfy_429","error_summary":"TrueFoundry AI Gateway 429 rate limit","next_run_at":"2026-06-06T14:23:22Z"},
       {"attempt":2,"outcome":"retrying","started_at":"2026-06-06T14:23:22Z","completed_at":"2026-06-06T14:23:36Z","error_code":"tfy_429","error_summary":"TrueFoundry AI Gateway 429 rate limit","next_run_at":"2026-06-06T14:24:36Z"},
       {"attempt":3,"outcome":"succeeded","started_at":"2026-06-06T14:24:36Z","completed_at":"2026-06-06T14:25:10Z"}
     ]'::jsonb,
     '[
       {"at":"2026-06-06T14:22:31Z","kind":"enqueued","summary":"Investigation enqueued from Datadog alert evt-90a1"},
       {"at":"2026-06-06T14:22:52Z","kind":"retry","summary":"Attempt 1 hit TrueFoundry 429; backing off 30s"},
       {"at":"2026-06-06T14:25:10Z","kind":"completed","summary":"Root cause: TrueFoundry rate limit (high confidence)"}
     ]'::jsonb,
     '{"source":"datadog_alert","alert_id":"3041","monitor":"job-worker-tick retry rate"}'::jsonb,
     '2026-06-06T14:22:31Z', '2026-06-06T14:22:40Z', '2026-06-06T14:25:10Z');

  insert into public.jobs
    (id, workspace_id, job_type, state, target_type, target_id, idempotency_key,
     attempt_count, progress_version, phases, attempts, trigger_summary, queued_at, started_at)
  values
    (v_job_inv2, v_ws, 'incident_investigation', 'running', 'incident', v_inc2,
     'inv-inc2', 1, 2,
     '[{"key":"collect","label":"Collect signals","state":"running","detail":"Pulling traces and recent deploys for github-webhook"}]'::jsonb,
     '[{"attempt":1,"outcome":"retrying","started_at":"2026-06-06T14:44:20Z"}]'::jsonb,
     '{"source":"datadog_alert","alert_id":"3055"}'::jsonb,
     '2026-06-06T14:44:10Z','2026-06-06T14:44:20Z'),
    (v_job_inv3, v_ws, 'incident_investigation', 'retrying', 'incident', v_inc3,
     'inv-inc3', 2, 2,
     '[{"key":"collect","label":"Collect signals","state":"retrying","detail":"instrument-mcp tool call timed out; retrying"}]'::jsonb,
     '[{"attempt":1,"outcome":"failed","started_at":"2026-06-06T14:31:40Z","completed_at":"2026-06-06T14:31:58Z","error_code":"mcp_timeout","error_summary":"instrument-investigation MCP tool timed out"},
       {"attempt":2,"outcome":"retrying","started_at":"2026-06-06T14:33:00Z"}]'::jsonb,
     '{"source":"datadog_alert","alert_id":"3061"}'::jsonb,
     '2026-06-06T14:31:30Z','2026-06-06T14:31:40Z');

  insert into public.jobs
    (id, workspace_id, job_type, state, target_type, target_id, idempotency_key,
     safe_to_retry, attempt_count, max_attempts, progress_version,
     phases, attempts, audit_events, error_code, error_summary,
     failure_integration_id, failure_source, queued_at, started_at, completed_at)
  values
    (v_job_inv5, v_ws, 'incident_investigation', 'failed', 'incident', v_inc5,
     'inv-inc5', true, 3, 3, 4,
     '[{"key":"collect","label":"Collect signals","state":"failed","detail":"instrument-investigation MCP server unreachable"}]'::jsonb,
     '[{"attempt":1,"outcome":"failed","started_at":"2026-06-06T14:20:30Z","completed_at":"2026-06-06T14:20:51Z","error_code":"mcp_503","error_summary":"instrument-mcp returned 503"},
       {"attempt":2,"outcome":"failed","started_at":"2026-06-06T14:21:30Z","completed_at":"2026-06-06T14:21:49Z","error_code":"mcp_503","error_summary":"instrument-mcp returned 503"},
       {"attempt":3,"outcome":"failed","started_at":"2026-06-06T14:23:00Z","completed_at":"2026-06-06T14:23:20Z","error_code":"mcp_503","error_summary":"instrument-mcp returned 503"}]'::jsonb,
     '[{"at":"2026-06-06T14:23:20Z","kind":"failed","summary":"Investigation failed after 3 attempts; safe to retry"}]'::jsonb,
     'mcp_503', 'instrument-investigation MCP server unreachable (503)',
     v_tf, 'truefoundry', '2026-06-06T14:20:20Z', '2026-06-06T14:20:30Z', '2026-06-06T14:23:20Z');

  insert into public.jobs
    (id, workspace_id, job_type, state, target_type, target_id, idempotency_key,
     attempt_count, progress_version, phases, queued_at, started_at, completed_at)
  values
    (v_job_inv6, v_ws, 'incident_investigation', 'succeeded', 'incident', v_inc6,
     'inv-inc6', 1, 3,
     '[{"key":"collect","label":"Collect signals","state":"succeeded"},{"key":"hypothesize","label":"Rank hypotheses","state":"succeeded"}]'::jsonb,
     '2026-06-06T12:02:40Z','2026-06-06T12:02:50Z','2026-06-06T12:05:30Z'),
    (v_job_scan, v_ws, 'proactive_scan', 'succeeded', 'repository', v_repo,
     'scan-be5aa91', 1, 3,
     '[{"key":"scan","label":"Scan repository","state":"succeeded"},{"key":"analyze","label":"Analyze gaps","state":"succeeded"},{"key":"generate","label":"Generate recommendations","state":"succeeded"}]'::jsonb,
     '2026-06-06T13:40:00Z','2026-06-06T13:40:05Z','2026-06-06T13:41:20Z'),
    (v_job_prgen, v_ws, 'recommendation_pr_generation', 'succeeded', 'recommendation', v_rec1,
     'prgen-rec1-metric', 1, 3,
     '[{"key":"branch","label":"Create branch","state":"succeeded"},{"key":"commit","label":"Write files","state":"succeeded"},{"key":"open_pr","label":"Open PR","state":"succeeded"}]'::jsonb,
     '2026-06-06T13:50:00Z','2026-06-06T13:50:04Z','2026-06-06T13:50:40Z'),
    (v_job_prrev, v_ws, 'github_pr_review_analysis', 'succeeded', 'pull_request', v_pr_review,
     'prrev-pr14', 1, 3,
     '[{"key":"diff","label":"Read PR diff","state":"succeeded"},{"key":"review","label":"Find observability gaps","state":"succeeded"},{"key":"comment","label":"Post review comments","state":"succeeded"}]'::jsonb,
     '2026-06-06T13:12:00Z','2026-06-06T13:12:03Z','2026-06-06T13:12:55Z');

  -- ---- AI model call (TrueFoundry Agent) for the reliability investigation ---
  insert into public.ai_model_calls
    (id, workspace_id, integration_id, job_id, purpose, api_surface,
     truefoundry_response_id, truefoundry_trace_id, gateway_base_url_name,
     provider_name, model_name, agent_iteration_limit, mcp_servers_requested,
     tool_calls_redacted, request_schema_version, output_schema_version, input_hash,
     output_redacted, validation_status, input_tokens, output_tokens, total_tokens,
     latency_ms, status, started_at, completed_at)
  values
    (v_mc1, v_ws, v_tf, v_job_inv1, 'incident_hypotheses', 'agent_chat_completions',
     'resp-aa11', 'tr-aa11', 'truefoundry-gateway', 'truefoundry',
     'instrument/instrument', 6,
     '[{"fqn":"peterc/mcp/instrument-investigation/server","tools":["truefoundry_request_logs","truefoundry_model_metrics"]},
       {"fqn":"peterc/mcp/datadog/server","tools":["get_metric"]},
       {"fqn":"peterc/mcp/github/server","tools":["get_commit"]}]'::jsonb,
     ('[{"server":"instrument-investigation","tool":"truefoundry_request_logs","arguments_summary":"window=15m, model=instrument/instrument","result_summary":"38% of gateway calls returned 429 over 15m","ok":true,"evidence_id":"'||v_ev_tfylog||'"},
       {"server":"datadog","tool":"get_metric","arguments_summary":"instrument.job.retry by service","result_summary":"retry rate 12.4/min vs 0.3 baseline","ok":true,"evidence_id":"'||v_ev_metric||'"},
       {"server":"github","tool":"get_commit","arguments_summary":"sha 9658c73","result_summary":"raised agent iteration limit","ok":true,"evidence_id":"'||v_ev_commit||'"}]')::jsonb,
     'agent_request.v1', 'incident_hypotheses.v1', 'ih-aa11',
     '{"leading_hypothesis":"truefoundry_rate_limit","confidence":"high"}'::jsonb,
     'valid', 2100, 540, 2640, 4200, 'succeeded',
     '2026-06-06T14:22:55Z', '2026-06-06T14:25:08Z');

  -- ---- Pull requests -------------------------------------------------------
  insert into public.github_pull_requests
    (id, workspace_id, repository_id, external_pr_number, title, author_login, state,
     base_branch, head_branch, head_sha, html_url, opened_at, last_synced_at)
  values
    (v_pr_metric, v_ws, v_repo, 12, 'Add retry-rate metric to job-worker-tick',
     'instrument-bot', 'open', 'main', 'instrument/job-worker-retry-metric', 'm12a1c9',
     'https://github.com/pchen41/instrument/pull/12', '2026-06-06T13:50:35Z', now()),
    (v_pr_review, v_ws, v_repo, 14, 'Add external-action-executor edge function',
     'pchen41', 'open', 'main', 'feature/external-action-executor', 'c14a77b',
     'https://github.com/pchen41/instrument/pull/14', '2026-06-06T13:05:00Z', now());

  insert into public.github_pull_requests
    (id, workspace_id, repository_id, external_pr_number, title, author_login, state,
     base_branch, head_branch, head_sha, html_url, opened_at, merged_at, closed_at, last_synced_at)
  values
    (v_pr_accepted, v_ws, v_repo, 9, 'Add signature-failure metric to github-webhook',
     'instrument-bot', 'merged', 'main', 'instrument/github-webhook-sig-metric', 'g9b3d2e',
     'https://github.com/pchen41/instrument/pull/9', '2026-06-05T22:10:00Z',
     '2026-06-06T09:30:00Z', '2026-06-06T09:30:00Z', now());

  -- ---- Approvals (gate recommendation PR generation + draft monitor) -------
  insert into public.approvals
    (id, workspace_id, action_type, target_type, target_id, target_step_key,
     requested_by, approved_by, state, approval_summary, approved_payload_hash,
     idempotency_key, created_at, approved_at, executed_at)
  values
    (v_appr_pr, v_ws, 'generate_recommendation_pr', 'recommendation', v_rec1, 'add-retry-metric',
     v_user, v_user, 'executed', 'Generate a PR adding a retry-rate metric to job-worker-tick',
     'ph-pr-12', 'appr-pr-rec1', '2026-06-06T13:48:00Z', '2026-06-06T13:49:30Z', '2026-06-06T13:50:40Z'),
    (v_appr_monitor, v_ws, 'create_datadog_monitor', 'recommendation', v_rec3, 'create-mcp-health-monitor',
     v_user, v_user, 'approved', 'Create a draft Datadog monitor for instrument-mcp /healthz availability',
     'ph-monitor-3098', 'appr-monitor-rec3', '2026-06-06T13:55:00Z', '2026-06-06T13:56:10Z', null);

  -- ---- External write actions (audit + idempotency for provider writes) ----
  insert into public.external_write_actions
    (id, workspace_id, approval_id, job_id, provider, action_kind, idempotency_key,
     target_summary, request_hash, external_id, external_url, state, started_at, completed_at)
  values
    (v_ewa_pr, v_ws, v_appr_pr, v_job_prgen, 'github', 'github_create_pr', 'ewa-github-pr-12',
     'PR #12: add retry-rate metric to job-worker-tick', 'ph-pr-12', '12',
     'https://github.com/pchen41/instrument/pull/12', 'succeeded',
     '2026-06-06T13:50:20Z', '2026-06-06T13:50:40Z'),
    (v_ewa_monitor, v_ws, v_appr_monitor, null, 'datadog', 'datadog_create_monitor', 'ewa-datadog-monitor-3098',
     'Draft monitor: instrument-mcp /healthz availability', 'ph-monitor-3098', '3098',
     'https://us5.datadoghq.com/monitors/3098', 'succeeded',
     '2026-06-06T13:56:20Z', '2026-06-06T13:56:35Z');

  -- Automatic PR review comments: no approval, but still audited + idempotent.
  insert into public.external_write_actions
    (id, workspace_id, approval_id, job_id, provider, action_kind, idempotency_key,
     target_summary, request_hash, external_id, external_url, state, completed_at)
  values
    (v_ewa_cmt1, v_ws, null, v_job_prrev, 'github', 'github_review_comment', 'ewa-cmt-pr14-extexec-latency',
     'Review comment on PR #14 (missing latency metric)', 'h-cmt1', 'rc-1',
     'https://github.com/pchen41/instrument/pull/14#discussion_r1', 'succeeded', '2026-06-06T13:12:50Z'),
    (v_ewa_cmt2, v_ws, null, v_job_prrev, 'github', 'github_review_comment', 'ewa-cmt-pr14-extexec-errcount',
     'Review comment on PR #14 (missing error counter)', 'h-cmt2', 'rc-2',
     'https://github.com/pchen41/instrument/pull/14#discussion_r2', 'succeeded', '2026-06-06T13:12:52Z'),
    (v_ewa_cmt3, v_ws, null, v_job_prrev, 'github', 'github_review_comment', 'ewa-cmt-pr14-extexec-idemlog',
     'Review comment on PR #14 (no idempotency log)', 'h-cmt3', 'rc-3',
     'https://github.com/pchen41/instrument/pull/14#discussion_r3', 'succeeded', '2026-06-06T13:12:54Z');

  -- ---- Incidents -----------------------------------------------------------
  -- inc1: reliability proof (active / complete). Signals + hypotheses carry
  -- evidence IDs; other incidents keep evidence_id null ("where available").
  insert into public.incidents
    (id, workspace_id, external_alert_key, incident_correlation_key, alert_transition_key,
     external_monitor_id, datadog_event_id, datadog_url, service_name, environment,
     title, description, alert_state, incident_state, investigation_job_id,
     investigation_start_mode_snapshot, started_automatically,
     signals, timeline, hypotheses, correlated_changes, alert_payload_summary,
     started_at)
  values
    (v_inc1, v_ws, 'monitor-3041', 'job-worker-tick:tfy-429', 'job-worker-tick:tfy-429:Triggered:1',
     '3041', 'evt-90a1', 'https://us5.datadoghq.com/event/event?id=evt-90a1',
     'job-worker-tick', 'production',
     'Investigation jobs stalling on TrueFoundry rate limits',
     'job-worker-tick retries spiked after the TrueFoundry AI Gateway began returning 429s. Instrument investigated and proposed a high-confidence root cause.',
     'firing', 'active', v_job_inv1, 'manual', false,
     ('[{"key":"retry_rate","label":"job retry rate","value":"12.4/min (baseline 0.3)","evidence_id":"'||v_ev_metric||'"},
        {"key":"gateway_429","label":"TrueFoundry 429 rate","value":"38% of gateway calls","evidence_id":"'||v_ev_tfylog||'"},
        {"key":"due_jobs","label":"jobs waiting","value":"17"},
        {"key":"ttd","label":"time to detect","value":"1m 04s"}]')::jsonb,
     '[{"at":"2026-06-06T14:22:07Z","kind":"alert","title":"Datadog monitor fired","detail":"instrument.job.retry on job-worker-tick crossed 5/min."},
       {"at":"2026-06-06T14:22:31Z","kind":"action","title":"Instrument began investigating","detail":"Pulled TrueFoundry request logs and gateway metrics via the instrument-investigation MCP."},
       {"at":"2026-06-06T14:23:48Z","kind":"finding","title":"Correlated retries with 429s","detail":"Job retries line up 1:1 with gateway 429 responses."},
       {"at":"2026-06-06T14:25:10Z","kind":"finding","title":"Root cause proposed","detail":"High confidence: AI Gateway rate limit, not a code defect."}]'::jsonb,
     ('[{"rank":1,"leading":true,"root_cause_type":"runtime_config","summary":"TrueFoundry AI Gateway rate limit on the configured model","detail":"The gateway started returning 429 at ~14:02 and the worker backoff-retries match the 429 rate exactly. No recent deploy touched the worker.","confidence":"high","evidence_ids":["'||v_ev_tfylog||'","'||v_ev_metric||'"]},
        {"rank":2,"leading":false,"root_cause_type":"code","summary":"Unbounded concurrency in the worker tick","detail":"The tick claims all due jobs at once; possible, but the 429 timing is a stronger signal.","confidence":"low","evidence_ids":[]}]')::jsonb,
     ('[{"kind":"commit","ref":"9658c73","summary":"update mcp — raised agent iteration limit","url":"https://github.com/pchen41/instrument/commit/9658c73","evidence_id":"'||v_ev_commit||'"},
        {"kind":"config","ref":"truefoundry/gateway","summary":"Gateway rate limit reached for model instrument/instrument"}]')::jsonb,
     '{"monitor_id":"3041","alert_cycle_key":"job-worker-tick:tfy-429","transition":"Triggered","tags":{"service":"job-worker-tick","env":"production","instrument_reliability":"true"}}'::jsonb,
     '2026-06-06T14:22:07Z');

  insert into public.incidents
    (id, workspace_id, external_alert_key, incident_correlation_key, external_monitor_id,
     datadog_url, service_name, title, description, alert_state, incident_state,
     investigation_job_id, investigation_start_mode_snapshot, started_automatically,
     signals, timeline, hypotheses, correlated_changes, alert_payload_summary, started_at)
  values
    (v_inc2, v_ws, 'monitor-3055', 'github-webhook:5xx', '3055',
     'https://us5.datadoghq.com/monitors/3055', 'github-webhook',
     'Error rate climbing on github-webhook',
     '5xx on the github-webhook function rose to 4.5% right after a deploy and is still climbing. Investigation started automatically.',
     'firing', 'active', v_job_inv2, 'auto', true,
     '[{"key":"err_rate","label":"5xx rate","value":"4.5%"},{"key":"baseline","label":"baseline","value":"0.3%"},{"key":"deploy","label":"deploy","value":"be5aa91"}]'::jsonb,
     '[{"at":"2026-06-06T14:44:00Z","kind":"alert","title":"Datadog monitor fired","detail":"5xx on github-webhook crossed 2%."},
       {"at":"2026-06-06T14:44:20Z","kind":"action","title":"Instrument started investigating automatically","detail":"Investigation start is set to automatic, so Instrument began correlating the deploy, traces, and logs on its own."}]'::jsonb,
     '[{"rank":1,"leading":true,"root_cause_type":"code","summary":"Signature check rejects valid deliveries after be5aa91","detail":"Error onset lines up with the deploy that touched webhook auth. Instrument is confirming the correlation.","confidence":"likely"}]'::jsonb,
     '[{"kind":"commit","ref":"be5aa91","summary":"task 1 readiness — touched webhook auth path","url":"https://github.com/pchen41/instrument/commit/be5aa91"}]'::jsonb,
     '{"monitor_id":"3055","tags":{"service":"github-webhook","env":"production"}}'::jsonb,
     '2026-06-06T14:44:00Z'),
    (v_inc3, v_ws, 'monitor-3061', 'instrument-mcp:latency', '3061',
     'https://us5.datadoghq.com/monitors/3061', 'instrument-mcp',
     'instrument-mcp tool-call latency elevated',
     'p95 latency on the instrument-investigation MCP /mcp endpoint doubled, slowing investigations.',
     'firing', 'active', v_job_inv3, 'manual', false,
     '[{"key":"p95","label":"/mcp p95","value":"3.1s"},{"key":"baseline","label":"baseline","value":"1.2s"},{"key":"host","label":"host","value":"instrument-9z6j.onrender.com"}]'::jsonb,
     '[{"at":"2026-06-06T14:31:14Z","kind":"alert","title":"Datadog monitor fired","detail":"instrument-mcp /mcp p95 crossed 2.5s."},
       {"at":"2026-06-06T14:31:40Z","kind":"action","title":"Instrument began investigating","detail":"Correlating Render instance metrics with TrueFoundry request volume."}]'::jsonb,
     '[{"rank":1,"leading":true,"root_cause_type":"runtime_config","summary":"Render instance CPU-bound under investigation burst","detail":"MCP latency tracks investigation concurrency; the free Render instance pins CPU. Likely, still gathering signal.","confidence":"likely"},
       {"rank":2,"leading":false,"root_cause_type":"upstream","summary":"TrueFoundry metrics API slow","detail":"Upstream metric queries are slightly elevated. Not ruled out.","confidence":"low"}]'::jsonb,
     '[]'::jsonb,
     '{"monitor_id":"3061","tags":{"service":"instrument-mcp","env":"production"}}'::jsonb,
     '2026-06-06T14:31:14Z');

  insert into public.incidents
    (id, workspace_id, external_alert_key, incident_correlation_key, external_monitor_id,
     datadog_url, service_name, title, description, alert_state, incident_state,
     investigation_job_id, investigation_start_mode_snapshot, started_automatically,
     signals, timeline, hypotheses, correlated_changes, alert_payload_summary, started_at)
  values
    (v_inc4, v_ws, 'monitor-3068', 'datadog-webhook:delay', '3068',
     'https://us5.datadoghq.com/monitors/3068', 'datadog-webhook',
     'Datadog webhook deliveries delayed',
     'Inbound Datadog webhook processing lag crossed 60s. No investigation has been started yet — investigation start is manual.',
     'firing', 'active', null, 'manual', false,
     '[{"key":"lag","label":"processing lag","value":"74s"},{"key":"backlog","label":"backlog","value":"~120 deliveries"},{"key":"ttd","label":"time to detect","value":"0m 52s"}]'::jsonb,
     '[{"at":"2026-06-06T14:43:10Z","kind":"alert","title":"Datadog monitor fired","detail":"datadog-webhook processing lag crossed 60s."}]'::jsonb,
     '[{"rank":1,"leading":true,"root_cause_type":"unknown","summary":"Worker tick not draining due webhooks fast enough","detail":"Tentative — Instrument will confirm once you start the investigation.","confidence":"low"}]'::jsonb,
     '[]'::jsonb,
     '{"monitor_id":"3068","tags":{"service":"datadog-webhook","env":"production"}}'::jsonb,
     '2026-06-06T14:43:10Z'),
    (v_inc5, v_ws, 'monitor-3072', 'external-action-executor:5xx', '3072',
     'https://us5.datadoghq.com/monitors/3072', 'external-action-executor',
     'Elevated 5xx on external-action-executor',
     'external-action-executor 5xx rose after a provider write spike. The investigation failed after 3 attempts because the instrument-investigation MCP server was unreachable — retry is available.',
     'firing', 'active', v_job_inv5, 'manual', false,
     '[{"key":"err_rate","label":"5xx rate","value":"3.2%"},{"key":"writes","label":"provider writes/min","value":"41"}]'::jsonb,
     '[{"at":"2026-06-06T14:20:10Z","kind":"alert","title":"Datadog monitor fired","detail":"5xx on external-action-executor crossed 2%."},
       {"at":"2026-06-06T14:20:30Z","kind":"action","title":"Instrument began investigating","detail":"Started correlating provider writes, traces, and logs."},
       {"at":"2026-06-06T14:23:20Z","kind":"note","title":"Investigation failed","detail":"instrument-investigation MCP returned 503 on all 3 attempts. Safe to retry."}]'::jsonb,
     '[]'::jsonb,
     '[]'::jsonb,
     '{"monitor_id":"3072","tags":{"service":"external-action-executor","env":"production"}}'::jsonb,
     '2026-06-06T14:20:10Z');

  -- resolved incidents
  insert into public.incidents
    (id, workspace_id, external_alert_key, incident_correlation_key, external_monitor_id,
     datadog_url, service_name, title, description, alert_state, incident_state,
     investigation_job_id, investigation_start_mode_snapshot, started_automatically,
     signals, timeline, hypotheses, correlated_changes, alert_payload_summary,
     started_at, resolved_at)
  values
    (v_inc6, v_ws, 'monitor-3041', 'job-worker-tick:tfy-429:resolved-1', '3041',
     'https://us5.datadoghq.com/monitors/3041', 'job-worker-tick',
     'TrueFoundry retry storm on job-worker-tick',
     'Resolved. An earlier 429 burst from the AI Gateway drove a retry storm; the worker backoff was tuned and the burst cleared. Open 3m.',
     'resolved', 'resolved', v_job_inv6, 'manual', false,
     '[{"key":"duration","label":"duration","value":"3m"},{"key":"peak_retry","label":"peak retry rate","value":"9.1/min"},{"key":"resolution","label":"resolution","value":"backoff tuned"}]'::jsonb,
     '[{"at":"2026-06-06T12:02:10Z","kind":"alert","title":"Datadog monitor fired","detail":"instrument.job.retry crossed 5/min."},
       {"at":"2026-06-06T12:03:40Z","kind":"finding","title":"Root cause found","detail":"AI Gateway 429 burst; worker retried with too-short backoff."},
       {"at":"2026-06-06T12:05:30Z","kind":"note","title":"Resolved","detail":"Backoff window raised; retry rate returned to baseline."}]'::jsonb,
     '[{"rank":1,"leading":true,"root_cause_type":"runtime_config","summary":"AI Gateway 429 burst with short worker backoff","detail":"Confirmed — raising the backoff window drained the retries.","confidence":"high"}]'::jsonb,
     '[{"kind":"config","ref":"job-worker-tick/backoff","summary":"Raised retry backoff window"}]'::jsonb,
     '{"monitor_id":"3041","transition":"Recovered","tags":{"service":"job-worker-tick","env":"production"}}'::jsonb,
     '2026-06-06T12:02:10Z', '2026-06-06T12:05:30Z'),
    (v_inc7, v_ws, 'monitor-3030', 'github-webhook:sig-fail', '3030',
     'https://us5.datadoghq.com/monitors/3030', 'github-webhook',
     'github-webhook signature validation failures',
     'Resolved. A webhook secret rotation was not picked up, so valid deliveries were rejected; the secret_ref was refreshed. Open 22m.',
     'resolved', 'resolved', null, 'manual', false,
     '[{"key":"duration","label":"duration","value":"22m"},{"key":"rejected","label":"rejected deliveries","value":"~210"},{"key":"resolution","label":"resolution","value":"secret refresh"}]'::jsonb,
     '[{"at":"2026-06-06T09:48:02Z","kind":"alert","title":"Datadog monitor fired","detail":"github-webhook signature_valid=false rate crossed 5%."},
       {"at":"2026-06-06T09:50:10Z","kind":"finding","title":"Root cause found","detail":"Webhook secret rotated but the function still used the old secret_ref."},
       {"at":"2026-06-06T10:10:30Z","kind":"note","title":"Resolved","detail":"GITHUB_WEBHOOK_SECRET refreshed; deliveries validated again."}]'::jsonb,
     '[{"rank":1,"leading":true,"root_cause_type":"runtime_config","summary":"Stale webhook secret_ref after rotation","detail":"Confirmed — refreshing the secret reference restored validation.","confidence":"high"}]'::jsonb,
     '[{"kind":"config","ref":"github-webhook/secret","summary":"Refreshed GITHUB_WEBHOOK_SECRET reference"}]'::jsonb,
     '{"monitor_id":"3030","transition":"Recovered","tags":{"service":"github-webhook","env":"production"}}'::jsonb,
     '2026-06-06T09:48:02Z', '2026-06-06T10:10:30Z');

  -- ---- Recommendations -----------------------------------------------------
  -- rec1: ALERT, multi-step DEPENDENT with a LOCKED second step. Step 1 generated
  -- a metric PR (synced as #12); step 2 (the monitor) stays locked until it merges.
  insert into public.recommendations
    (id, workspace_id, repository_id, created_by_job_id, last_seen_job_id, category, state,
     title, rationale, service_name, environment, affected_code_path, affected_runtime_path,
     proposed_next_step, steps, lifecycle_events, confidence, dedupe_fingerprint,
     created_by_model_call_id, validated_schema_version, created_at)
  values
    (v_rec1, v_ws, v_repo, v_job_scan, v_job_scan, 'alert', 'active',
     'job-worker-tick has no alert on its retry rate',
     'job-worker-tick retries on TrueFoundry rate limits but nothing watches the retry rate, so a retry storm builds with no signal. The alert can only exist once the metric does, so this is two reviewed changes, in order.',
     'job-worker-tick', 'production', 'functions/job-worker-tick/index.ts', 'instrument.job.retry',
     'Merge the retry-metric PR (#12), then create the monitor.',
     ('[{"key":"add-retry-metric","order":0,"kind":"code_pr","state":"ready","label":"Add a retry-rate metric to job-worker-tick","target_provider":"github","metric_verification_state":"expected_after_step","approval_id":"'||v_appr_pr||'","job_id":"'||v_job_prgen||'","generated_pr":{"number":12,"branch":"instrument/job-worker-retry-metric","url":"https://github.com/pchen41/instrument/pull/12","files":["functions/job-worker-tick/index.ts"],"patch_excerpt":"+ telemetry.recordJobRetry({ service: ''job-worker-tick'', error_code });"}},
        {"key":"create-retry-monitor","order":1,"kind":"datadog_new_monitor","state":"locked","label":"Alert when instrument.job.retry > 5/min sustained 2m","prerequisite_step_key":"add-retry-metric","waits_for":"the retry-metric PR (#12) is merged","target_provider":"datadog","metric_verification_state":"expected_after_step"}]')::jsonb,
     '[{"at":"2026-06-06T13:41:20Z","event":"created","detail":"Found by proactive scan of main"},
       {"at":"2026-06-06T13:50:40Z","event":"pr_generated","detail":"Opened PR #12 for the metric step"}]'::jsonb,
     'high', 'alert:job-worker-tick:instrument.job.retry', v_mc1, 'recommendation.v1',
     '2026-06-06T13:41:20Z');

  -- rec2: INSTRUMENTATION, single generated PR (not yet synced to a PR row).
  insert into public.recommendations
    (id, workspace_id, repository_id, created_by_job_id, last_seen_job_id, category, state,
     title, rationale, service_name, environment, affected_code_path,
     proposed_next_step, steps, lifecycle_events, confidence, dedupe_fingerprint,
     validated_schema_version, created_at)
  values
    (v_rec2, v_ws, v_repo, v_job_scan, v_job_scan, 'instrumentation', 'active',
     'Add a trace span around the TrueFoundry Agent call in job-worker-tick',
     'The investigation path calls the TrueFoundry Agent API with no span, so latency and retries are invisible in traces. A PR can wrap the call in an OpenTelemetry span.',
     'job-worker-tick', 'production', 'functions/job-worker-tick/index.ts',
     'Review and merge the instrumentation PR.',
     '[{"key":"add-agent-span","order":0,"kind":"code_pr","state":"ready","label":"Wrap the TrueFoundry Agent call in an OpenTelemetry span","target_provider":"github","metric_verification_state":"unverified","generated_pr":{"branch":"instrument/job-worker-agent-span","files":["functions/job-worker-tick/index.ts"],"patch_excerpt":"+ const span = tracer.startSpan(''truefoundry.agent.invoke'');"}}]'::jsonb,
     '[{"at":"2026-06-06T13:41:20Z","event":"created","detail":"Found by proactive scan of main"}]'::jsonb,
     'likely', 'instrumentation:job-worker-tick:agent-span', 'recommendation.v1',
     '2026-06-06T13:41:20Z');

  -- rec3: ALERT, draft Datadog monitor already generated (after approval).
  insert into public.recommendations
    (id, workspace_id, repository_id, created_by_job_id, last_seen_job_id, category, state,
     title, rationale, service_name, environment, affected_runtime_path,
     proposed_next_step, steps, lifecycle_events, confidence, dedupe_fingerprint,
     validated_schema_version, created_at)
  values
    (v_rec3, v_ws, v_repo, v_job_scan, v_job_scan, 'alert', 'active',
     'No availability monitor on the instrument-mcp /healthz endpoint',
     'The Render-hosted instrument-investigation MCP server has no uptime monitor, so an outage (like the 503s that failed an investigation) goes unnoticed. A draft monitor has been generated for review.',
     'instrument-mcp', 'production', 'https://instrument-9z6j.onrender.com/healthz',
     'Review the draft monitor in Datadog and publish it when ready.',
     ('[{"key":"create-mcp-health-monitor","order":0,"kind":"datadog_new_monitor","state":"ready","label":"Draft monitor: instrument-mcp /healthz availability","target_provider":"datadog","approval_id":"'||v_appr_monitor||'","metric_verification_state":"verified_in_datadog","generated_monitor":{"monitor_id":"3098","name":"instrument-mcp · /healthz availability","url":"https://us5.datadoghq.com/monitors/3098","draft":true}}]')::jsonb,
     '[{"at":"2026-06-06T13:41:20Z","event":"created","detail":"Found by proactive scan"},
       {"at":"2026-06-06T13:56:35Z","event":"draft_monitor_created","detail":"Created draft monitor 3098 after approval"}]'::jsonb,
     'likely', 'alert:instrument-mcp:healthz-availability', 'recommendation.v1',
     '2026-06-06T13:41:20Z');

  -- rec4: ALERT, reviewable monitor change (no PR, no new monitor).
  insert into public.recommendations
    (id, workspace_id, repository_id, created_by_job_id, last_seen_job_id, category, state,
     title, rationale, service_name, environment, affected_runtime_path,
     proposed_next_step, steps, lifecycle_events, confidence, dedupe_fingerprint,
     validated_schema_version, created_at)
  values
    (v_rec4, v_ws, v_repo, v_job_scan, v_job_scan, 'alert', 'active',
     'p99 monitor on datadog-webhook is too sensitive',
     'The datadog-webhook latency monitor fired 7 times last week with no user impact. Raising the threshold from 300ms to 450ms would cut alert fatigue while still catching real regressions.',
     'datadog-webhook', 'production', 'datadog-webhook · p99 latency',
     'Review and apply the monitor threshold change in Datadog.',
     '[{"key":"raise-p99-threshold","order":0,"kind":"datadog_monitor_change","state":"available","label":"Raise the p99 alert threshold from 300ms to 450ms","target_provider":"datadog","configuration_diff":{"monitor":"datadog-webhook · p99 latency","rows":[{"k":"Threshold","from":"300ms","to":"450ms"},{"k":"Sustained for","v":"5 min"},{"k":"Notifies","v":"#instrument-oncall"}]}}]'::jsonb,
     '[{"at":"2026-06-06T13:41:20Z","event":"created","detail":"Found by proactive scan"}]'::jsonb,
     'likely', 'alert:datadog-webhook:p99-threshold', 'recommendation.v1',
     '2026-06-06T13:41:20Z');

  -- rec5: PR REVIEW — Instrument reviewed incoming PR #14 and posted comments.
  insert into public.recommendations
    (id, workspace_id, repository_id, created_by_job_id, last_seen_job_id, category, state,
     title, rationale, service_name, environment, affected_code_path,
     proposed_next_step, steps, lifecycle_events, dedupe_fingerprint,
     validated_schema_version, created_at)
  values
    (v_rec5, v_ws, v_repo, v_job_prrev, v_job_prrev, 'pr_review', 'active',
     'PR #14 adds external-action-executor with no instrumentation',
     'PR #14 introduces the external-action-executor edge function that performs provider writes, with no metrics or logs on the write path. Instrument reviewed the diff and left 3 comments on the PR suggesting where to add observability before it merges.',
     'external-action-executor', 'production', 'functions/external-action-executor/index.ts',
     'View the 3 comments on PR #14; nothing to approve — they are already posted.',
     ('[{"key":"pr14-review","order":0,"kind":"pr_review_record","state":"done","label":"3 observability comments posted on PR #14","target_provider":"github","completion_source":"pr_review_recorded","job_id":"'||v_job_prrev||'"}]')::jsonb,
     '[{"at":"2026-06-06T13:12:55Z","event":"created","detail":"PR #14 opened; review analysis posted 3 comments"}]'::jsonb,
     'pr_review:pr14:external-action-executor', 'recommendation.v1',
     '2026-06-06T13:12:55Z');

  -- rec6: ACCEPTED — generated PR merged.
  insert into public.recommendations
    (id, workspace_id, repository_id, created_by_job_id, last_seen_job_id, category, state,
     title, rationale, service_name, environment, affected_code_path,
     proposed_next_step, steps, lifecycle_events, confidence, dedupe_fingerprint,
     validated_schema_version, created_at, accepted_at)
  values
    (v_rec6, v_ws, v_repo, v_job_scan, v_job_scan, 'instrumentation', 'accepted',
     'github-webhook had no signature-failure metric',
     'Webhook signature failures were unmetered, so a secret-rotation regression stayed invisible. A counter now tracks signature_valid=false by reason.',
     'github-webhook', 'production', 'functions/github-webhook/index.ts',
     'Done — the metric PR (#9) was merged.',
     ('[{"key":"add-sig-fail-metric","order":0,"kind":"code_pr","state":"done","label":"Add a signature-failure counter to github-webhook","target_provider":"github","completion_source":"generated_pr_merged","completion_evidence_id":"'||v_ev_ghdiff||'","generated_pr":{"number":9,"branch":"instrument/github-webhook-sig-metric","url":"https://github.com/pchen41/instrument/pull/9","files":["functions/github-webhook/index.ts"]}}]')::jsonb,
     '[{"at":"2026-06-05T21:40:00Z","event":"created","detail":"Found by proactive scan"},
       {"at":"2026-06-05T22:10:00Z","event":"pr_generated","detail":"Opened PR #9"},
       {"at":"2026-06-06T09:30:00Z","event":"accepted","detail":"PR #9 merged"}]'::jsonb,
     'high', 'instrumentation:github-webhook:sig-fail-metric', 'recommendation.v1',
     '2026-06-05T21:40:00Z', '2026-06-06T09:30:00Z');

  -- rec7: OUTDATED — the code path moved on.
  insert into public.recommendations
    (id, workspace_id, repository_id, created_by_job_id, last_seen_job_id, category, state,
     title, rationale, service_name, environment, affected_code_path,
     proposed_next_step, steps, lifecycle_events, dedupe_fingerprint,
     validated_schema_version, outdated_reason, created_at, outdated_at)
  values
    (v_rec7, v_ws, v_repo, v_job_scan, v_job_scan, 'instrumentation', 'outdated',
     'Add a trace span to the legacy polling loop in job-worker-tick',
     'Suggested before the worker moved from a polling loop to scheduled ticks. The polling path was removed, so the change no longer applies.',
     'job-worker-tick', 'production', 'functions/job-worker-tick/index.ts',
     'No action — superseded by the scheduled-tick design.',
     '[{"key":"add-poll-span","order":0,"kind":"code_pr","state":"skipped","label":"Add a span to the polling loop","target_provider":"github"}]'::jsonb,
     '[{"at":"2026-06-05T18:00:00Z","event":"created","detail":"Found by proactive scan"},
       {"at":"2026-06-06T13:41:20Z","event":"outdated","detail":"Polling loop removed in bf5775b"}]'::jsonb,
     'instrumentation:job-worker-tick:poll-span', 'recommendation.v1',
     'The polling loop was replaced by scheduled ticks in commit bf5775b; the path no longer exists.',
     '2026-06-05T18:00:00Z', '2026-06-06T13:41:20Z');

  -- rec8: DISMISSED — a human waved it off.
  insert into public.recommendations
    (id, workspace_id, repository_id, created_by_job_id, last_seen_job_id, category, state,
     title, rationale, service_name, environment, affected_code_path,
     proposed_next_step, steps, lifecycle_events, dedupe_fingerprint,
     validated_schema_version, created_at, dismissed_at)
  values
    (v_rec8, v_ws, v_repo, v_job_scan, v_job_scan, 'instrumentation', 'dismissed',
     'Lower log verbosity on job-worker-tick in production',
     'Flagged as noisy, but the team is keeping debug logs on intentionally while the worker runtime is being validated.',
     'job-worker-tick', 'production', 'functions/job-worker-tick/index.ts',
     'Dismissed — debug logging kept on during runtime validation.',
     '[{"key":"lower-log-verbosity","order":0,"kind":"manual_check","state":"skipped","label":"Set log level to warn in production"}]'::jsonb,
     '[{"at":"2026-06-06T13:41:20Z","event":"created","detail":"Found by proactive scan"},
       {"at":"2026-06-06T13:55:00Z","event":"dismissed","detail":"Kept intentionally during worker validation"}]'::jsonb,
     'instrumentation:job-worker-tick:log-verbosity', 'recommendation.v1',
     '2026-06-06T13:41:20Z', '2026-06-06T13:55:00Z');

  -- ---- PR review comments (posted on PR #14) ------------------------------
  insert into public.pr_review_comments
    (workspace_id, pull_request_id, recommendation_id, job_id, external_write_action_id,
     external_comment_id, event_action, head_sha, semantic_fingerprint, revision_fingerprint,
     issue_type, file_path, line_number, side, code_anchor, body, suggested_code,
     created_by_model_call_id, validated_schema_version, status, posted_at)
  values
    (v_ws, v_pr_review, v_rec5, v_job_prrev, v_ewa_cmt1, 'rc-1', 'opened', 'c14a77b',
     'pr14:external-action-executor:missing_latency_metric', 'rev-c14a77b-l52',
     'missing_latency_metric', 'functions/external-action-executor/index.ts', 52, 'RIGHT',
     'executeWrite()',
     'This provider write has no duration metric. A histogram around the call would make a slow provider write distinguishable from a hung executor.',
     'externalWriteDuration.observe(Date.now() - start);', null, 'pr_review_comment.v1', 'posted',
     '2026-06-06T13:12:50Z'),
    (v_ws, v_pr_review, v_rec5, v_job_prrev, v_ewa_cmt2, 'rc-2', 'opened', 'c14a77b',
     'pr14:external-action-executor:missing_error_metric', 'rev-c14a77b-l78',
     'missing_error_metric', 'functions/external-action-executor/index.ts', 78, 'RIGHT',
     'catch (err)',
     'The provider error path has no failure counter. A counter keyed by provider + error_code would let an alert catch a write regression before it shows up as incidents.',
     'externalWriteErrors.inc({ provider, code: err.code });', null, 'pr_review_comment.v1', 'posted',
     '2026-06-06T13:12:52Z'),
    (v_ws, v_pr_review, v_rec5, v_job_prrev, v_ewa_cmt3, 'rc-3', 'opened', 'c14a77b',
     'pr14:external-action-executor:missing_idempotency_log', 'rev-c14a77b-l96',
     'missing_idempotency_log', 'functions/external-action-executor/index.ts', 96, 'RIGHT',
     'skip duplicate',
     'When a write is skipped as a duplicate, nothing is logged. A structured log on the skip would make idempotency behavior auditable during an investigation.',
     null, null, 'pr_review_comment.v1', 'posted',
     '2026-06-06T13:12:54Z');

  -- ---- Evidence items (cited by the reliability investigation + accepted rec)
  insert into public.evidence_items
    (id, workspace_id, source_type, source_provider, collected_by_job_id, ai_model_call_id,
     subject_type, subject_id, claim_type, external_id, uri, title, summary, payload,
     content_hash, verification_state, observed_at, collected_at)
  values
    (v_ev_metric, v_ws, 'datadog_metric', 'datadog', v_job_inv1, v_mc1,
     'incident', v_inc1, 'fact', 'metric:instrument.job.retry',
     'https://us5.datadoghq.com/metric/explorer?query=instrument.job.retry',
     'Retry rate on job-worker-tick', '12.4/min vs 0.3 baseline at alert time',
     '{"series":"instrument.job.retry","by":"service:job-worker-tick","peak":12.4}'::jsonb,
     'h-metric-aa11', 'verified', '2026-06-06T14:22:00Z', '2026-06-06T14:23:10Z'),
    (v_ev_tfylog, v_ws, 'truefoundry_log', 'truefoundry', v_job_inv1, v_mc1,
     'incident', v_inc1, 'fact', 'tr-aa11', null,
     'TrueFoundry gateway 429 responses', '38% of model calls returned 429 over the 15m window',
     '{"trace_id":"tr-aa11","status_429_ratio":0.38,"model":"instrument/instrument"}'::jsonb,
     'h-tfylog-aa11', 'verified', '2026-06-06T14:21:30Z', '2026-06-06T14:23:12Z'),
    (v_ev_commit, v_ws, 'commit', 'github', v_job_inv1, v_mc1,
     'incident', v_inc1, 'counter_evidence', '9658c73',
     'https://github.com/pchen41/instrument/commit/9658c73',
     'Commit 9658c73', 'Raised the agent iteration limit; considered but not the cause',
     '{"sha":"9658c73","files":["services/truefoundry-mcp/server.py"]}'::jsonb,
     'h-commit-9658', 'verified', '2026-06-06T11:00:00Z', '2026-06-06T14:23:14Z'),
    (v_ev_ghdiff, v_ws, 'pr_diff', 'github', v_job_scan, null,
     'recommendation', v_rec6, 'suggested_action_support', 'pr:9',
     'https://github.com/pchen41/instrument/pull/9/files',
     'PR #9 diff', 'Adds a signature-failure counter to github-webhook',
     '{"pr":9,"additions":18,"files":["functions/github-webhook/index.ts"]}'::jsonb,
     'h-ghdiff-9', 'verified', '2026-06-06T09:30:00Z', '2026-06-06T09:31:00Z');

  -- ---- Telemetry emissions (the reliability retry signals) -----------------
  insert into public.telemetry_emissions
    (workspace_id, job_id, attempt_number, integration_id, metric_name, tags, value,
     truefoundry_trace_id, emission_state, idempotency_key, emitted_at)
  values
    (v_ws, v_job_inv1, 1, v_tf, 'instrument.job.retry',
     '{"service":"job-worker-tick","env":"production","workflow":"incident_investigation","integration":"truefoundry","error_code":"tfy_429"}'::jsonb,
     1, 'tr-aa11', 'succeeded', 'tel-jinv1-a1', '2026-06-06T14:22:52Z'),
    (v_ws, v_job_inv1, 2, v_tf, 'instrument.job.retry',
     '{"service":"job-worker-tick","env":"production","workflow":"incident_investigation","integration":"truefoundry","error_code":"tfy_429"}'::jsonb,
     1, 'tr-aa11', 'succeeded', 'tel-jinv1-a2', '2026-06-06T14:23:36Z'),
    (v_ws, v_job_inv5, 3, v_tf, 'instrument.job.failed',
     '{"service":"external-action-executor","env":"production","workflow":"incident_investigation","integration":"truefoundry","error_code":"mcp_503"}'::jsonb,
     1, null, 'succeeded', 'tel-jinv5-a3', '2026-06-06T14:23:20Z');

  raise notice 'Seeded % incidents, % recommendations, % PRs, % review comments.',
    (select count(*) from public.incidents where workspace_id = v_ws),
    (select count(*) from public.recommendations where workspace_id = v_ws),
    (select count(*) from public.github_pull_requests where workspace_id = v_ws),
    (select count(*) from public.pr_review_comments where workspace_id = v_ws);
end $$;
