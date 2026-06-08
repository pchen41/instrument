import type { PhaseExecutor } from './agent';
import { isRealInvestigation } from './agent-investigate';
import type { JobsDb } from './db';
import { mergePhases, planFor } from './phases';
import { classifyError, type ClassifiedError, decideAfterFailure, JobError, resolvePolicy } from './retry';
import type { JobFailureSignal } from './telemetry';
import { addSeconds, isoSeconds, LEASE_FREE, sleep, type Clock } from './time';
import type { JobAttempt, JobAuditEvent, JobPhase, JobRow, SimulateConfig } from './types';

// Worker time budget. The function cron tick claims a bounded batch and processes
// each to a checkpoint well inside the function timeout. Engine phases are short
// (provider work lands later); the lease (60s) covers any real latency and is how
// an interrupted run is reclaimed by a later tick.
export const LEASE_SECONDS = 60;
const MAX_AUDIT_EVENTS = 50;
const MAX_ATTEMPT_SUMMARIES = 20;

export interface RunTickOptions {
  workerId: string;
  clock: Clock;
  maxJobs?: number;
  /** Per-phase delay; tiny in prod for a visible progression, 0 in tests. */
  phaseDelayMs?: number;
  /**
   * Real per-phase work (Task 5B viability path): a TrueFoundry gateway turn / MCP
   * tool call with idempotent persistence. Runs while the phase is `running`, may
   * throw a JobError to drive retry/terminal handling, and is a no-op for jobs not
   * flagged as a viability run — so the 5A simulated path is untouched.
   */
  executePhase?: PhaseExecutor;
  /**
   * Bounded phases per invocation (Task 5B). When set, a tick processes at most
   * this many phases then requeues the job through `next_run_at` for the next
   * tick to resume — the ERD's "process bounded phases, requeue the rest" model.
   * Unset (5A default) processes the whole job in one invocation.
   */
  maxPhasesPerTick?: number;
  /**
   * Reliability telemetry hook (Task 5D). Called best-effort AFTER a retry/error
   * state write commits, so the worker emits `instrument.job.retry` /
   * `instrument.job.error` to Datadog + the telemetry_emissions audit row. Must
   * never throw back into the state machine — the worker swallows any error. A
   * no-op when unset (e.g. 5A tests). The Deno edge supplies the real emitter.
   */
  emitJobTelemetry?: (signal: JobFailureSignal) => Promise<void>;
}

export interface TickResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  failed: number;
  skipped: number;
  /** Jobs that hit the per-tick phase budget and were requeued to resume later. */
  requeued: number;
}

/**
 * One worker tick: claim due + abandoned jobs and process each. Idempotent and
 * safe to run concurrently — every job is taken under an atomic lease, so a
 * second tick (or the opportunistic poke racing the cron) cannot double-process.
 */
export async function runTick(db: JobsDb, opts: RunTickOptions): Promise<TickResult> {
  const max = opts.maxJobs ?? 5;
  const now = opts.clock.now();
  const nowIso = isoSeconds(now);

  const due = await db.selectDueJobs(nowIso, max);
  const abandoned = await db.selectAbandonedJobs(nowIso, max);

  const seen = new Set<string>();
  const candidates: { row: JobRow; kind: 'due' | 'abandoned' }[] = [];
  for (const row of due) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    candidates.push({ row, kind: 'due' });
  }
  for (const row of abandoned) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    candidates.push({ row, kind: 'abandoned' });
  }

  const result: TickResult = { claimed: 0, succeeded: 0, retrying: 0, failed: 0, skipped: 0, requeued: 0 };
  for (const { row, kind } of candidates.slice(0, max)) {
    const claimed = await claim(db, row, kind, opts);
    if (!claimed) {
      result.skipped += 1; // lost the race to another worker
      continue;
    }
    result.claimed += 1;
    const outcome = await processJob(db, claimed, opts);
    // 'lost' = the lease was reclaimed mid-run by another tick; count it as
    // skipped (the new owner is responsible for the job now).
    if (outcome === 'lost') result.skipped += 1;
    else if (outcome === 'requeued') result.requeued += 1;
    else result[outcome] += 1;
  }
  return result;
}

