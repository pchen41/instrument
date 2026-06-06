# Task 4: Build server-backed console reads, polling, and persisted UI state

## Status

Not started.

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

- Update this section with endpoints/hooks added, polling intervals, and any design deviations.
