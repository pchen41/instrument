# Task 5B: Prove worker runtime viability for Edge Functions versus Compute

## Status

Complete (2026-06-06). **Decision: keep scheduled InsForge Edge Function ticks as
the first-slice worker runtime; do NOT promote Compute.** A representative real
TrueFoundry streamed tool-loop completes in ~13s against a ~201s synchronous HTTP
cap / ≥285s background-execution budget, and interruption/retry/resume all behave
correctly with idempotent persistence. Compute remains the documented fallback for
a future workload that needs >~3 min in a single pass or true token-streaming UX.
Later tasks (5C, 6–9, 11, 12) build on Edge Function ticks.

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

- 2026-06-06: Ran the viability test live on the `instrument` project.

  **Edge Function budgets (measured empirically with a throwaway heartbeat probe,
  since deleted):**
  - Synchronous HTTP response cap ≈ **201s** — the proxy returns
    `504 REQUEST_TIMED_OUT` at 201.4s. Bounds the console's inline opportunistic
    poke (caller waits on the response).
  - Background execution budget ≥ **285–413s** observed — the function kept
    persisting heartbeats long past the 201s HTTP cut; no hard ceiling hit under
    ~7 min. Bounds the cron-driven tick (fire-and-forget).

  **Representative workload** — hybrid: real TrueFoundry AI Gateway streaming
  turns (model `instrument/instrument` → gemini-3.5-flash) + scripted github/
  datadog MCP tool events + idempotent persistence to `ai_model_calls` /
  `evidence_items`. 5-phase `incident_investigation`
  (triage/gather_signals/correlate/hypotheses/summarize):
  - **Unbounded, one invocation:** ~13s end-to-end; 4 real gateway turns
    (~2.0–3.0s each; 37–47 in / 196–276 out tokens) + 2 evidence items.
  - **Bounded (`maxPhasesPerTick=2`):** 3 invocations (7.1 / 7.7 / 5.8s),
    `requeued → requeued → succeeded`, resumed across invocations via
    `next_run_at`; exactly 4 model calls / 2 evidence — zero duplication.
  - **Interruption (abandoned lease):** a job stuck `running` with an expired
    lease after 2 committed phases was reclaimed by the next tick and ran only the
    3 remaining phases to `succeeded` — completed phases were not re-executed.

  **Schedule:** existing every-minute cron (`* * * * *`) on `job-worker-tick`
  fires on-time at the 00-second boundary (no observed drift); idle tick
  0.4–0.6s, busy viability tick ~13.7s. Enqueue→start via cron alone is ≤60s
  (next boundary), which is why 5A added the sub-second opportunistic inline poke.

  **Metrics summary**
  | Metric | Result |
  |---|---|
  | Total runtime | ~13s (real 5-phase loop) |
  | Timeout margin | ~13s vs 201s sync (~15×) / ≥285s background (~22×) |
  | Cron/schedule latency | on-time, every minute; ≤60s enqueue→start via cron |
  | Opportunistic latency | sub-second to start work (inline poke) |
  | Stream interruption | a single LLM turn streams atomically (first-chunk≈total); partial-output granularity is per phase/turn, not per token |
  | Retry/resume | retryable failure → `retrying`+backoff → resume; abandoned lease reclaimed next tick; both resume with no duplicate records |
  | Partial progress | persisted at every phase boundary; bounded-per-tick requeues via `next_run_at` |

  **Implementation (runtime-agnostic engine extensions, used by later tasks):**
  - `server/lib/agent.ts` — gateway/tool/store interfaces + idempotent
    investigation executor (no-op unless `trigger_summary.mode === 'viability'`).
  - `server/functions/_shared/agent-runtime.ts` — Deno streaming TrueFoundry
    client, scripted MCP tools, PostgREST idempotent store.
  - `server/lib/worker.ts` — two opt-in hooks: `executePhase` (real per-phase
    work) and `maxPhasesPerTick` (bounded phases + `next_run_at` requeue). Both
    inert when unset, so the 5A simulated path is unchanged.
  - `server/lib/viability.test.ts` — 8 tests (full loop, gating no-op, mid-phase
    dedup, bounded resume, abandoned-lease resume, retry resume, late-chunk
    failure retries, failing-store retries).

  **Gateway notes:** use the short model name `instrument/instrument` (the
  prefixed `peterc:virtual-model:…` form 403s); the gateway does NOT emit a
  `[DONE]` SSE sentinel — completion is signalled by `finish_reason` + `usage`.

- 2026-06-06 (review pass, Claude + Codex static review): applied all High + Med
  findings before finalizing.
  - Gateway call now aborts at 45s (< 60s lease) via `AbortController`, with the
    read loop wrapped so a mid-stream interruption is a retryable error, not a
    silently-truncated "success" (completion requires `finish_reason`/`usage`).
  - The persistence store fails safe: read errors throw retryable (no fail-open
    "absent"), write errors throw, and a unique-constraint violation is treated as
    an idempotent no-op. Added migration
    `20260607062105_add-agent-idempotency-indexes.sql` (partial unique indexes on
    `ai_model_calls(job_id, purpose)` and `evidence_items(collected_by_job_id,
    subject_key)`) as the atomic backstop for the check-then-insert guard.
  - Bounded-per-tick requeue no longer consumes the retry budget (a continuation
    rolls `attempt_count` back by one so `claim()`'s increment nets to zero).
  - A `viability` job in a workspace with no TrueFoundry integration now fails
    explicitly instead of silently running the simulated path; the integration is
    resolved per workspace (not a single global lookup).
  - Provider response bodies are never copied into job-visible errors; the worker
    endpoint returns a generic `worker_error` to callers. `ai_model_calls`
    constants aligned to the ERD (`api_surface=agent_chat_completions`,
    `validation_status=not_applicable`). `maxPhasesPerTick` validated as a
    positive integer; worker id uses a full UUID.
  - Live re-verified after the fixes: unbounded run succeeds with ERD-correct
    constants; the unique index rejects a duplicate `(job_id, purpose)` insert.
    Full suite 131 passing; `tsc` + function bundle green. Throwaway rows and the
    budget probe were cleaned up; `WORKER_TICK_SECRET` was rotated.