/** Build the on-claim patch and attempt the atomic conditional update. */
async function claim(
  db: JobsDb,
  row: JobRow,
  kind: 'due' | 'abandoned',
  opts: RunTickOptions,
): Promise<JobRow | null> {
  const now = opts.clock.now();
  const nowIso = isoSeconds(now);
  const attempt = row.attempt_count + 1; // each claim starts one attempt
  const patch: Partial<JobRow> = {
    state: 'running',
    locked_by: opts.workerId,
    locked_at: nowIso,
    lease_expires_at: isoSeconds(addSeconds(now, LEASE_SECONDS)),
    heartbeat_at: nowIso,
    attempt_count: attempt,
    started_at: row.started_at ?? nowIso,
    next_run_at: null,
  };
  return db.claimJob(row.id, kind, nowIso, patch);
}

type Outcome = 'succeeded' | 'retrying' | 'failed' | 'lost' | 'requeued';

/** Thrown when an owner-guarded write finds the lease has been reclaimed. */
class LeaseLost extends Error {
  constructor() {
    super('lease lost');
    this.name = 'LeaseLost';
  }
}

/**
 * Run the job's remaining phases. Persists progress after every phase so an
 * interruption preserves completed work, and translates a thrown JobError into
 * either a scheduled retry or a terminal failure (both keep the phases reached).
 * Every write is owner-guarded and renews the lease, so if a later tick reclaims
 * an over-running job this worker bails ('lost') instead of clobbering it.
 */
export async function processJob(db: JobsDb, job: JobRow, opts: RunTickOptions): Promise<Outcome> {
  try {
    return await runJob(db, job, opts);
  } catch (err) {
    if (err instanceof LeaseLost) return 'lost';
    throw err;
  }
}

async function runJob(db: JobsDb, job: JobRow, opts: RunTickOptions): Promise<Outcome> {
  const policy = resolvePolicy(job);
  const attempt = job.attempt_count; // already incremented at claim
  const simulate = job.trigger_summary?.simulate;
  const phases = mergePhases(job.job_type, job.phases);
  let version = job.progress_version;
  const attemptStartedAt = isoSeconds(opts.clock.now());

  // Owner-guarded write: applies only while we still hold the lease, and renews
  // the lease on every checkpoint. Throws LeaseLost if another tick reclaimed it.
  const owned = async (patch: Partial<JobRow>): Promise<void> => {
    const at = isoSeconds(opts.clock.now());
    const res = await db.updateOwnedJob(job.id, opts.workerId, {
      heartbeat_at: at,
      lease_expires_at: isoSeconds(addSeconds(opts.clock.now(), LEASE_SECONDS)),
      locked_by: opts.workerId,
      ...patch, // terminal writes override lease/locked_by
    });
    if (!res) throw new LeaseLost();
  };

  let audit = append(job.audit_events, {
    at: attemptStartedAt,
    kind: 'attempt_started',
    summary: `Attempt ${attempt} started (${opts.workerId}).`,
  });
  await owned({ phases, audit_events: audit, progress_version: ++version });

  let processedThisTick = 0;
  try {
    for (let i = 0; i < phases.length; i++) {
      if (phases[i].state === 'succeeded') continue;
      phases[i] = { ...phases[i], state: 'running', started_at: isoSeconds(opts.clock.now()) };
      await owned({ phases: [...phases], progress_version: ++version });

      await sleep(opts.phaseDelayMs ?? 0);
      maybeFail(phases[i].key, simulate, attempt);
      // Real per-phase work (viability path); no-op for simulated/seeded jobs. May
      // throw a JobError → handled by the same retry/terminal path below.
      if (opts.executePhase) await opts.executePhase({ job, phaseKey: phases[i].key, attempt });

      phases[i] = { ...phases[i], state: 'succeeded', completed_at: isoSeconds(opts.clock.now()) };
      await owned({ phases: [...phases], progress_version: ++version });
      processedThisTick += 1;

      // Bounded work per invocation: if we've hit the budget and phases remain,
      // requeue (due immediately) so the next tick resumes from the persisted
      // phases — proving cross-invocation resume via next_run_at.
      if (opts.maxPhasesPerTick && processedThisTick >= opts.maxPhasesPerTick) {
        const remain = phases.some((p) => p.state !== 'succeeded');
        if (remain) {
          const at = isoSeconds(opts.clock.now());
          audit = append(audit, {
            at,
            kind: 'requeued',
            summary: `Tick budget reached after ${processedThisTick} phase(s); requeued to resume.`,
          });
          await owned({
            state: 'queued',
            phases: [...phases],
            audit_events: audit,
            progress_version: ++version,
            next_run_at: at,
            lease_expires_at: LEASE_FREE,
            locked_by: null,
            // A budget requeue is a *continuation*, not a new attempt. claim()
            // increments attempt_count on the next tick, so roll it back by one
            // here — otherwise chunking burns the retry budget and a later
            // retryable failure would be treated as terminal.
            attempt_count: attempt - 1,
          });
          return 'requeued';
        }
      }
    }
  } catch (err) {
    if (err instanceof LeaseLost) throw err; // bubble to processJob → 'lost'
    return finishFailure(owned, job, phases, version, attempt, attemptStartedAt, policy, audit, err, opts);
  }

  const doneAt = isoSeconds(opts.clock.now());
  audit = append(audit, { at: doneAt, kind: 'succeeded', summary: 'Job completed.' });
  await owned({
    state: 'succeeded',
    phases,
    attempts: appendAttempt(job.attempts, {
      attempt,
      outcome: 'succeeded',
      started_at: attemptStartedAt,
      completed_at: doneAt,
    }),
    audit_events: audit,
    progress_version: ++version,
    completed_at: doneAt,
    lease_expires_at: LEASE_FREE,
    locked_by: null,
    error_code: null,
    error_summary: null,
    failure_source: null,
  });

  // Best-effort, post-success: make a SIMULATED/seeded investigation read
  // coherently by promoting the incident's seeded *tentative* leading hypothesis —
  // never fabricating a cause. A real Task 11 investigation owns its own write-back
  // (evidence-backed, validated hypotheses), so skip the placeholder for those.
  if (job.job_type === 'incident_investigation' && job.target_type === 'incident' && !isRealInvestigation(job)) {
    try {
      await finalizeIncident(db, job.target_id, opts);
    } catch {
      /* the job is already succeeded; a finalization hiccup must not undo that */
    }
  }
  return 'succeeded';
}

