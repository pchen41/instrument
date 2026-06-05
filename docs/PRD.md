# Instrument PRD

## 1. Product Summary

Instrument is an AI SRE for software teams. It reads a team's codebase, GitHub activity, and observability signals to find gaps in instrumentation, suggest better alerts, and help on-call engineers investigate incidents.

Instrument does not replace Datadog, GitHub, or TrueFoundry. It connects those systems, adds code-aware reasoning, and presents actionable, evidence-backed recommendations in a web console.

The product has three primary surfaces:

- **Incidents**: Datadog alerts become incidents that Instrument can investigate using codebase context, recent commits, Datadog monitors/logs/metrics, and TrueFoundry MCP/LLM logs.
- **Recommendations**: Instrument proactively suggests observability improvements, including missing metrics, missing logs, missing spans, dashboard gaps, and Datadog monitor improvements.
- **Integrations**: Users connect GitHub, Datadog, and TrueFoundry and can see each source's connection state.

## 2. Design Reference and Scope Notes

The design reference is in `design/README.md`. The console prototype is under `design/project/console/`; the auth prototype is under `design/project/auth.jsx`.

The console prototype is a visual reference and represents the target product direction, not a strict MVP contract. Implementation should match the design intent for MVP surfaces where practical, but may deviate to satisfy this PRD, remove stretch-only actions, add missing required states, or handle backend constraints. Any meaningful design deviation should be documented.

Prototype comments may clarify product intent, but this PRD is the source of truth for MVP scope. Generated recommendation PRs, generated incident-fix PRs, and applied Datadog monitor changes appear in the target-state prototype but are stretch scope unless explicitly promoted later.

The auth prototype is visual reference only for now. Auth requirements in this PRD are limited to the security requirements in Section 10.

The console design must add a failed job/investigation state consistent with the existing activity and progress patterns. The current prototype shows `new`, `investigating`, and `complete`; MVP must also show `failed` with preserved progress, affected integration/source, error context, and a safe retry action when retry is supported.

## 3. Goals

- Help teams improve observability before incidents happen.
- Reduce incident triage time by correlating alerts with code changes and operational signals.
- Make AI conclusions trustworthy by grounding every recommendation and investigation in specific evidence.
- Keep humans in control of generated PRs, incident fixes, and applied configuration changes.
- Automatically post scoped, deduplicated, auditable GitHub PR observability review comments in MVP.
- Provide a polished web console with durable progress, retry, and refresh behavior that does not depend on the user's browser session.

## 4. Non-Goals

- Instrument will not replace Datadog as the source of truth for monitor state, alert state, logs, metrics, or traces.
- Instrument will not replace GitHub as the source of truth for code, commits, pull requests, branches, comments, or review state.
- Instrument will not guarantee a single definitive root cause for every incident. It should present ranked hypotheses with evidence and confidence. A single hypothesis is acceptable when no credible alternatives exist.
- MVP will not automatically merge code, apply production monitor changes, generate incident fix PRs, or otherwise mutate customer systems without explicit human approval, except for automatic GitHub PR observability review comments.
- Incident investigations are read-only even when they start automatically.

## 5. Users and Personas

### 5.1 On-call Engineer

The on-call engineer responds to alerts and needs fast, trustworthy incident context. They use Instrument to see active incidents, start or view investigations, inspect evidence, and, in stretch functionality, generate a fix PR once Instrument has a credible root-cause hypothesis.

### 5.2 Platform/SRE Owner

The platform or SRE owner is responsible for improving observability quality across services. They use Instrument to review recommendations, accept or dismiss suggestions, and identify missing metrics, logs, spans, dashboard panels, or Datadog alerts.

### 5.3 Application Engineer

The application engineer owns service code and pull requests. They receive automatic GitHub PR comments from Instrument when a code change introduces or exposes a specific observability gap.

## 6. Supported Integrations

### 6.1 GitHub

Instrument uses GitHub to:

- Read repositories, files, branches, commits, pull requests, diffs, and PR metadata.
- Detect recent deploy-related commits or changes relevant to an incident. GitHub commit history is the first deploy-correlation source for MVP; deployment events from other systems may be used later as supplemental evidence.
- Automatically leave scoped observability review comments on pull requests.
- Track PR review activity and posted observability comments.
- Stretch: create branches and pull requests for approved observability improvements or incident fixes, then track whether those PRs are opened, merged, closed, or stale.

Automatic PR observability review comments are an explicit exception to the general human-approval rule for external writes. They must still be scoped, deduplicated, auditable, and limited to connected repositories where the workflow is enabled. Creating branches or PRs remains stretch functionality and must be gated by user approval.

