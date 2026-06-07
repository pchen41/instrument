# Task 4: Build server-backed console reads, polling, and persisted UI state

## Status

Complete (2026-06-06). The three console sections now render from InsForge-backed
reads with poll-while-active refresh and durable job-state mapping; the
investigation-start setting persists to `workspaces`. Per the agreed Task 4
scope, the live mutations that depend on Task 5A endpoints (start / retry an
investigation, dismiss / restore a recommendation, generate a PR, apply a monitor
change, publish a draft monitor, mark a PR merged) are rendered but routed
through a single deferred-action choke point that surfaces a notice — the read
surfaces, polling, failed-job UI, auto-started indicator, integration health, and
setting persistence are all live. Offline `npm test` (93) and `npm run build`
pass; live verification is a manual step (run the dev server with the demo login).

## Context

The prototype uses browser-local mock state. The PRD requires the console to show server-backed state and resume after refresh without re-running jobs.

Depends on Tasks 1, 2, and 3 for seeded reads. Live retry, approval,
dismiss/restore, and investigation-start mutations depend on Task 5A endpoints.

## Requirements

- Replace mock console data with InsForge-backed reads or server read endpoints for:
  - Incidents list and detail.
  - Recommendations list, archive, steps, generated artifacts, and PR review records.
  - Integrations health.
  - Related job progress and failure state.
- Implement UI mapping from durable job state:
  - No job -> `new`.
  - `queued`, `running`, `retrying` -> `investigating`.
  - `succeeded` -> `complete`.
  - terminal `failed` -> failed display state.
- Add the failed investigation/job UI state required by the PRD: preserved progress, affected integration/source, error summary, and retry action when `safe_to_retry` is true.
- Render automatically started investigations with a "Started automatically"
  indicator in both the incident list and incident detail when
  `incidents.started_automatically = true`.
- Implement the investigation-start setting control with labels:
  - Manual
  - Automatic
  - Let Instrument decide
- Persist setting changes on `workspaces` without disturbing investigations
  already in flight.
- Implement simple polling against jobs, list/detail records, `updated_at`, and
  `jobs.progress_version` while active work is visible.
- Debounce in-console change notifications in application code; do not add an
  `app_events` table for the first product slice.
- Keep generated recommendation PRs and generated draft Datadog monitor states
  visible and linkable from recommendation detail/drawers.

## Acceptance Criteria

- Refreshing the browser preserves visible incident, recommendation, integration, and job progress state.
- Starting a view does not create duplicate jobs.
- Failed jobs render as failed, not as endless spinners.
- Active and archived recommendations are shown separately.
- Active and resolved incidents are shown separately.
- Integration degraded, disconnected, rate-limited, and missing-credential states have clear UI treatment.
- The console does not expose future-scope incident fix PR generation as an active action.

## Automated Tests

- Add component tests for incident job-state mapping, including failed and retrying.
- Add component tests for recommendation step locking and archive filters.
- Add polling or data-hook tests that verify refresh reads persisted job state without enqueueing a new job.
- Add accessibility checks for confirmation dialogs, drawers, and segmented controls.

## Manual Verification

- Load the console with seeded data.
- Switch between active/resolved incidents and open an incident detail.
- Refresh during a seeded running job and confirm progress resumes.
- Toggle investigation-start setting and confirm persisted value after refresh.
- Simulate a job or record `updated_at` / `progress_version` change and confirm
  the console surfaces the change without a full page reload.

## Progress Notes

- 2026-06-06 — Implemented (Instrument still dogfooding itself; all content is the
  `pchen41/instrument` repo and its own components).
- **Data layer** (`src/data/`):
  - `reads.ts` extended with `loadIncidentsView(scope)` (incidents joined to
    investigation job state via one `jobs.in(ids)` read → derived display state),
    `getJobsByIds`, `loadActiveRecommendations` / `loadArchivedRecommendations`
    (cards carry `steps` + `rationale`), `getWorkspaceSettings`,
    `updateInvestigationStartMode`, `listIntegrations`, plus
    `ACTIVE_JOB_STATES` / `isActiveJobState`. `JobSummary` widened with
    `progress_version`, `failure_source`, `failure_integration_id`,
    `max_attempts`, `error_code`, timestamps.
  - `hooks.ts` — `usePolling` (poll-while-active: loads once, re-reads every 2s
    only while `isActive(data)` and refetches on tab focus; reads through a ref so
    inline loaders don't resubscribe), `useChangeFlash` (debounced "Updated"
    flash), and the view hooks `useIncidentsView` / `useIncidentDetail` /
    `useRecommendationsView` / `useIntegrations` / `useWorkspaceSettings`. All
    accept an injectable client for tests. Active-work predicates: any incident
    `investigating`, the detail job in a non-terminal state, or any rec step
    `generating`.
  - `deferred.ts` — the single choke point for Task-5A-dependent mutations;
    `runDeferredAction(action)` returns the notice the UI shows. Greppable so each
    deferred site is obvious when 5A wires real endpoints.
- **UI primitives** (`src/components/console/`): `indicators` (Pill / Activity /
  Confidence / AutoBadge — Activity gained a crit-toned `failed` state),
  `overlays` (accessible `ConfirmDialog` + `Drawer`: role=dialog, aria-modal,
  labelled, Escape + scrim close, focus moves in on open / restores on close),
  `GenProgress` (renders straight from `jobs.phases`, with retrying/failed marks),
  `Segmented` (ARIA radiogroup, arrow-key navigable), `feedback`
  (Loading / Error / Toast + `useTransientNotice`).
