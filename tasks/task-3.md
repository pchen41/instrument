# Task 3: Seed first-slice workflow records and schema validation helpers

## Status

Complete (2026-06-06). Added Zod validation helpers for the 11 jsonb shapes
(`src/lib/schemas/`), seeded first-slice workflow records as Instrument
dogfooding itself (the console, the InsForge edge functions/job worker, the
Render TrueFoundry-MCP server, and provider integrations — repo
`pchen41/instrument`), and read helpers / documented query shapes
(`src/data/reads.ts`). Migration `20260607015338_seed-workflow-records.sql`
applied cleanly. Offline `npm test` (69) and live `npm run verify:reads` (16
member-JWT read/RLS checks) both pass; `npm run verify:db` still green.

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

- 2026-06-06 — Implemented.
- **JSON validation helpers** in `src/lib/schemas/` (Zod, per the ERD's "validate
  in application code, e.g. with Zod"). `index.ts` exposes `COLUMN_SCHEMAS`
  (a `table.column` → element-schema map) and `validateColumn(column, value)` for
  all 11 jsonb shapes: `jobs.phases` / `jobs.attempts` / `jobs.audit_events`,
  `repositories.service_map`, `recommendations.steps` /
  `recommendations.lifecycle_events`, `incidents.signals` / `timeline` /
  `hypotheses` / `correlated_changes`, and `ai_model_calls.tool_calls_redacted`.
  The JSON-vocabulary enums live in `enums.ts`. Reused by edge functions/workers
  later to validate AI output before write/render.
- **Read helpers / query shapes** in `src/data/reads.ts`: `listActiveIncidents`,
  `listResolvedIncidents`, `getIncidentDetail` (incident + investigation job +
  evidence), `listActiveRecommendations`, `listArchivedRecommendations`
  (accepted/dismissed/outdated), `getRecommendationDetail` (steps + evidence),
  `listPrReviewRecommendations`, `getPrReviewRecord` (rec + PR metadata +
  comments), and the pure `incidentDisplayState` mapper. All go through an
  authenticated SDK client so RLS scopes results to the workspace.
- **Seed** (`migrations/20260607015338_seed-workflow-records.sql`, idempotent DO
  block; no-ops once incidents exist). Content is Instrument observing itself:
  - Integrations: TrueFoundry → `rate_limited` (drives the reliability incident);
    GitHub/Datadog → `connected`. Repo `service_map` maps paths to
    instrument-console / job-worker-tick / github-webhook / datadog-webhook /
    external-action-executor / instrument-mcp.
  - 7 incidents: active in every display state — `new` (no job), `investigating`
    (running + retrying jobs), `complete` (succeeded job), `failed` (terminal
    failed job) — one auto-started, plus 2 resolved. The marquee one is the PRD
    reliability proof: job-worker-tick retrying through TrueFoundry 429s, with the
    retries recorded in `jobs.attempts` and `telemetry_emissions`.
  - 8 recommendations across `active`/`accepted`/`dismissed`/`outdated` and all
    three categories, including a multi-step alert rec with a **locked** dependent
    step, a **generated PR** result in a step (synced as PR #12), a generated
    **draft Datadog monitor** result in a step, a monitor-change diff, and a
    `pr_review` rec with 3 **posted** `pr_review_comments` on incoming PR #14.
  - Supporting rows: jobs (with phases/attempts/audit), `github_pull_requests`,
    `ai_model_calls` (with redacted MCP tool calls), `approvals`,
    `external_write_actions` (PR create + draft monitor + 3 review comments),
    `evidence_items`, `telemetry_emissions`.
  - **No incident-fix PR generation** is implied (future scope): incidents hold
    investigation output only (signals/timeline/hypotheses/correlated_changes/
    evidence), never a generated fix. Generated PR / draft-monitor results live in
    `recommendations.steps`, not in folded generated-artifact tables.
- **Tests**:
  - `src/lib/schemas/schemas.test.ts` — valid + invalid document per jsonb column
    via `validateColumn` (offline, mirrors the seed shapes).
  - `src/data/reads.unit.test.ts` — `incidentDisplayState` mapping + list query
    shapes via a mock client (offline).
  - `src/data/no-folded-tables.test.ts` — scans `src/` `.from()` calls and the
    seed migration for any folded/retired table reference (offline).
  - `npm run verify:reads` (`scripts/verify-reads.mjs`) — live member-JWT test:
    active incidents cover all four display states, resolved incidents, active
    recs across categories, archived states, the locked multi-step rec + generated
    PR #12, the generated draft monitor, the PR #14 review record with 3 posted
    comments, incident detail (job + evidence), and that an anon non-member reads
    nothing. Needs `INSTRUMENT_DEMO_PASSWORD` at run time (kept out of git); skips
    cleanly without it. (db query cannot switch roles, so the live read/RLS check
    uses the SDK, consistent with Task 2's `verify:rls`.)
- **No schema deviations** from `docs/ERD.md` — Task 3 added no columns/tables; it
  only populated jsonb shapes and added app-side validators/read helpers.
- 2026-06-06 — External review (Codex + Gemini). Both confirmed the schema mapping
  and full state coverage; Gemini independently validated all live seeded rows
  against the Zod schemas. Applied hardening from the review:
  - All jsonb object schemas are now `.strict()` so field-name drift in AI output /
    future seeds is rejected, not silently stripped.
  - `recommendationStep.target_provider` widened to the full `integration_provider`
    enum (was github/datadog only).
  - `verify-reads.mjs` now asserts an anon/non-member reads zero rows across
    incidents, recommendations, jobs, pr_review_comments, evidence_items,
    external_write_actions, and ai_model_calls (was incidents only).
  - Confirmed all 114 seeded jsonb documents pass the strict schemas (one-off live
    `validateColumn` run).
  - Deferred (nit): the step metric field is named `metric_verification_state`;
    the ERD vocab is `metric_existence_state` and a traceability line calls the
    field `verification_state`. Nothing consumes it yet — align the name when the
    Task 4 console reads steps.