/** Promote a completed incident's tentative leading hypothesis to confirmed. */
async function finalizeIncident(db: JobsDb, incidentId: string, opts: RunTickOptions): Promise<void> {
  const incident = await db.getIncident(incidentId);
  if (!incident) return;
  const at = isoSeconds(opts.clock.now());

  const hypotheses = (incident.hypotheses ?? []).map((h) => {
    if (!h.leading) return h;
    const tentative = typeof h.detail === 'string' && /confirm once you start|tentative/i.test(h.detail);
    return {
      ...h,
      confidence: h.confidence && h.confidence !== 'low' ? h.confidence : 'likely',
      detail: tentative ? 'Confirmed as the leading cause from the correlated signals and recent changes.' : h.detail,
    };
  });
  // Dedupe on title so a retried/repeat finalize doesn't stack the entry, and use
  // a valid timeline kind ('analysis' is not in the incidentTimelineEntry enum).
  const timeline = [
    ...(incident.timeline ?? []).filter((t) => t.title !== 'Investigation complete'),
    { at, kind: 'finding', title: 'Investigation complete', detail: 'Instrument correlated the signals and confirmed the leading cause.' },
  ];
  await db.updateIncident(incidentId, { hypotheses, timeline });
}

async function finishFailure(
  owned: (patch: Partial<JobRow>) => Promise<void>,
  job: JobRow,
  phases: JobPhase[],
  version: number,
  attempt: number,
  attemptStartedAt: string,
  policy: ReturnType<typeof resolvePolicy>,
  audit: JobAuditEvent[],
  err: unknown,
  opts: RunTickOptions,
): Promise<Outcome> {
  const at = isoSeconds(opts.clock.now());
  const error = classifyError(err);
  const decision = decideAfterFailure(policy, attempt, error);
  // Mark the phase that was running as the failure point; earlier phases stay
  // succeeded (preserved progress).
  const idx = phases.findIndex((p) => p.state === 'running');
  if (idx >= 0) {
    phases[idx] = {
      ...phases[idx],
      state: decision.state === 'retrying' ? 'retrying' : 'failed',
      detail: error.summary,
    };
  }

  if (decision.state === 'retrying') {
    const nextRunAt = isoSeconds(addSeconds(opts.clock.now(), decision.backoffSeconds));
    await owned({
      state: 'retrying',
      phases: [...phases],
      attempts: appendAttempt(job.attempts, {
        attempt,
        outcome: 'retrying',
        started_at: attemptStartedAt,
        completed_at: at,
        error_code: error.code,
        error_summary: error.summary,
        next_run_at: nextRunAt,
      }),
      audit_events: append(audit, {
        at,
        kind: 'retry_scheduled',
        summary: `Attempt ${attempt} failed (${error.code}); retrying in ${decision.backoffSeconds}s.`,
      }),
      progress_version: version + 1,
      next_run_at: nextRunAt,
      lease_expires_at: LEASE_FREE,
      locked_by: null,
      error_code: error.code,
      error_summary: error.summary,
      failure_source: error.source,
    });
    await emitTelemetry(opts, job, 'retry', attempt, error);
    return 'retrying';
  }

  await owned({
    state: 'failed',
    phases: [...phases],
    attempts: appendAttempt(job.attempts, {
      attempt,
      outcome: 'failed',
      started_at: attemptStartedAt,
      completed_at: at,
      error_code: error.code,
      error_summary: error.summary,
    }),
    audit_events: append(audit, {
      at,
      kind: 'failed',
      summary: `Attempt ${attempt} failed terminally (${error.code}).`,
    }),
    progress_version: version + 1,
    completed_at: at,
    next_run_at: null,
    lease_expires_at: LEASE_FREE,
    locked_by: null,
    error_code: error.code,
    error_summary: error.summary,
    failure_source: error.source,
  });
  await emitTelemetry(opts, job, 'error', attempt, error);
  return 'failed';
}

