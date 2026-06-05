# Instrument PRD

## 1. Product Summary

Instrument is an AI SRE for software teams. It reads a team's codebase, GitHub activity, and observability signals to find gaps in instrumentation, suggest better alerts, and help on-call engineers investigate incidents.

Instrument does not replace Datadog, GitHub, or TrueFoundry. It connects those systems, adds code-aware reasoning, and presents actionable, evidence-backed recommendations in a web console.

The product has three primary surfaces:

- **Incidents**: Datadog alerts become incidents that Instrument can investigate using codebase context, recent commits, Datadog logs/traces/metrics, and TrueFoundry MCP/LLM logs.
- **Recommendations**: Instrument proactively suggests observability improvements, including missing metrics, missing logs, missing spans, dashboard gaps, and Datadog monitor improvements.
- **Integrations**: Users connect GitHub, Datadog, and TrueFoundry and can see each source's connection state.

The design reference is in `design/README.md` and the console prototype is under `design/project/console/`.

## 2. Goals

- Help teams improve observability before incidents happen.
- Reduce incident triage time by correlating alerts with code changes and operational signals.
- Make AI conclusions trustworthy by grounding every recommendation and investigation in specific evidence.
- Keep humans in control of configuration changes, generated PRs, and incident fixes. GitHub PR review comments are automatic in MVP, but must be scoped, deduplicated, and auditable.
- Provide a polished web console with durable progress, retry, and refresh behavior that does not depend on the user's browser session.

## 3. Non-Goals

- Instrument will not replace Datadog as the source of truth for monitor state, alert state, logs, metrics, or traces.
- Instrument will not replace GitHub as the source of truth for code, commits, pull requests, branches, comments, or review state.
- Instrument will not guarantee a single definitive root cause for every incident. It should present ranked hypotheses with evidence and confidence.
- MVP will not automatically merge code, apply production monitor changes, or mutate customer systems without explicit human approval, except for posting scoped GitHub PR review comments as part of the PR observability review workflow.
- MVP will not implement the full database ERD in this PRD. An ERD will be created separately.

## 4. Users and Personas

### 4.1 On-call Engineer

The on-call engineer responds to alerts and needs fast, trustworthy incident context. They use Instrument to see active incidents, start or view investigations, inspect evidence, and, in stretch functionality, generate a fix PR once Instrument has a credible root-cause hypothesis.

### 4.2 Platform/SRE Owner

The platform or SRE owner is responsible for improving observability quality across services. They use Instrument to review recommendations, accept or dismiss suggestions, and identify missing metrics, logs, spans, dashboard panels, or Datadog alerts.

### 4.3 Application Engineer

The application engineer owns service code and pull requests. They receive GitHub PR comments from Instrument when a code change introduces or exposes an observability gap.

## 5. Supported Integrations

### 5.1 GitHub

Instrument uses GitHub to:

- Read repositories, files, branches, commits, pull requests, diffs, and PR metadata.
- Detect recent deploy-related commits or changes relevant to an incident.
- Leave observability review comments on pull requests.
- Track whether generated or suggested PRs are opened, merged, closed, or stale.
- Stretch: create branches and pull requests for approved observability improvements or incident fixes.

GitHub write actions must be explicit and auditable. Posting inline PR review comments is automatic for the PR review workflow. Creating branches and PRs is stretch functionality and must be gated by user approval.

### 5.2 Datadog

Instrument uses Datadog to:

- Receive alert webhooks.
- Read monitors, monitor configuration, alert status, service metadata, logs, traces, metrics, and dashboards where available.
- Suggest new monitors when important emitted metrics are not alerting.
- Suggest improvements to existing monitors, such as threshold changes, missing tags, missing runbooks, noisy alerts, or missing notifications.
- Stretch: apply approved Datadog monitor changes after human review.

Datadog remains the source of truth for monitor and alert state. Instrument must avoid suggesting alerts for metrics that it cannot verify exist or can be emitted by the code path.

### 5.3 TrueFoundry

Instrument uses TrueFoundry to:

- Read MCP and LLM-related logs.
- Correlate AI application failures, degraded model calls, tool failures, latency, and cost anomalies with incidents and recommendations.
- Surface TrueFoundry as a connected source in the console.

