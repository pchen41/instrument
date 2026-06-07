import { describe, expect, it } from 'vitest';
import { FakeDb, fixedClock } from './fake-db';
import { addSeconds, isoSeconds, LEASE_FREE } from './time';
import { processJob, runTick } from './worker';
import type { JobRow } from './types';

function dueJob(db: FakeDb, clock: { now(): Date }, over: Partial<JobRow> = {}): JobRow {
  return db.seedJob({
    state: 'queued',
    next_run_at: isoSeconds(clock.now()),
    lease_expires_at: LEASE_FREE,
    attempt_count: 0,
    max_attempts: 3,
    ...over,
  });
}

const opts = (clock: { now(): Date }) => ({ workerId: 'w1', clock, phaseDelayMs: 0 });

describe('runTick', () => {
  it('claims a due job and runs every phase to success', async () => {
    const clock = fixedClock();
    const db = new FakeDb();
    const job = dueJob(db, clock);

    const res = await runTick(db, opts(clock));

    expect(res).toMatchObject({ claimed: 1, succeeded: 1 });
    const after = await db.getJob(job.id);
    expect(after?.state).toBe('succeeded');
    expect(after?.phases.every((p) => p.state === 'succeeded')).toBe(true);
    expect(after?.attempts.at(-1)).toMatchObject({ attempt: 1, outcome: 'succeeded' });
    expect(after?.completed_at).toBeTruthy();
    expect(after?.progress_version).toBeGreaterThan(job.progress_version);
  });

  it('is a no-op when no job is due (seeded jobs have a null next_run_at)', async () => {
    const clock = fixedClock();
    const db = new FakeDb();
    const seeded = db.seedJob({ state: 'queued', next_run_at: null, lease_expires_at: null, phases: [] });

    const res = await runTick(db, opts(clock));

    expect(res.claimed).toBe(0);
    const after = await db.getJob(seeded.id);
    expect(after?.state).toBe('queued');
    expect(after?.phases).toHaveLength(0);
  });

  it('schedules a retry on a retryable failure, preserves progress, then resumes and recovers', async () => {
    const clock = fixedClock();
    const db = new FakeDb();
    const job = dueJob(db, clock, {
      trigger_summary: { simulate: { fail_phase: 'gather_signals', mode: 'retryable', recover_on_attempt: 2 } },
    });

    const r1 = await runTick(db, opts(clock));
    expect(r1).toMatchObject({ claimed: 1, retrying: 1 });
    const mid = await db.getJob(job.id);
    expect(mid?.state).toBe('retrying');
    expect(mid?.next_run_at).toBeTruthy();
    expect(mid?.attempt_count).toBe(1);
    expect(mid?.phases.find((p) => p.key === 'triage')?.state).toBe('succeeded'); // preserved
    expect(mid?.phases.find((p) => p.key === 'gather_signals')?.state).toBe('retrying');
    expect(mid?.attempts.at(-1)).toMatchObject({ outcome: 'retrying', next_run_at: mid?.next_run_at });

    // Before backoff elapses it is not due.
    expect((await runTick(db, opts(clock))).claimed).toBe(0);

    clock.advance(60); // past the 20s backoff
    const r2 = await runTick(db, opts(clock));
    expect(r2).toMatchObject({ claimed: 1, succeeded: 1 });
    const done = await db.getJob(job.id);
    expect(done?.state).toBe('succeeded');
    expect(done?.attempt_count).toBe(2);
    expect(done?.phases.every((p) => p.state === 'succeeded')).toBe(true);
  });

  it('fails terminally (no retry) on a terminal error and preserves the reached progress', async () => {
    const clock = fixedClock();
    const db = new FakeDb();
    const job = dueJob(db, clock, {
      trigger_summary: { simulate: { fail_phase: 'gather_signals', mode: 'terminal', error_code: 'fatal', failure_source: 'github' } },
    });

    const res = await runTick(db, opts(clock));

    expect(res).toMatchObject({ claimed: 1, failed: 1 });
    const after = await db.getJob(job.id);
    expect(after?.state).toBe('failed');
    expect(after?.error_code).toBe('fatal');
    expect(after?.failure_source).toBe('github');
    expect(after?.completed_at).toBeTruthy();
    expect(after?.next_run_at).toBeNull();
    expect(after?.phases.find((p) => p.key === 'triage')?.state).toBe('succeeded'); // preserved
    expect(after?.phases.find((p) => p.key === 'gather_signals')?.state).toBe('failed');
    expect(after?.safe_to_retry).toBe(true); // retry remains available to the user
  });

  it('does not double-process a job under two concurrent ticks (atomic lease)', async () => {
    const clock = fixedClock();
    const db = new FakeDb();
    const job = dueJob(db, clock);

    const [r1, r2] = await Promise.all([runTick(db, opts(clock)), runTick(db, opts(clock))]);

    expect(r1.claimed + r2.claimed).toBe(1); // exactly one tick won the claim
    const after = await db.getJob(job.id);
    expect(after?.state).toBe('succeeded');
    expect(after?.attempts).toHaveLength(1); // processed exactly once
  });

  it('promotes a completed investigation\'s tentative leading hypothesis to confirmed', async () => {
    const clock = fixedClock();
    const db = new FakeDb();
    const incident = db.seedIncident({
      hypotheses: [
        { rank: 1, leading: true, summary: 'Worker tick not draining fast enough', detail: 'Tentative — Instrument will confirm once you start the investigation.', confidence: 'low' },
      ],
      timeline: [{ at: '2026-06-06T14:43:10Z', kind: 'alert', title: 'Monitor fired' }],
    });
    const job = dueJob(db, clock, { job_type: 'incident_investigation', target_type: 'incident', target_id: incident.id });

    await runTick(db, opts(clock));

    expect((await db.getJob(job.id))?.state).toBe('succeeded');
    const after = await db.getIncident(incident.id);
    expect(after?.hypotheses?.[0].confidence).toBe('likely'); // promoted from low
    expect(after?.hypotheses?.[0].detail).not.toMatch(/tentative|once you start/i);
    expect(after?.timeline?.some((t) => t.title === 'Investigation complete')).toBe(true);
  });

  it('bails ("lost") without clobbering a job whose lease was reclaimed mid-run', async () => {
    const clock = fixedClock();
    const db = new FakeDb();
    // The row is owned by another worker (lease reclaimed) — our owner-guarded
    // writes must match zero rows, so processJob bails instead of overwriting.
    const job = db.seedJob({
      state: 'running',
      locked_by: 'other-worker',
      attempt_count: 1,
      progress_version: 7,
      phases: [{ key: 'triage', label: 'Reading the alert', state: 'succeeded' }],
    });

    const outcome = await processJob(db, job, opts(clock));

    expect(outcome).toBe('lost');
    const after = await db.getJob(job.id);
    expect(after?.state).toBe('running'); // untouched
    expect(after?.locked_by).toBe('other-worker');
    expect(after?.progress_version).toBe(7);
  });

  it('reclaims an abandoned (lease-expired) running job but leaves null-lease jobs alone', async () => {
    const clock = fixedClock();
    const db = new FakeDb();
    const abandoned = db.seedJob({
      state: 'running',
      lease_expires_at: isoSeconds(addSeconds(clock.now(), -120)), // expired
      attempt_count: 1,
      phases: [
        { key: 'triage', label: 'Reading the alert', state: 'succeeded' },
        { key: 'gather_signals', label: 'Pulling traces, logs, and deploys', state: 'running' },
      ],
    });
    const seededRunning = db.seedJob({ state: 'running', lease_expires_at: null });

    const res = await runTick(db, opts(clock));

    expect(res.claimed).toBe(1);
    const recovered = await db.getJob(abandoned.id);
    expect(recovered?.state).toBe('succeeded');
    expect(recovered?.phases.find((p) => p.key === 'triage')?.state).toBe('succeeded'); // not re-run
    const untouched = await db.getJob(seededRunning.id);
    expect(untouched?.state).toBe('running'); // null lease → never claimed
  });
});

