# Task 3: Add workflow domain tables for GitHub, recommendations, Datadog, and incidents

## Status

Not started.

## Context

This task extends the Task 2 foundation with the domain tables required by PR review, proactive recommendations, Datadog alerts, and incident investigation.

## Requirements

- Add service and repository tables:
  - `services`
  - `repositories`
  - `repository_service_paths`
- Add inbound webhook and GitHub workflow tables:
  - `inbound_webhooks`
  - `github_pull_requests`
  - `github_push_events`
  - `github_pr_files`
  - `pr_review_runs`
  - `pr_review_findings`
  - `pr_review_comments`
- Add scan and recommendation tables:
  - `scans`
  - `recommendations`
  - `recommendation_events`
  - `generated_pull_requests`
  - `generated_datadog_monitors`
- Add Datadog and incident tables:
  - `datadog_monitors`
  - `datadog_alert_events`
  - `incidents`
- Add enums for:
  - `recommendation_category`
  - `recommendation_state`
  - `alert_state`
  - `incident_state`
- Add the indexes and uniqueness constraints called out in the ERD for these tables.
- Enable RLS on every workspace-owned table and include direct `workspace_id` where the ERD duplicates it for simpler policies.
- Seed demo rows sufficient for the console to render:
  - Active and resolved incidents.
  - Active, accepted, dismissed, and outdated recommendations.
  - At least one multi-step recommendation with a locked dependent step.
  - At least one PR review recommendation with posted comment records.
  - GitHub, Datadog, and TrueFoundry integration health states.

## Acceptance Criteria

- Tables support the PRD lifecycle states for recommendations and incidents.
- `recommendations.steps` stores ordered step objects with stable keys, lock/prerequisite state, and job/completion fields.
- `incidents.hypotheses`, `incidents.timeline`, `incidents.signals`, and `incidents.correlated_changes` store compact UI-safe JSON with evidence IDs where available.
- Datadog ownership, criticality, and notification routing can remain null without blocking recommendations.
- Seed data does not imply future-scope incident fix PR generation.

## Automated Tests

- Add schema tests for partial unique indexes:
  - Active incident correlation key.
  - PR review finding semantic fingerprint.
  - Posted PR review comment per finding.
- Add JSON schema or runtime validation tests for `recommendations.steps` and `incidents.hypotheses`.
- Add RLS tests for the newly added tables.

## Manual Verification

- Apply migrations and seed data.
- Query active and archived recommendations.
- Query active and resolved incidents.
- Confirm direct child-table reads are scoped to the demo workspace.

## Progress Notes

- Update this section with migration names, seed data notes, and any schema deviations from `docs/ERD.md`.