TrueFoundry is an observability signal source, not the primary incident source for MVP unless explicitly configured later. Incident correlation should use available service names, trace IDs, request IDs, deployment timestamps, model names, tool names, and time windows from the incident.

## 6. Core Workflows

### 6.1 GitHub PR Observability Review

When a GitHub pull request is opened or updated, Instrument analyzes the diff and relevant surrounding code to determine whether the change introduces an observability gap. MVP should handle pull request opened, reopened, synchronize, and ready-for-review events on connected repositories.

Examples:

- A new API endpoint lacks latency metrics, error counters, or structured logs.
- A new queueing path lacks queue depth metrics.
- A new external service call lacks trace spans or failure metrics.
- A changed logging statement removes useful incident context.

Requirements:

- **PR-1**: Instrument must analyze changed files and relevant neighboring code before commenting.
- **PR-2**: Instrument must only leave comments when it finds a specific, actionable observability issue.
- **PR-3**: Every PR comment must cite the changed file and line where the suggestion applies.
- **PR-4**: PR comments must be concise, specific, and framed as review feedback, not generic observability advice.
- **PR-5**: Instrument must deduplicate comments so it does not repeatedly post the same suggestion on the same PR revision.
- **PR-6**: When a new PR revision still has the same unresolved gap, Instrument should avoid posting a duplicate comment unless the applicable file, line, or suggested fix materially changed.
- **PR-7**: The console must show a record of PR review recommendations, including PR number, title, author, branch, comment count, comment details, and code locations.

### 6.2 Proactive Observability Recommendations

Instrument scans connected repositories and observability data to find gaps before they become incidents. MVP should support both a manual scan trigger and a scheduled scan. The initial scheduled cadence may be implementation-defined, but scan results must record the repository/service scope, trigger source, start time, completion time, and whether the result is stale.

Examples:

- A critical code path emits no metrics.
- A service logs failures as unstructured strings that cannot be grouped by cause.
- A trace has a meaningful gap where a span should exist.
- A dashboard depends on log fields that are not emitted yet.
- A recommendation requires multiple dependent steps, such as adding a metric first and creating an alert after the metric exists.

Requirements:

- **REC-1**: Instrument must produce recommendations with a title, category, rationale, evidence, affected service or code path, and proposed next step.
- **REC-2**: Recommendation categories must include at least `Instrumentation`, `Alert`, and `PR review`.
- **REC-3**: Recommendations must include one or more ordered steps when the work is dependent.
- **REC-4**: Dependent steps must remain locked until their prerequisite step is complete.
- **REC-5**: Recommendations must have lifecycle states: `active`, `accepted`, `dismissed`, and `outdated`.
- **REC-6**: Dismissed recommendations must be restorable unless they are outdated.
- **REC-7**: Outdated recommendations must explain why they no longer apply.
- **REC-8**: Instrument must deduplicate recommendations across scans so stable findings do not reappear as new items.
- **REC-9**: Users must be able to view active recommendations and archived recommendations separately.
- **REC-10**: A recommendation becomes `accepted` only when all required steps are completed, such as a PR being merged, a monitor change being applied, or a user marking a non-mutating step complete.
- **REC-11**: If a previously accepted or dismissed recommendation becomes invalid because code or monitor context changed, Instrument may mark it `outdated` and must preserve the prior lifecycle history.

### 6.3 Datadog Alert Recommendations

Instrument compares codebase context, emitted metrics, existing Datadog monitors, alert history, and service criticality to suggest alert improvements.

Examples:

- A service emits an important metric, but no monitor exists.
- A monitor threshold is too sensitive and creates alert fatigue.
- A monitor lacks tags, ownership, service scope, notification routing, or a runbook.
- A metric was added by a recent recommendation and should now receive an alert.

Requirements:

- **ALERT-1**: Instrument must verify that a suggested metric exists in Datadog or is expected to exist only because a completed prerequisite instrumentation step added it.
- **ALERT-2**: Instrument must distinguish between creating a new monitor and improving an existing monitor.
- **ALERT-3**: Monitor improvement recommendations must show the proposed change as a reviewable configuration diff.
- **ALERT-4**: Instrument must not apply Datadog monitor changes without explicit human approval.
- **ALERT-5**: Alert recommendations must cite relevant monitor configuration, metric evidence, alert history, or code paths.

### 6.4 Datadog Alert Ingestion and Incident Investigation

When Datadog sends an alert webhook, Instrument creates or updates an incident. In MVP, an active incident waits for a human to press `Investigate`, matching the design prototype. Automatic investigation may be added later as a configurable behavior.

Investigation inputs include:

- Datadog alert payload and monitor configuration.
- Datadog logs, traces, metrics, service tags, and dashboards.
- GitHub commits, pull requests, files, diffs, and recent deploy-related changes.
- TrueFoundry MCP/LLM logs when relevant.
- Previous recommendations or related incidents.

Requirements:

- **INC-1**: A Datadog alert webhook must create a new incident or update an existing grouped incident.
- **INC-2**: Incident grouping must avoid one Datadog alert storm creating many duplicate incidents. Before root cause is known, grouping should use monitor ID, service, environment, alert scope/tags, alert transition, and a bounded time window.
- **INC-3**: An incident must track alert state, incident state, service, title, description, source, start time, key signals, investigation state, timeline, and evidence.
- **INC-4**: Investigation display states must include `new`, `investigating`, `complete`, and `failed`. These display states are derived from the durable job state: no job maps to `new`, `queued`/`running`/`retrying` maps to `investigating`, `succeeded` maps to `complete`, and terminal `failed` maps to `failed`.
- **INC-5**: Investigation output must present ranked hypotheses, not only a single answer.
- **INC-6**: A hypothesis must include evidence references, confidence, and reasoning.
- **INC-7**: Confidence levels must use stable bands: `High`, `Likely`, and `Low`. The UI may label the leading hypothesis as `Root cause` only for `High`; otherwise it should label it as `Leading hypothesis`.
- **INC-8**: If the root cause is outside the codebase or not fixable by Instrument, the investigation must explain why no code fix can be generated and suggest a next step.
- **INC-9**: Resolved incidents must remain visible in a resolved/archive view with their final findings.
- **INC-10**: Users must be able to rerun an investigation when new commits, logs, traces, metrics, or alert state changes may affect the finding. Reruns create a new durable job linked to the same incident and retain prior findings in history.

### 6.5 Web Console

The console must match the intent of the design files and provide a polished, reliable product experience.

Required views:

- **Incidents**: Active and resolved incident lists; incident detail; investigation progress; hypotheses; key signals; timeline; correlated code changes; stretch fix generation state where available.
- **Recommendations**: Active and archived recommendations; multi-step recommendation progress; PR review records; configuration change drawers; stretch generated PR drawers.
- **Integrations**: GitHub, Datadog, and TrueFoundry connection state.

Requirements:

- **UI-1**: The console must show server-backed state. Refreshing the browser must not reset job progress, retry state, investigation state, recommendation state, or generated output.
- **UI-2**: Long-running work must show named progress phases rather than an opaque spinner.
- **UI-3**: Retryable API failures must be visible to the user with clear status text while the backend retries.
- **UI-4**: Failed jobs must preserve completed progress and show a clear failure state with the affected integration.
- **UI-5**: If incidents, recommendations, PR review records, integration state, job state, or generated PR state changes while the user is viewing related content, the console must inform the user and provide a refresh action.
- **UI-6**: Refreshing content must not create duplicate jobs unless the user explicitly requests a new investigation or regeneration.
- **UI-7**: The console must gracefully handle missing integrations, expired credentials, rate limits, partial data, and network/API failures.
- **UI-8**: All destructive or externally mutating actions must require explicit confirmation.
- **UI-9**: Terminal failed jobs must expose a manual retry action when retrying is safe and idempotent.

## 7. Durable Job and Progress Requirements

Instrument's core workflows are long-running and must be executed by durable backend jobs, not browser-local state.

Job examples:

- PR review analysis.
- Proactive codebase scan.
- Recommendation generation.
- Datadog monitor analysis.
- Incident investigation.
- Fix or PR generation.