describe('reliability telemetry hook (Task 5D)', () => {
  it('emits a retry signal with routing fields after a retryable failure', async () => {
    const clock = fixedClock();
    const db = new FakeDb();
    const job = dueJob(db, clock, {
      failure_integration_id: 'int-tf',
      trigger_summary: { simulate: { fail_phase: 'gather_signals', mode: 'retryable', error_code: 'rate_limited', failure_source: 'truefoundry' }, last_trace_id: 'tr-1', last_request_id: 'rq-1' },
    });
    const signals: any[] = [];

    const res = await runTick(db, { ...opts(clock), emitJobTelemetry: async (s) => { signals.push(s); } });

    expect(res.retrying).toBe(1);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: 'retry',
      workspaceId: job.workspace_id,
      jobId: job.id,
      jobType: 'incident_investigation',
      attempt: 1,
      integrationId: 'int-tf',
      source: 'truefoundry',
      traceId: 'tr-1',
      requestId: 'rq-1',
    });
    expect(signals[0].error.code).toBe('rate_limited');
  });

  it('emits an error signal on terminal failure and nothing on success', async () => {
    const clock = fixedClock();
    const db = new FakeDb();
    const failJob = dueJob(db, clock, {
      trigger_summary: { simulate: { fail_phase: 'gather_signals', mode: 'terminal', error_code: 'fatal', failure_source: 'github' } },
    });
    const okJob = dueJob(db, clock);
    const signals: any[] = [];

    await runTick(db, { ...opts(clock), maxJobs: 5, emitJobTelemetry: async (s) => { signals.push(s); } });

    const kinds = signals.map((s) => s.kind);
    expect(kinds).toEqual(['error']); // the failing job emitted; the clean job did not
    expect(signals[0]).toMatchObject({ kind: 'error', jobId: failJob.id, source: 'github' });
    expect(signals.some((s) => s.jobId === okJob.id)).toBe(false);
  });

  it('a throwing telemetry hook never disturbs the recorded job state', async () => {
    const clock = fixedClock();
    const db = new FakeDb();
    const job = dueJob(db, clock, {
      trigger_summary: { simulate: { fail_phase: 'gather_signals', mode: 'terminal', error_code: 'fatal' } },
    });

    const res = await runTick(db, { ...opts(clock), emitJobTelemetry: async () => { throw new Error('datadog down'); } });

    expect(res.failed).toBe(1);
    const after = await db.getJob(job.id);
    expect(after?.state).toBe('failed'); // durable state intact despite the throw
  });
});
