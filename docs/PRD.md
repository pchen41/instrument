# Instrument PRD

## 1. Product Summary

Instrument is an AI SRE for software teams. It reads a team's codebase, GitHub activity, and observability signals to find gaps in instrumentation, suggest better alerts, and help on-call engineers investigate incidents.

This PRD defines the product direction for Instrument and the first practical product slice to build. The long-term product is a code-aware reliability layer that continuously connects source code, operational telemetry, and human-approved remediation workflows. The first slice is intentionally scoped for a demonstrable end-to-end path, but it should be implemented as real product foundation rather than a presentation-only prototype.

The initial product slice should prove one reliable-agent loop: Instrument reviews a GitHub PR, preserves and updates recommendations as code changes, generates a recommendation PR after human approval, survives a forced TrueFoundry/API rate-limit failure with durable retries, emits reliability telemetry, investigates the resulting Datadog incident with evidence, and generates a draft Datadog monitor from an accepted recommendation. This carved-out scope exists to make the product shippable and verifiable early, while preserving the architecture and product concepts needed for broader use.

Instrument does not replace Datadog, GitHub, or TrueFoundry. It connects those systems, adds code-aware reasoning, and presents actionable, evidence-backed recommendations in a web console.

The product has three primary surfaces:

- **Incidents**: Datadog alerts become incidents that Instrument can investigate using codebase context, recent commits, Datadog monitors/logs/metrics, and TrueFoundry MCP/LLM logs.
- **Recommendations**: Instrument proactively suggests observability improvements, including missing metrics, missing logs, missing spans, dashboard gaps, and Datadog monitor improvements.
- **Integrations**: Users see preconfigured GitHub, Datadog, and TrueFoundry connection state and any degraded/missing credential state.

## 2. Design Reference and Scope Model

The design reference is in `design/README.md`. The console prototype is under `design/project/console/`; the auth prototype is under `design/project/auth.jsx`.

The console prototype is a visual reference and represents the target product direction, not a strict contract for every first-slice feature. Implementation should match the design intent for scoped surfaces where practical, but may deviate to satisfy this PRD, defer later product actions, add missing required states, or handle backend constraints. Any meaningful design deviation should be documented.

Prototype comments may clarify product intent, but this PRD is the source of truth for product priorities and first-slice scope. Generated recommendation PRs and human-approved draft Datadog monitor creation are included in the first product slice. Generated incident-fix PRs, actively publishing notifying Datadog monitors, and arbitrary edits to existing Datadog monitors appear in the target-state prototype but are later product scope unless explicitly promoted.

The auth prototype is visual reference only for now. First-slice auth is limited to username/password login for a single configured workspace, as defined in Section 10.

The console design must add a failed job/investigation state consistent with the existing activity and progress patterns. The current prototype shows `new`, `investigating`, and `complete`; the first product slice must also show `failed` with preserved progress, affected integration/source, error context, and a safe retry action when retry is supported.

Iconography should follow the Phosphor visual language. The exported design prototype uses a self-contained inline SVG layer for portability, but the production React app should use `@phosphor-icons/react` while matching the prototype's icon choices, weight, and sizing.

Scope should be read in three layers:

- **Product direction**: the durable product Instrument is intended to become.
- **First product slice / validation scope**: the end-to-end subset that must be built now to validate the product with real integrations, durable jobs, evidence, and human-approved writes.
- **Later product scope**: valuable capabilities intentionally deferred so the first slice remains practical.

## 3. Goals

- Help teams improve observability before incidents happen.
- Reduce incident triage time by correlating alerts with code changes and operational signals.
- Make AI conclusions trustworthy by grounding every recommendation and investigation in specific evidence.
- Keep humans in control of external writes.
- Automatically post scoped, deduplicated, auditable GitHub PR observability review comments.
- Provide a polished web console with durable progress, retry, and refresh behavior that does not depend on the user's browser session.
- Instrument the Instrument app itself with Datadog logs, metrics, traces, and optional frontend RUM/error telemetry as features are built, so the product demonstrates the observability practices it recommends.
- Prove TrueFoundry-backed reliability behavior through a scoped validation path: retries, retry/error metrics, Datadog incident creation, and AI investigation of the induced failure.