Requirements:

- **JOB-1**: Jobs must persist state so they survive browser refreshes, user navigation, backend restarts, and transient integration failures.
- **JOB-2**: Jobs must expose progress phases suitable for the console, such as reading code, pulling traces, scanning logs, correlating commits, ranking hypotheses, drafting changes, running checks, and opening PRs.
- **JOB-3**: Job states must include at least `queued`, `running`, `retrying`, `failed`, `succeeded`, and `cancelled` where cancellation is supported.
- **JOB-4**: Retryable external API failures must use bounded retries with backoff.
- **JOB-5**: Jobs must be idempotent where practical, especially for webhook handling, PR comments, and generated recommendations.
- **JOB-6**: Jobs must record enough audit information to explain what sources were consulted and what actions were taken.
- **JOB-7**: The UI must be able to resume displaying a job from persisted state without re-running the job.
- **JOB-8**: Jobs must record source data versions or timestamps where available so refresh and rerun behavior can distinguish fresh server state from new analysis.

## 8. Evidence, Confidence, and AI Output Requirements

AI-generated output must be structured, grounded, and reviewable.

Requirements:

- **AI-1**: Every recommendation and incident finding must include evidence references.
- **AI-2**: Evidence references may include code file/line, PR diff, commit, Datadog monitor, metric, log query, trace, dashboard, alert event, or TrueFoundry log.
- **AI-3**: Instrument must not cite evidence that cannot be verified by the system.
- **AI-4**: Instrument must include confidence for incident hypotheses and may include confidence for recommendations.
- **AI-5**: Instrument must avoid claiming certainty when evidence is incomplete, contradictory, stale, or unavailable.
- **AI-6**: Instrument must distinguish between verified facts, inferred hypotheses, and suggested actions.
- **AI-7**: AI output must validate against structured schemas before being shown in the console or posted externally.

## 9. Permissions, Security, and Auditability

Requirements:

- **SEC-1**: Integration credentials must be stored securely and must not be logged in raw form.
- **SEC-2**: Instrument must request the least practical permissions for GitHub, Datadog, and TrueFoundry.
- **SEC-3**: External write actions must be auditable, including actor, timestamp, target system, action type, and payload summary.
- **SEC-4**: Human approval must be required before applying monitor changes, generating stretch PRs, or generating incident fix PRs.
- **SEC-5**: Posted PR comments must be traceable back to the Instrument analysis that produced them.
- **SEC-6**: Users must be able to see when an integration is disconnected, degraded, or missing required permissions.
- **SEC-7**: Inbound Datadog webhooks must be authenticated or signature-verified before they can create or update incidents.
- **SEC-8**: The console must require authenticated users and must scope visible repositories, incidents, recommendations, jobs, and integrations to the user's organization or workspace.

## 10. Notifications and Refresh Behavior

Requirements:

- **NOTIFY-1**: When a new incident arrives while a user is on an incident list page, the console must show that new content is available and offer a refresh action.
- **NOTIFY-2**: When recommendations are added, changed, accepted, dismissed, or outdated while a user is on the recommendations page, the console must show that content changed and offer a refresh action.
- **NOTIFY-3**: In-console notifications must be debounced to avoid noisy repeated prompts during alert storms or batch scans.
- **NOTIFY-4**: Refreshing the current view must fetch server state and must not clear in-progress job state.
- **NOTIFY-5**: The PRD does not require external notifications such as Slack, email, or PagerDuty for MVP.
- **NOTIFY-6**: The implementation may use polling, realtime events, or version stamps for change detection, but the server must expose enough version information for the console to know when its current view is stale.

## 11. MVP Scope

The MVP must include:

- GitHub integration for reading repositories, commits, PRs, and diffs.
- GitHub PR observability review comments.
- Datadog integration for receiving alert webhooks and reading monitor/log/trace/metric context.
- TrueFoundry integration for reading MCP/LLM logs.
- Incident creation, grouping, investigation, evidence display, and resolved incident history.
- Proactive recommendations for instrumentation and Datadog monitor improvements.
- Recommendations archive with accepted, dismissed, and outdated states.
- Durable job state for long-running work and retries.
- Console views for Incidents, Recommendations, and Integrations.
- In-console change notifications and refresh behavior.

