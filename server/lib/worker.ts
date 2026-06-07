import type { JobsDb } from './db';
import { mergePhases, planFor } from './phases';
import { classifyError, decideAfterFailure, JobError, resolvePolicy } from './retry';
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
}

export interface TickResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  failed: number;
  skipped: number;
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

  const result: TickResult = { claimed: 0, succeeded: 0, retrying: 0, failed: 0, skipped: 0 };
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

type Outcome = 'succeeded' | 'retrying' | 'failed' | 'lost';

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

  try {
    for (let i = 0; i < phases.length; i++) {
      if (phases[i].state === 'succeeded') continue;
      phases[i] = { ...phases[i], state: 'running', started_at: isoSeconds(opts.clock.now()) };
      await owned({ phases: [...phases], progress_version: ++version });

      await sleep(opts.phaseDelayMs ?? 0);
      maybeFail(phases[i].key, simulate, attempt);

      phases[i] = { ...phases[i], state: 'succeeded', completed_at: isoSeconds(opts.clock.now()) };
      await owned({ phases: [...phases], progress_version: ++version });
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
  return 'succeeded';
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
  return 'failed';
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