### 6.2 Datadog

Instrument uses Datadog to:

- Receive alert webhooks.
- Read monitors, monitor configuration, alert status, logs, metrics, and Datadog service metadata where available.
- Read service ownership, criticality, and notification routing only when those fields exist in Datadog.
- Suggest new monitors when important emitted metrics are not alerting.
- Suggest improvements to existing monitors, such as threshold changes, missing tags, missing runbooks, noisy alerts, or missing notifications.
- Stretch: apply approved Datadog monitor changes after human review.

Datadog remains the source of truth for monitor and alert state. Instrument must avoid suggesting alerts for metrics that it cannot verify exist or can be emitted by the relevant code path. Datadog traces and dashboards may be used when available, but monitors, logs, and metrics are the required Datadog scopes for the first implementation.

### 6.3 TrueFoundry

Instrument uses TrueFoundry to:

- Read MCP and LLM-related logs.
- Correlate AI application failures, degraded model calls, tool failures, latency, and cost anomalies with incidents and recommendations.

TrueFoundry is an observability signal source, not the primary incident source for MVP unless explicitly configured later. Incident correlation should use available service names, trace IDs, request IDs, deployment timestamps, model names, tool names, and time windows from the incident.

## 7. Core Workflows

### 7.1 GitHub PR Observability Review

When a connected GitHub pull request is opened or updated, Instrument analyzes the diff and relevant surrounding code. If the change introduces a specific observability gap, Instrument automatically posts concise review comments on the PR.

MVP should handle pull request opened, reopened, synchronize, and ready-for-review events.

Examples:

- A new API endpoint lacks latency metrics, error counters, or structured logs.
- A new queueing path lacks queue depth metrics.
- A new external service call lacks trace spans or failure metrics.
- A changed logging statement removes useful incident context.

Requirements:

- **PR-1**: Instrument must analyze changed files and relevant neighboring code before commenting.
- **PR-2**: Instrument must only comment on specific, actionable observability issues.
- **PR-3**: Every PR comment must cite the changed file and line where the suggestion applies.
- **PR-4**: PR comments must be concise, specific, and framed as review feedback, not generic observability advice.
- **PR-5**: Instrument must deduplicate comments so it does not repeatedly post the same suggestion on the same PR revision.
- **PR-6**: When a new PR revision still has the same unresolved gap, Instrument should avoid posting a duplicate comment unless the applicable file, line, or suggested fix materially changed.
- **PR-7**: The console must show a record of PR review recommendations, including PR number, title, author, branch, comment count, comment details, and code locations.

### 7.2 Proactive Observability Recommendations

Instrument scans connected repositories and observability data to find gaps before they become incidents. MVP includes automatic scans; the trigger and cadence may be implementation-defined. Manual scan triggering is not required for MVP.

Scan results must record repository/service scope, trigger source, start time, completion time, and freshness/staleness.

Examples:

- A critical code path emits no metrics.
- A service logs failures as unstructured strings that cannot be grouped by cause.
- A trace has a meaningful gap where a span should exist.
- A dashboard depends on log fields that are not emitted yet.
- A recommendation requires multiple dependent steps, such as adding a metric first and creating an alert after the metric exists.

Requirements:

- **REC-1**: Instrument must produce recommendations with a title, category, rationale, evidence, affected service or code path, and proposed next step.
- **REC-2**: Recommendation categories must include at least `Instrumentation`, `Alert`, and `PR review`.
- **REC-3**: Recommendations must include ordered steps when work is dependent.
- **REC-4**: Dependent steps must remain locked until their prerequisite step is complete.
- **REC-5**: Recommendations must have lifecycle states: `active`, `accepted`, `dismissed`, and `outdated`.
- **REC-6**: Dismissed recommendations must be restorable unless they are outdated.
- **REC-7**: Outdated recommendations must explain why they no longer apply.
- **REC-8**: Instrument must deduplicate recommendations across scans so stable findings do not reappear as new items.
- **REC-9**: Users must be able to view active recommendations and archived recommendations separately.
- **REC-10**: A recommendation becomes `accepted` only when all required steps are completed, such as a PR being merged, a monitor change being applied, or a user marking a non-mutating step complete.
- **REC-11**: If a previously accepted or dismissed recommendation becomes invalid because code or monitor context changed, Instrument may mark it `outdated` and must preserve prior lifecycle history.

### 7.3 Datadog Alert Recommendations

Instrument compares codebase context, emitted metrics, existing Datadog monitors, alert history, and Datadog-provided service metadata to suggest alert improvements.