## 12. Stretch Scope

Stretch functionality includes:

- Generate GitHub PRs for approved observability improvement recommendations.
- Generate GitHub PRs for incident fixes after an investigation produces a fixable root-cause hypothesis.
- Apply approved Datadog monitor changes from the console.
- More advanced feedback loops where accepted/dismissed recommendations influence future ranking.
- External notifications to Slack, PagerDuty, or email.

Stretch functionality must preserve human approval, auditability, and evidence requirements. Generated PRs must show a preview before creation, identify target repository and branch, cite the evidence that motivated the change, report any checks run, and track whether the PR is open, merged, closed, or stale.

## 13. Acceptance Criteria

### 13.1 GitHub PR Review

- Given a GitHub PR that adds a new code path with no relevant logging, metric, or span, Instrument posts at least one specific review comment that cites the file and line.
- Given a GitHub PR with no meaningful observability gap, Instrument posts no comments.
- Given the same PR revision is analyzed twice, Instrument does not duplicate comments.
- Given a PR review recommendation is shown in the console, the user can view PR number, title, author, branch, comments, and code locations.
- Given a pull request receives a new revision with the same unresolved observability gap at the same code location, Instrument does not post a duplicate comment.

### 13.2 Recommendations

- Given a codebase scan finds a service queue with no depth metric, Instrument creates an active recommendation citing the code path and explaining why the missing metric matters.
- Given a recommendation requires a metric before an alert, the alert step remains locked until the metric step is marked complete.
- Given a user dismisses a recommendation, it moves to the archive and can be restored unless it is outdated.
- Given code changes remove the affected code path, Instrument marks the recommendation outdated and explains why.
- Given a scheduled or manual scan runs, Instrument records scan scope, trigger, start time, completion time, and stale/fresh status.

### 13.3 Datadog Alert Recommendations

- Given an existing emitted metric with no monitor, Instrument suggests a new Datadog alert and cites metric/code evidence.
- Given a noisy Datadog monitor, Instrument suggests a specific threshold or configuration improvement and shows the proposed configuration diff.
- Given a metric cannot be verified, Instrument does not recommend a Datadog alert for it unless the recommendation explicitly depends on first adding that metric.

### 13.4 Incidents

- Given a Datadog alert webhook, Instrument creates or updates one grouped incident and shows it in the active incident list.
- Given multiple related Datadog webhooks for the same service and root problem, Instrument groups them rather than creating duplicate incidents.
- Given an investigation starts, the console shows persisted progress phases and still shows them after browser refresh.
- Given Datadog logs API returns a retryable failure, the job enters a retrying state, preserves completed phases, and shows the retry note in the console.
- Given an investigation completes, the incident detail shows ranked hypotheses, confidence, evidence, key signals, and timeline.
- Given the root cause is upstream or otherwise not fixable through code, Instrument explains that no code fix can be generated and suggests a next step.
- Given TrueFoundry logs contain an LLM/tool failure correlated by service, request ID, trace ID, or incident time window, Instrument can cite those logs as evidence in a hypothesis.
- Given an investigation job reaches a terminal failed state, the console shows the failure and provides a manual retry action when the job is safe to retry.

### 13.5 Console Reliability

- Given a user refreshes the browser during a running job, the job state and progress are restored from the server.
- Given a new incident arrives while the user is viewing the incident list, the console indicates new content is available and provides a refresh action.
- Given an integration is disconnected or missing permissions, the console communicates the degraded state and avoids pretending analysis is complete.
- Given an external write action is requested, the console asks for confirmation before taking the action.
- Given the backend restarts during a running job, the console can recover persisted job state after the backend is available again.

## 14. Open Questions

- What deployment signal should Instrument use first when correlating incidents with recent code changes: GitHub commit history, deployment events from Datadog, or another source?
- Which Datadog data scopes are required for the first implementation: monitors only, or monitors plus logs, metrics, traces, and dashboards?
- How should users configure service ownership, criticality, and notification routing for recommendations and incidents?