/**
 * Best-effort reliability emission after a retry/terminal write has committed.
 * Wrapped so a telemetry failure (Datadog down, store hiccup) can never undo or
 * block the job's recorded state — the durable engine is the source of truth; the
 * Datadog signal is downstream. trace/request IDs are forwarded when the job
 * carries them (the provider workflow tasks stash them in trigger_summary).
 */
async function emitTelemetry(
  opts: RunTickOptions,
  job: JobRow,
  kind: 'retry' | 'error',
  attempt: number,
  error: ClassifiedError,
): Promise<void> {
  if (!opts.emitJobTelemetry) return;
  const ts = job.trigger_summary as { last_trace_id?: string; last_request_id?: string } | undefined;
  try {
    await opts.emitJobTelemetry({
      kind,
      workspaceId: job.workspace_id,
      jobId: job.id,
      jobType: job.job_type,
      attempt,
      error,
      integrationId: job.failure_integration_id ?? null,
      source: error.source,
      traceId: ts?.last_trace_id ?? null,
      requestId: ts?.last_request_id ?? null,
    });
  } catch {
    /* telemetry is downstream of durable state; never let it disturb the engine */
  }
}

/** Engine failure injection (Task 5A has no real providers — see SimulateConfig). */
function maybeFail(phaseKey: string, simulate: SimulateConfig | undefined, attempt: number): void {
  if (!simulate || simulate.fail_phase !== phaseKey) return;
  const terminal = simulate.mode === 'terminal';
  // Retryable simulation can "recover": once we've reached recover_on_attempt,
  // the phase passes — so a manual retry of a failed job eventually succeeds.
  if (!terminal && simulate.recover_on_attempt && attempt >= simulate.recover_on_attempt) return;
  throw new JobError({
    retryable: !terminal,
    code: simulate.error_code ?? (terminal ? 'fatal_error' : 'rate_limited'),
    summary: simulate.error_summary ?? (terminal ? 'The job failed and will not be retried.' : 'A dependency was rate limited.'),
    source: simulate.failure_source ?? 'truefoundry',
  });
}

function append(events: JobAuditEvent[] | undefined, event: JobAuditEvent): JobAuditEvent[] {
  const next = [...(events ?? []), event];
  return next.length > MAX_AUDIT_EVENTS ? next.slice(next.length - MAX_AUDIT_EVENTS) : next;
}

function appendAttempt(attempts: JobAttempt[] | undefined, attempt: JobAttempt): JobAttempt[] {
  const next = [...(attempts ?? []), attempt];
  return next.length > MAX_ATTEMPT_SUMMARIES ? next.slice(next.length - MAX_ATTEMPT_SUMMARIES) : next;
}

/** Phase plan length — exposed for tests/manual seeding. */
export function phaseCount(jobType: JobRow['job_type']): number {
  return planFor(jobType).length;
}