Examples:

- A service emits an important metric, but no monitor exists.
- A monitor threshold is too sensitive and creates alert fatigue.
- A monitor lacks tags, Datadog-provided ownership, service scope, notification routing, or a runbook.

Requirements:

- **ALERT-1**: Instrument must verify that a suggested metric exists in Datadog or is expected to exist only because a completed prerequisite instrumentation step added it.
- **ALERT-2**: Instrument must distinguish between creating a new monitor and improving an existing monitor.
- **ALERT-3**: Monitor improvement recommendations must show the proposed change as a reviewable configuration diff.
- **ALERT-4**: Instrument must not apply Datadog monitor changes without explicit human approval.
- **ALERT-5**: Alert recommendations must cite relevant monitor configuration, metric evidence, alert history, or code paths.
- **ALERT-6**: Service ownership, criticality, and notification routing must be read from Datadog when available. When this metadata is absent, Instrument must not fabricate it, require it, or block recommendations on it.

### 7.4 Datadog Alert Ingestion and Incident Investigation

When Datadog sends an alert webhook, Instrument creates or updates a grouped incident. Whether the investigation starts automatically is governed by a workspace-level **investigation-start setting**. The default is `manual`, matching the current console prototype.

Investigation inputs include:

- Datadog alert payload and monitor configuration.
- Datadog logs, metrics, service tags, and available Datadog service metadata.
- GitHub commits, pull requests, files, diffs, and recent deploy-related changes.
- TrueFoundry MCP/LLM logs when relevant.

Requirements:

- **INC-1**: A Datadog alert webhook must create a new incident or update an existing grouped incident.
- **INC-2**: Incident grouping must avoid one Datadog alert storm creating many duplicate incidents. Before root cause is known, grouping should use monitor ID, service, environment, alert scope/tags, alert transition, and a bounded time window.
- **INC-3**: An incident must track alert state, incident state, service, title, description, source, start time, key signals, investigation state, timeline, and evidence.
- **INC-4**: Investigation display states must include `new`, `investigating`, `complete`, and `failed`, mapped from durable job state as defined in Section 8.
- **INC-5**: Investigation output must present ranked hypotheses when appropriate. If there is an obvious root cause, multiple hypotheses are not necessary.
- **INC-6**: A hypothesis must include evidence references, confidence, and reasoning.
- **INC-7**: Confidence levels must use stable bands: `High`, `Likely`, and `Low`. The UI may label the leading hypothesis as `Root cause` only for `High`; otherwise it should label it as `Leading hypothesis`.
- **INC-8**: If the root cause is outside the codebase or not fixable by Instrument, the investigation must explain why no code fix can be generated and suggest a next step.
- **INC-9**: Resolved incidents must remain visible in a resolved/archive view with their final findings.
- **INC-10**: A workspace-level investigation-start setting must offer three modes: `manual` (default), `auto`/Automatic, and `smart`/Let Instrument decide. Changing the setting must not disturb investigations already in flight.
- **INC-11**: In `manual` mode, every investigation waits for a human to press Investigate.
- **INC-12**: In `auto` mode, Instrument starts investigating every firing alert as it arrives.
- **INC-13**: In `smart` mode, Instrument starts on its own for important, clear-cut alerts and waits for a human when the situation is ambiguous.
- **INC-14**: Any investigation that began without a human must be visibly marked in both the incident list and incident detail, for example with a "Started automatically" badge.
- **INC-15**: Investigations must be read-only and must never auto-generate or apply a fix. Fix generation stays human-initiated and stretch scope under every investigation-start setting.

## 8. Durable Jobs, Progress, and Live Updates

Instrument's core workflows are long-running and must be executed by durable backend jobs, not browser-local state.

Job examples include PR review analysis, proactive scans, recommendation generation, Datadog monitor analysis, incident investigation, and stretch fix/PR generation.

Requirements:

- **JOB-1**: Jobs must persist state so they survive browser refreshes, user navigation, backend restarts, and transient integration failures.
- **JOB-2**: Job states must include at least `queued`, `running`, `retrying`, `failed`, `succeeded`, and `cancelled` where cancellation is supported.
- **JOB-3**: Investigation display states derive from job state: no job maps to `new`; `queued`, `running`, and `retrying` map to `investigating`; `succeeded` maps to `complete`; terminal `failed` maps to `failed`.
- **JOB-4**: Jobs must expose named progress phases suitable for the console, such as reading code, pulling observability signals, scanning logs, correlating commits, ranking hypotheses, drafting changes, running checks, and opening PRs.
- **JOB-5**: Retryable external API failures must use bounded retries with backoff and visible retry notes.
- **JOB-6**: Failed jobs must preserve completed progress, show a clear failure state with the affected integration/source, and expose manual retry when retry is safe and idempotent.
- **JOB-7**: Jobs must be idempotent where practical, especially for webhook handling, PR comments, and generated recommendations.
- **JOB-8**: Jobs must record enough audit information to explain what sources were consulted and what actions were taken.
- **JOB-9**: The UI must be able to resume displaying a job from persisted state without re-running the job.
- **JOB-10**: The server must expose current job progress, retry notes, completion, and failure state in a form the console can poll or subscribe to.
- **JOB-11**: While a user is viewing related content, the console must update visible incident, recommendation, PR review, integration, and job state automatically where practical. Where automatic replacement would be disruptive, it may show that content changed and provide a refresh action.
- **JOB-12**: Refreshing content must not create duplicate jobs unless the user explicitly requests a new investigation or regeneration.
- **JOB-13**: In-console change notifications must be debounced to avoid noisy repeated prompts during alert storms or batch scans.
- **JOB-14**: The PRD does not require external notifications such as Slack, email, or PagerDuty for MVP.

## 9. Evidence, Confidence, and AI Output

AI-generated output must be structured, grounded, and reviewable.

Requirements:

- **AI-1**: Every recommendation and incident finding must include evidence references.
- **AI-2**: Evidence references may include code file/line, PR diff, commit, Datadog monitor, metric, log query, trace, dashboard, alert event, or TrueFoundry log.
- **AI-3**: Instrument must not cite evidence that cannot be verified by the system.
- **AI-4**: Instrument must include confidence for incident hypotheses and may include confidence for recommendations.
- **AI-5**: Instrument must avoid claiming certainty when evidence is incomplete, contradictory, stale, or unavailable.
- **AI-6**: Instrument must distinguish between verified facts, inferred hypotheses, and suggested actions.
- **AI-7**: AI output must validate against structured schemas before being shown in the console or posted externally.

## 10. Permissions, Security, and Auditability

Requirements:

- **SEC-1**: Integration credentials must be stored securely and must not be logged in raw form.
- **SEC-2**: Instrument must request the least practical permissions for GitHub, Datadog, and TrueFoundry.
- **SEC-3**: Human approval must be required before applying monitor changes, generating PRs, or generating incident fix PRs.
- **SEC-4**: Automatic GitHub PR observability review comments do not require per-comment human approval, but must be scoped, deduplicated, auditable, and limited to repositories/workspaces where the workflow is enabled.
- **SEC-5**: Users must be able to see when an integration is disconnected, degraded, or missing required permissions.
- **SEC-6**: Inbound Datadog webhooks must be authenticated or signature-verified before they can create or update incidents.
- **SEC-7**: The console must require authenticated users and must scope visible repositories, incidents, recommendations, jobs, and integrations to the user's organization or workspace.

## 11. Web Console

Required views:

- **Incidents**: Active and resolved incident lists; investigation-start setting control; incident detail; investigation progress; failed investigation state; hypotheses; key signals; timeline; correlated code changes; stretch fix generation state where available.
- **Recommendations**: Active and archived recommendations; multi-step recommendation progress; PR review records; configuration change drawers; stretch generated PR drawers where available.
- **Integrations**: GitHub, Datadog, and TrueFoundry connection state.

Requirements:

- **UI-1**: The console must show server-backed state and resume from persisted state after browser refresh.
- **UI-2**: Long-running work must show named progress phases rather than an opaque spinner.
- **UI-3**: The console must gracefully handle missing integrations, expired credentials, rate limits, partial data, and network/API failures.
- **UI-4**: Destructive or externally mutating actions must require explicit confirmation, except for automatic GitHub PR observability review comments as defined in Sections 6.1 and 10.
- **UI-5**: The incident list view must expose the investigation-start setting with the three labels shown in the design: Manual, Automatic, and Let Instrument decide.

## 12. MVP Scope

The MVP must include:

- GitHub integration for reading repositories, commits, PRs, and diffs.
- Automatic GitHub PR observability review comments.
- Datadog integration for receiving alert webhooks and reading monitor/log/metric context. Traces and dashboards are deferred past the first implementation.
- TrueFoundry integration for reading MCP/LLM logs.
- Incident creation, grouping, investigation, evidence display, and resolved incident history.
- Investigation-start setting (`manual`/`auto`/`smart`) with auto-started badges.
- Failed investigation state and safe retry behavior.
- Proactive automatic recommendations for instrumentation and Datadog monitor improvements.
- Recommendations archive with accepted, dismissed, and outdated states.
- Durable job state for long-running work, retries, live updates, and refresh recovery.
- Console views for Incidents, Recommendations, and Integrations.