- **Views**:
  - `Incidents.tsx` — Active/Resolved segmented filter, the `AutoInvestigateMenu`
    setting control, and rows whose marker is the durable display state (no job →
    New + Investigate; queued/running/retrying → Investigating; succeeded →
    complete; failed → failed + a retry hint). "Started automatically" badge on
    auto-started, non-new rows. A "Live"/"Updated" pill shows while an
    investigation is in flight.
  - `IncidentDetail.tsx` (route `/incidents/:incidentId`, so a refresh keeps the
    open investigation) — RCA card (leading hypothesis when complete, live
    `GenProgress` when investigating), hypotheses considered, correlated changes,
    and a rail with signals / timeline / evidence. **Failed state** renders the
    PRD-required UI: preserved phase progress, affected source/service + error
    chips, and a Retry action gated on `safe_to_retry`. **No incident "Generate
    fix"** anywhere (future scope).
  - `Recommendations.tsx` — Open/Archive split = durable `state`; steps render
    from `steps` JSON (locked → "Unlocks when …", ready → view the generated PR /
    draft monitor / config diff in a drawer, done → completion label,
    pr_review → opens the posted comments). Generated PR and draft Datadog monitor
    stay visible and linkable (drawer "Open on GitHub" / "Open in Datadog").
  - `Integrations.tsx` — server-backed health with distinct treatments for
    connected / degraded / rate_limited / missing_credentials / disconnected, plus
    the last error when unhealthy. (The sidebar's mini "Connected sources" list is
    left as static chrome; the Integrations page is the health surface — Task 5D
    can refine the sidebar.)
- **Investigation-start setting** persists directly to `workspaces`
  (`updateInvestigationStartMode`, optimistic with revert-on-error) — Task 2's
  column-scoped UPDATE grant means no endpoint is needed. It only touches the
  setting; in-flight investigations are unaffected (they read
  `investigation_start_mode_snapshot`, captured at start, not this live column).
- **Polling / change notifications**: 2s interval, only while active work is
  visible; refetch on tab focus; the "Updated" flash is debounced via
  `useChangeFlash`. No `app_events` table added (per the requirement).
- **Tests** (offline, +24 → 93 total): `data/hooks.test.tsx` (resume from durable
  running-job state, keep polling while active, stop when idle — and prove no
  insert/update/delete is ever issued, i.e. starting/refreshing a view never
  enqueues a job); `routes/console/Incidents.test.tsx` (display-state mapping incl.
  failed + auto-started badge + active/resolved separation);
  `routes/console/Recommendations.test.tsx` (locked step, generated PR #12 link,
  PR-review comments, deferred-notice, archive filter + badges + restore);
  `components/console/overlays.test.tsx` + `Segmented.test.tsx` +
  `indicators.test.tsx` (a11y + mapping).
- **Scope / deferrals**: the Task-5A mutations are intentionally not persisted in
  Task 4 (agreed). They are rendered and routed through `runDeferredAction`, which
  shows a calm "enabled when the action endpoints ship (Task 5A)" toast rather
  than attempting an RLS-blocked write. The metric-field naming nit carried over
  from Task 3 (`metric_verification_state`) is untouched — nothing in the Task 4
  views reads it yet.
- **Manual live verification** (not run here; demo password kept out of the
  session): `npm run dev`, sign in as `test@test.com` with the demo password from
  `docs/CONFIG.md`, then exercise the flows below. The live read path is also
  covered headlessly by `INSTRUMENT_DEMO_PASSWORD=… npm run verify:reads`.
- 2026-06-06 — Polling cadence changed to **2s** (was 5s), still only while active
  work is visible.
- 2026-06-06 — External review (Codex + Gemini). Both confirmed no admin
  keys/secrets in the frontend (anon key only; the sole browser write is the
  `workspaces` settings update, which RLS revokes/re-grants narrowly), correct
  job-state mapping, the failed-job UI, and that incident "Generate fix" is
  omitted. Applied the valid findings:
  - `usePolling`: a transient poll error no longer freezes the live view — it
    keeps scheduling ticks while work was active (tracked via a `wasActive` ref);
    `clearTimer()` now runs at the start of `run()` so a manual refetch/focus
    can't double-fire a pending tick; the reset effect clears a stale error; and
    `refetch()` is awaitable.
  - Investigation-start setting: the optimistic `override` is dropped after the
    server re-read confirms, so it no longer permanently shadows server state.
  - `IncidentDetail`: jsonb array columns (hypotheses / signals / timeline /
    correlated_changes / job.phases) are guarded with `?? []` so a partial read
    can't crash the page.
  - `overlays`: `ConfirmDialog` / `Drawer` now trap Tab focus, and a shared
    Escape stack means a confirm opened over a drawer closes only the confirm
    (not both); the Escape handler reads `onClose` through a ref (no listener
    churn).
  - `Segmented`: arrow keys now move DOM focus to the newly selected radio (ARIA
    roving focus).
  - `Recommendations`: `failed` / `skipped` step states render an explicit label
    instead of falling through to a "Generate" action.
  - Removed dead incident fix-generation CSS (`.gen-hint` / `.fix-chip`); kept
    `.gen-dot` (used by the recommendation "Generating" pill).
  - Regression tests added (95 total): Escape closes only the topmost overlay;
    polling survives a transient error while work is active.
  - Deferred (NIT): `reads.ts` `listPrReviewRecommendations` is currently unused —
    kept as a documented Task 3 read-surface helper for a future PR-review view.
