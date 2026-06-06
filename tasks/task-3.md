# Task 3: Seed first-slice workflow records and schema validation helpers

## Status

Not started.

## Context

The simplified ERD now creates all core tables in Task 2. This task focuses on
making the schema useful for the console and later workflow tasks: JSON shape
validation, seed records, and helper queries/read surfaces for incidents,
recommendations, PR review comments, and generated step state.

Depends on Task 2.

## Requirements

- Add runtime or SQL-backed validation helpers for JSON shapes stored in:
  - `jobs.phases`
  - `jobs.attempts`
  - `jobs.audit_events`
  - `repositories.service_map`
  - `recommendations.steps`
  - `recommendations.lifecycle_events`
  - `incidents.signals`
  - `incidents.timeline`
  - `incidents.hypotheses`
  - `incidents.correlated_changes`
  - `ai_model_calls.tool_calls_redacted`
- Seed first-slice workflow rows sufficient for the console to render:
  - Use or update the GitHub, Datadog, and TrueFoundry integration rows created
    in Task 2 so each relevant health state is represented.
  - One primary repository with `service_map`.
  - Active and resolved incidents.
  - Incidents in `new`, `investigating`, `complete`, and failed display states
    through linked or absent `jobs`.
  - Active, accepted, dismissed, and outdated recommendations.
  - At least one multi-step recommendation with a locked dependent step.
  - At least one PR review recommendation with posted `pr_review_comments`.
  - Generated PR and generated draft Datadog monitor result examples stored in
    `recommendations.steps`, not separate generated artifact tables.
- Add read helpers or documented query shapes for:
  - Active and archived recommendations.
  - Active and resolved incidents.
  - Recommendation detail with step state and generated artifacts.
  - Incident detail with linked investigation job and evidence.
  - PR review records with PR metadata and comment details.
- Ensure folded table concepts are represented in the simplified schema:
  - Scan provenance through `jobs.trigger_summary`,
    `recommendations.created_by_job_id`, and `recommendations.last_seen_job_id`.
  - Recommendation lifecycle through `recommendations.lifecycle_events`.
  - Datadog monitor and alert snapshots through `evidence_items`,
    `incidents.alert_payload_summary`, and recommendation step payloads.
  - MCP/tool summaries through `ai_model_calls.tool_calls_redacted` and
    `evidence_items`.
- Ensure seed data does not imply future-scope incident fix PR generation.

## Acceptance Criteria

- Seeded console data can be queried from the 15-table schema without depending
  on folded/retired tables.
- `recommendations.steps` stores ordered step objects with stable keys,
  lock/prerequisite state, job IDs, approval IDs, generated PR/draft monitor
  result fields, and completion fields.
- `incidents.hypotheses`, `incidents.timeline`, `incidents.signals`, and
  `incidents.correlated_changes` store compact UI-safe JSON with evidence IDs
  where available.
- Datadog ownership, criticality, and notification routing can be absent without
  blocking recommendations.
- Active and archived recommendation queries work.
- Active and resolved incident queries work.
- Direct child-table reads are scoped to the configured workspace through RLS.

## Automated Tests

- Add JSON schema or runtime validation tests for recommendation steps,
  lifecycle events, job progress/audit JSON, repository service maps, model tool
  summaries, and incident investigation JSON.
- Add query tests for active/archive recommendations and active/resolved
  incidents.
- Add RLS tests for seeded workflow rows.
- Add tests that no application query or fixture references folded/retired
  tables from the old ERD.

## Manual Verification

- Apply migrations and seed data.
- Query active and archived recommendations.
- Query active and resolved incidents.
- Open the seeded PR review record and confirm it includes PR metadata and
  comment details.
- Confirm generated PR and draft Datadog monitor examples are stored inside
  recommendation step JSON.

## Progress Notes

- Update this section with seed data notes, JSON schema/helper locations, and
  any schema deviations from `docs/ERD.md`.