## 4. Non-Goals

- Instrument will not replace Datadog as the source of truth for monitor state, alert state, logs, metrics, or traces.
- Instrument will not replace GitHub as the source of truth for code, commits, pull requests, branches, comments, or review state.
- Instrument will not guarantee a single definitive root cause for every incident. It should present ranked hypotheses with evidence and confidence. A single hypothesis is acceptable when no credible alternatives exist.
- The first product slice will not automatically merge code, generate incident fix PRs, or otherwise mutate customer systems without explicit human approval, except for automatic GitHub PR observability review comments.
- Incident investigations are read-only even when they start automatically.

## 5. Users and Personas

### 5.1 On-call Engineer

The on-call engineer responds to alerts and needs fast, trustworthy incident context. They use Instrument to see active incidents, start or view investigations, inspect evidence, and understand whether a failure is caused by code or by external runtime configuration such as a TrueFoundry/API rate limit.

### 5.2 Platform/SRE Owner

The platform or SRE owner is responsible for improving observability quality across services. They use Instrument to review recommendations, accept or dismiss suggestions, generate recommendation PRs after approval, create approved draft Datadog monitors, and identify missing metrics, logs, spans, dashboard panels, or Datadog alerts.

### 5.3 Application Engineer

The application engineer owns service code and pull requests. They receive automatic GitHub PR comments from Instrument when a code change introduces or exposes a specific observability gap.

## 6. Supported Integrations

Initial integrations are preconfigured for one workspace and one primary GitHub repository. Credentials may be provided through environment variables or local admin configuration. The first product slice does not include OAuth connection flows or self-serve integration setup.

### 6.1 GitHub

Instrument uses GitHub to:

- Read repositories, files, branches, commits, pull requests, diffs, and PR metadata.
- Detect recent deploy-related commits or changes relevant to an incident. GitHub commit history is the first deploy-correlation source for the initial slice.
- Automatically leave scoped observability review comments on pull requests.
- Track PR review activity and posted observability comments.
- Create branches and pull requests for approved observability improvement recommendations, then track whether those PRs are opened, merged, closed, or stale.

Automatic PR observability review comments are an explicit exception to the general human-approval rule for external writes. They must still be scoped, deduplicated, auditable, and limited to configured repositories where the workflow is enabled. Creating recommendation PRs must be gated by explicit user approval.

### 6.2 Datadog

Instrument uses Datadog to:

- Receive alert webhooks.
- Read monitors, monitor configuration, alert status, logs, metrics, and Datadog service metadata where available.
- Read service ownership, criticality, and notification routing only when those fields exist in Datadog.
- Suggest new monitors when important emitted metrics are not alerting.
- Suggest improvements to existing monitors, such as threshold changes, missing tags, missing runbooks, noisy alerts, or missing notifications.
- Create new draft Datadog monitors for accepted alert recommendations after explicit user approval.

Datadog remains the source of truth for monitor and alert state. Instrument must avoid suggesting alerts for metrics that it cannot verify exist or can be emitted by the relevant code path. Datadog traces and dashboards may be used when available, but monitors, logs, and metrics are the required Datadog scopes for the first product slice. For the first slice, generated Datadog monitors may remain draft/non-notifying monitors when the Datadog integration path supports draft creation but not publish-time notification behavior.

### 6.3 TrueFoundry

Instrument uses TrueFoundry to:

- Read MCP and LLM-related logs.
- Correlate AI application failures, degraded model calls, tool failures, latency, and cost anomalies with incidents and recommendations.

TrueFoundry is an observability signal source and the reliability substrate for Instrument's AI workflows. Incident correlation should use available service names, trace IDs, request IDs, deployment timestamps, model names, tool names, and time windows from the incident.