## 13. Stretch Scope

Stretch functionality includes:

- Generate GitHub PRs for approved observability improvement recommendations.
- Generate GitHub PRs for incident fixes after an investigation produces a fixable root-cause hypothesis.
- Apply approved Datadog monitor changes from the console.
- Manual/on-demand recommendation scans.

## 14. Acceptance Criteria

### 14.1 GitHub PR Review

- Given a GitHub PR that adds a new code path with no relevant logging, metric, or span, Instrument automatically posts at least one specific review comment that cites the file and line.
- Given a GitHub PR with no meaningful observability gap, Instrument posts no comments.
- Given the same PR revision is analyzed twice, Instrument does not duplicate comments.
- Given a pull request receives a new revision with the same unresolved observability gap at the same code location, Instrument does not post a duplicate comment.
- Given a PR review recommendation is shown in the console, the user can view PR number, title, author, branch, comments, and code locations.

### 14.2 Recommendations

- Given an automatic codebase scan finds a service queue with no depth metric, Instrument creates an active recommendation citing the code path and explaining why the missing metric matters.
- Given a recommendation requires a metric before an alert, the alert step remains locked until the metric step is complete.
- Given a user dismisses a recommendation, it moves to the archive and can be restored unless it is outdated.
- Given code changes remove the affected code path, Instrument marks the recommendation outdated and explains why.
- Given a recommendation scan runs, Instrument records scan scope, trigger, start time, completion time, and stale/fresh status.

### 14.3 Datadog Alert Recommendations

- Given an existing emitted metric with no monitor, Instrument suggests a new Datadog alert and cites metric/code evidence.
- Given a noisy Datadog monitor, Instrument suggests a specific threshold or configuration improvement and shows the proposed configuration diff.
- Given a metric cannot be verified, Instrument does not recommend a Datadog alert for it unless the recommendation explicitly depends on first adding that metric.
- Given Datadog does not provide ownership, criticality, or notification routing for a service, Instrument omits that context from recommendations instead of inferring it or blocking the recommendation.

### 14.4 Incidents

- Given a Datadog alert webhook, Instrument creates or updates one grouped incident and shows it in the active incident list.
- Given multiple related Datadog webhooks for the same service and root problem, Instrument groups them rather than creating duplicate incidents.
- Given an investigation starts, the console shows persisted progress phases and still shows them after browser refresh.
- Given Datadog logs API returns a retryable failure, the job enters a retrying state, preserves completed phases, and shows the retry note in the console.
- Given an investigation job reaches a terminal failed state, the console shows the failure, preserves completed progress, identifies the affected source/integration, and provides a manual retry action when the job is safe to retry.
- Given an investigation completes, the incident detail shows ranked hypotheses, confidence, evidence, key signals, and timeline.
- Given the root cause is upstream or otherwise not fixable through code, Instrument explains that no code fix can be generated and suggests a next step.
- Given TrueFoundry logs contain an LLM/tool failure correlated by service, request ID, trace ID, or incident time window, Instrument can cite those logs as evidence in a hypothesis.
- Given the investigation-start setting is `manual`, a firing alert creates an incident that stays `new` until a human presses Investigate.
- Given the setting is `auto`, a firing alert's investigation starts on its own, and the incident shows a "Started automatically" badge in the list and detail.
- Given the setting is `smart`, Instrument auto-starts the investigation for a clear-cut/important alert and leaves an ambiguous alert waiting for a human.
- Given the setting is changed while an investigation is already running, that in-flight investigation is left undisturbed.
- Given a user is viewing a running investigation's detail, its progress phases, hypotheses, evidence, and final result update in place without a manual refresh.
- Given any setting, no investigation generates or applies a fix automatically; fix generation requires explicit human action and is stretch scope.

### 14.5 Console Reliability

- Given a user refreshes the browser during a running job, the job state and progress are restored from the server.
- Given a new incident or recommendation change arrives while the user is viewing related content, the console updates in place or indicates new content is available and provides a refresh action.
- Given an integration is disconnected or missing permissions, the console communicates the degraded state and avoids pretending analysis is complete.
- Given an external write action other than automatic PR review comments is requested, the console asks for confirmation before taking the action.
- Given the backend restarts during a running job, the console can recover persisted job state after the backend is available again.
