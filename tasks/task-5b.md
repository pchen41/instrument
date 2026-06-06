# Task 5B: Prove worker runtime viability for Edge Functions versus Compute

## Status

Not started.

## Context

The ERD proposes scheduled InsForge Edge Function ticks as the default worker
runtime, with InsForge Compute as a fallback when work needs a longer-lived
process. The first slice depends on TrueFoundry Agent/API workflows that may
stream MCP tool calls and results. This task is a decision gate: prove Edge
Function ticks work for the representative workload, or promote Compute into the
first-slice runtime before downstream provider workflows are built.

Depends on Tasks 0, 2, and 5A. Task 5C may provide real TrueFoundry helpers; if
it is not ready, use a faithful streaming fixture/mock that has the same timing,
partial-output, interruption, and persistence shape.

## Requirements

- Implement the worker runtime as a scheduled InsForge Edge Function tick for the
  viability test:
  - Create a `job-worker-tick` style function that claims due jobs and processes
    bounded work within the function time budget.
  - Configure or document an InsForge schedule that invokes the tick every
    minute.
  - Opportunistically invoke the tick after enqueueing important jobs when
    practical.
  - Use `jobs.next_run_at`, leases, persisted phases, and retry state to continue
    work across scheduled invocations.
- Run a representative TrueFoundry Agent/API tool-loop workload, or a faithful
  fixture, through the Edge Function runtime.
- The representative workload must include streamed partial output, multiple
  tool-call/result events, evidence persistence, retryable failure behavior, and
  enough latency to approximate incident investigation or recommendation
  generation.
- Measure and document:
  - total runtime
  - function timeout margin
  - cron/schedule latency
  - opportunistic invocation latency
  - stream interruption behavior
  - retry/resume behavior after interruption
  - whether partial progress is persisted before timeout or failure
- If the representative workload cannot complete safely inside the Edge Function
  model, update the implementation plan to use InsForge Compute for first-slice
  workers instead of treating Compute as a later fallback.
- Document the final runtime decision before Tasks 6, 7, 8, 9, 11, or 12 depend
  on real provider workflows.

## Acceptance Criteria

- A representative Agent/API streamed tool-loop completes within the Edge
  Function time budget with documented timeout margin, or Compute is promoted as
  the first-slice worker runtime.
- If the function is interrupted mid-stream, the job moves to a safe retry/failure
  state without losing persisted progress.
- Resuming from `jobs.next_run_at` does not duplicate jobs, model-call records,
  evidence items, or external write actions.
- Cron latency plus opportunistic invocation latency is documented and judged
  acceptable for the validation path, or Compute is selected.
- The worker runtime decision is recorded in task notes and referenced by later
  tasks.

## Automated Tests

- Add a scripted runtime viability check using a mocked or real streamed Agent/API
  workload.
- Add an interruption test that simulates timeout or process exit during a
  streamed tool loop.
- Add a resume test proving persisted progress is reused and duplicate writes are
  avoided.
- Add a latency budget assertion or report for the representative workload.

## Manual Verification

- Run the scheduled tick locally or in the linked InsForge project.
- Run the representative streamed workload and capture timing results.
- Interrupt the worker mid-run and confirm the job can retry or fail safely.
- Confirm the selected runtime is documented before downstream workflow tasks
  begin.

## Progress Notes

- Update this section with timing results, timeout margins, runtime decision,
  schedule details, and any Compute promotion decision.