## 7. Core Workflows

### 7.1 GitHub PR Observability Review

When a configured GitHub pull request is opened or updated, Instrument analyzes the diff and relevant surrounding code. If the change introduces a specific observability gap, Instrument automatically posts concise review comments on the PR.

The first product slice should handle pull request opened, reopened, synchronize, and ready-for-review events.

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

Instrument scans configured repositories and observability data to find gaps before they become incidents. Demo scans should run automatically on commits to the primary branch with a cooldown to avoid repeated expensive scans. Additional triggers may be implementation-defined. Manual scan triggering is not required.

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
- **REC-6**: Outdated recommendations must explain why they no longer apply.
- **REC-7**: Instrument must deduplicate recommendations across scans so stable findings do not reappear as new items.
- **REC-8**: Users must be able to view active recommendations and archived recommendations separately.
- **REC-9**: A recommendation becomes `accepted` only when all required steps are completed, such as a recommendation PR being merged, a draft Datadog monitor being created, a monitor change being applied outside Instrument, or a user marking a non-mutating step complete.
- **REC-10**: If a previously accepted or dismissed recommendation becomes invalid because code or monitor context changed, Instrument may mark it `outdated` and must preserve prior lifecycle history.
- **REC-11**: Users must be able to generate a GitHub PR for an approved instrumentation recommendation when the change is code-based and safe to propose as a pull request.
- **REC-12**: Generated recommendation PRs must include a clear branch name, PR title, summary, changed files, and evidence linking the PR back to the recommendation.

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
- **ALERT-4**: Instrument must not create draft Datadog monitors or apply Datadog monitor changes without explicit human approval.
- **ALERT-5**: Alert recommendations must cite relevant monitor configuration, metric evidence, alert history, or code paths.
- **ALERT-6**: Service ownership, criticality, and notification routing must be read from Datadog when available. When this metadata is absent, Instrument must not fabricate it, require it, or block recommendations on it.
- **ALERT-7**: Users must be able to accept a verified new-alert recommendation and generate the corresponding draft Datadog monitor from the console.
- **ALERT-8**: Generated draft Datadog monitors must show the proposed query, threshold, tags, service scope, notification targets when known, draft state, and resulting Datadog monitor link or identifier.

### 7.4 Datadog Alert Ingestion and Incident Investigation

When Datadog sends an alert webhook, Instrument creates or updates an incident for the configured service. Whether the investigation starts automatically is governed by a workspace-level **investigation-start setting**. The default is `manual`, matching the current console prototype.

Investigation inputs include:

- Datadog alert payload and monitor configuration.
- Datadog logs, metrics, service tags, and available Datadog service metadata.
- GitHub commits, pull requests, files, diffs, and recent deploy-related changes.
- TrueFoundry MCP/LLM logs when relevant.

Requirements:

- **INC-1**: A Datadog alert webhook must create a new incident or update the current open incident for the configured service.
- **INC-2**: An incident must track alert state, incident state, service, title, description, source, start time, key signals, investigation state, timeline, and evidence.
- **INC-3**: Investigation display states must include `new`, `investigating`, `complete`, and `failed`, mapped from durable job state as defined in Section 8.
- **INC-4**: Investigation output must present ranked hypotheses when appropriate. If there is an obvious root cause, multiple hypotheses are not necessary.
- **INC-5**: A hypothesis must include evidence references, confidence, and reasoning.
- **INC-6**: Confidence levels must use stable bands: `High`, `Likely`, and `Low`. The UI may label the leading hypothesis as `Root cause` only for `High`; otherwise it should label it as `Leading hypothesis`.
- **INC-7**: If the root cause is outside the codebase or not fixable by Instrument, the investigation must explain why no code fix can be generated and suggest a next step.
- **INC-8**: Resolved incidents must remain visible in a resolved/archive view with their final findings.
- **INC-9**: A workspace-level investigation-start setting must offer three modes: `manual` (default), `auto`/Automatic, and `smart`/Let Instrument decide. Changing the setting must not disturb investigations already in flight.
- **INC-10**: In `manual` mode, every investigation waits for a human to press Investigate.
- **INC-11**: In `auto` mode, Instrument starts investigating every firing alert as it arrives.
- **INC-12**: In `smart` mode, Instrument starts on its own for important, clear-cut alerts and waits for a human when the situation is ambiguous.
- **INC-13**: The smart mode may use a deterministic first-slice rule, such as auto-investigating alerts whose name or tags contain a configured reliability-demo keyword.
- **INC-14**: Any investigation that began without a human must be visibly marked in both the incident list and incident detail, for example with a "Started automatically" badge.
- **INC-15**: Investigations must be read-only and must never auto-generate or apply a fix. Fix generation stays later product scope under every investigation-start setting.

### 7.5 TrueFoundry Reliability Proof Workflow

The first product slice must show Instrument as a reliable agent built on TrueFoundry features. The intended sequence is:

1. A user approves generation of a recommendation PR.
2. The PR generation job encounters an artificial retryable TrueFoundry/API failure, such as a very low rate limit.
3. Instrument retries with bounded backoff, preserves progress, and emits retry/error telemetry.
4. A Datadog monitor triggers an incident from that telemetry.
5. Smart investigation start automatically begins an investigation for the reliability alert.
6. The investigation cites Datadog and TrueFoundry evidence and identifies the induced rate limit as the root cause or leading hypothesis.
7. After the rate limit is manually fixed, the incident can resolve while the original recommendation PR generation job succeeds in the background.

Requirements:

- **TF-1**: Retryable TrueFoundry/API failures during PR generation must not lose job state or duplicate external writes.
- **TF-2**: The retry/error metric emitted for the forced failure must include enough tags or attributes for Datadog to route it to the configured service incident.
- **TF-3**: The investigation must distinguish a platform/runtime configuration issue, such as a rate limit, from a code defect and suggest the manual operational fix.
- **TF-4**: The console must show the PR generation job, incident investigation, incident resolution, and eventual generated PR as separate but linkable events.

## 8. Durable Jobs, Progress, and Live Updates

Instrument's core workflows are long-running and must be executed by durable backend jobs, not browser-local state.

Job examples include PR review analysis, proactive scans, recommendation generation, draft Datadog monitor generation, incident investigation, and recommendation PR generation.

Requirements:

- **JOB-1**: Jobs must persist state so they survive browser refreshes, user navigation, backend restarts, and transient integration failures.
- **JOB-2**: Job states must include at least `queued`, `running`, `retrying`, `failed`, and `succeeded`. First-slice jobs do not require cancellation support.
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
- **JOB-14**: When a PR review recommendation becomes outdated because the reviewed PR was merged, the console must move it to the archive, explain that the reviewed PR is no longer active, and notify the viewer without requiring a browser refresh. The first slice does not need to detect whether the suggestion was applied before merge.
- **JOB-15**: When a new recommendation is generated from the updated codebase, the console must surface it in the active recommendations view without requiring a browser refresh.
- **JOB-16**: The first product slice does not require external notifications such as Slack, email, or PagerDuty.

## 8.1 Instrument Self-Observability

Instrument must add broad Datadog instrumentation to its own app code as the
first slice is built. This is separate from, and broader than, the specific
retry/error telemetry used for the TrueFoundry reliability proof.

Requirements:

- **OBS-1**: Server-side handlers, workers, webhook ingestion, external provider calls, model-call orchestration, scheduled job ticks, UI read endpoints, and external write executors must emit structured logs with service, environment, workflow, job type, integration/provider, request/correlation IDs when available, and redacted error details.
- **OBS-2**: Server-side code must emit metrics for request/job counts, latency, failures, retries, provider/API errors, schema validation failures, queue depth or due-job count where practical, and external write outcomes.
- **OBS-3**: Server-side code should emit traces/spans for inbound requests, job execution phases, provider calls, model calls, MCP tool calls, database operations where practical, and external writes.
- **OBS-4**: Frontend code should include optional Datadog RUM/error tracking hooks for route changes, console load failures, failed user actions, and API/read endpoint failures when browser-safe Datadog RUM configuration is provided. The app must still run when RUM is not configured.
- **OBS-5**: Instrumentation must not log raw provider credentials, InsForge admin keys, webhook secrets, model prompts containing sensitive code beyond approved redacted summaries, or unbounded provider payloads.
- **OBS-6**: Datadog instrumentation config must be environment-driven and split between server-only secrets and browser-safe public values. Missing Datadog telemetry configuration should degrade gracefully in local development and tests.
- **OBS-7**: The reliability-validation metrics `instrument.job.retry` and `instrument.job.error` are required, stable, Datadog-routable signals within the broader instrumentation set.

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
- **SEC-2**: First-slice auth must support username/password login for a single configured workspace.
- **SEC-3**: Integration credentials may be provided through environment variables or local admin configuration; the first product slice does not require OAuth connection flows.
- **SEC-4**: Human approval must be required before generating recommendation PRs, creating draft Datadog monitors, or taking other external write actions, except for automatic GitHub PR observability review comments.
- **SEC-5**: Automatic GitHub PR observability review comments do not require per-comment human approval, but must be scoped, deduplicated, auditable, and limited to configured repositories/workspaces where the workflow is enabled.
- **SEC-6**: Users must be able to see when an integration is disconnected, degraded, rate-limited, or missing required credentials.
- **SEC-7**: Inbound Datadog webhooks must be authenticated or signature-verified before they can create or update incidents.

## 11. Web Console

Required views:

- **Incidents**: Active and resolved incident lists; investigation-start setting control; incident detail; investigation progress; failed investigation state; hypotheses; key signals; timeline; correlated code changes.
- **Recommendations**: Active and archived recommendations; multi-step recommendation progress; PR review records; configuration change drawers; generated recommendation PR state; generated draft Datadog monitor state.
- **Integrations**: GitHub, Datadog, and TrueFoundry connection state.

Requirements:

- **UI-1**: The console must show server-backed state and resume from persisted state after browser refresh.
- **UI-2**: Long-running work must show named progress phases rather than an opaque spinner.
- **UI-3**: The console must gracefully handle missing integrations, expired credentials, rate limits, partial data, and network/API failures.
- **UI-4**: Destructive or externally mutating actions must require explicit confirmation, except for automatic GitHub PR observability review comments as defined in Sections 6.1 and 10.
- **UI-5**: The incident list view must expose the investigation-start setting with the three labels shown in the design: Manual, Automatic, and Let Instrument decide.

## 12. First Product Slice

The first product slice must include:

- Preconfigured GitHub, Datadog, and TrueFoundry integrations for one workspace and one primary repository.
- Username/password login for the configured workspace.
- Automatic GitHub PR observability review comments.
- Active and archived recommendations, including multi-step recommendations, instrumentation recommendations, Datadog alert improvement recommendations, and PR review recommendations.
- Human-approved GitHub PR generation for code-based instrumentation recommendations.
- Human-approved draft Datadog monitor generation for verified alert recommendations.
- Automatic scans on commits to the primary branch with a cooldown.
- Datadog alert ingestion for the configured service, incident investigation, evidence display, resolved incident history, and smart investigation start.
- Durable job state for long-running work, retries, live updates, refresh recovery, and backend restart recovery.
- Broad Datadog instrumentation for Instrument's own frontend, server functions,
  workers, webhooks, provider calls, and external writes.
- TrueFoundry reliability proof for forced retryable failures, retry/error metrics, Datadog incident creation, AI investigation, and background PR generation completion.
- Console views for Incidents, Recommendations, and Integrations.

## 13. Later Product Scope

Later product iterations may add:

- Self-serve OAuth connection flows and broader least-permission setup for GitHub, Datadog, and TrueFoundry.
- Multi-workspace and multi-organization authorization, repository selection, and role-based access control.
- Incident grouping for alert storms across monitors, services, environments, tags, and time windows.
- Generated GitHub PRs for incident fixes.
- Applying arbitrary edits to existing Datadog monitors from the console.
- Publishing actively notifying Datadog monitors from Instrument after draft creation.
- User-facing job cancellation and richer job control.
- Manual/on-demand recommendation scans and advanced scan scheduling.
- Deeper Datadog traces, dashboards, service catalog, ownership, notification, and runbook workflows.
- External notifications such as Slack, email, PagerDuty, or Datadog incident synchronization.

## 14. First-Slice Non-Goals

- No OAuth setup flow or self-serve integration onboarding.
- No multi-tenant organization model.
- No incident grouping beyond updating the current open incident for the configured service.
- No automatic code merging, automatic production monitor changes, arbitrary existing-monitor edits, or incident-fix PR generation.
- No external notifications outside the console and Datadog incident/monitor flow.
- No guarantee of exhaustive recommendation coverage across every repository, service, metric, log, span, dashboard, or monitor type.

## 15. Acceptance Criteria

### 15.1 First-Slice Validation Path

- Given Instrument is configured for the Instrument GitHub repository, when a PR introduces an observability gap, Instrument posts a concise review comment that cites the file and line.
- Given the reviewed PR is merged, Instrument marks the related PR review recommendation `outdated`, moves it to the archive, explains that the reviewed PR is no longer active, and updates the console without a browser refresh. The first slice does not attempt to prove whether the author applied the suggestion before merging.
- Given the updated primary branch is scanned, Instrument creates a new active recommendation with evidence from the codebase or Datadog.
- Given the user approves PR generation for a code-based recommendation, Instrument starts a durable PR generation job and shows named progress phases.
- Given a forced retryable TrueFoundry/API rate-limit error occurs, the job enters `retrying`, preserves progress, emits retry/error telemetry, and avoids duplicate external writes.
- Given Datadog triggers an incident from that telemetry, smart investigation start begins automatically and shows a "Started automatically" indicator.
- Given the investigation completes, the incident detail shows hypotheses, confidence, evidence, key signals, timeline, and the rate limit as the root cause or leading hypothesis.
- Given the rate limit is manually fixed, the incident can resolve while the original recommendation PR generation job succeeds in the background.

### 15.2 Supporting Behaviors

- Given a GitHub PR with no meaningful observability gap, Instrument posts no comments.
- Given the same PR revision is analyzed twice, Instrument does not duplicate comments.
- Given a recommendation requires a metric before an alert, the alert step remains locked until the metric step is complete.
- Given an existing emitted metric has no monitor, Instrument suggests a Datadog alert and cites metric/code evidence.
- Given a noisy Datadog monitor, Instrument suggests a specific threshold or configuration improvement and shows the proposed configuration diff.
- Given the user accepts a verified Datadog alert recommendation, Instrument creates the draft Datadog monitor after confirmation and shows the resulting Datadog link or identifier.
- Given a metric cannot be verified, Instrument does not recommend a Datadog alert for it unless the recommendation explicitly depends on first adding that metric.
- Given Datadog does not provide ownership, criticality, or notification routing for a service, Instrument omits that context instead of inferring it.
- Given the backend restarts or the user refreshes during a running job, the console restores persisted job state without re-running the job.
- Given an integration is disconnected, degraded, rate-limited, or missing credentials, the console communicates the degraded state and avoids pretending analysis is complete.
- Given Datadog telemetry configuration is present, Instrument emits app logs,
  metrics, traces, and frontend RUM/error telemetry for the relevant workflow;
  given it is absent in local development, workflows continue and tests can use a
  mock telemetry sink.
