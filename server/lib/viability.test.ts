import { describe, expect, it } from 'vitest';
import {
  makeInvestigationExecutor,
  type AgentGateway,
  type ToolHost,
  type ToolRequest,
  type TurnRequest,
  type WorkStore,
} from './agent';
import { FakeDb, fixedClock } from './fake-db';
import { JobError } from './retry';
import { isoSeconds, LEASE_FREE, addSeconds } from './time';
import { runTick } from './worker';
import type { JobRow } from './types';

// Task 5B viability workload: drive the representative incident-investigation
// loop through the durable engine with deterministic fakes for the gateway, MCP
// tools, and persistence — proving bounded-per-tick resume and that resuming
// (across ticks, after an abandoned lease, or after a retry) never duplicates a
// model-call or evidence record.

class FakeGateway implements AgentGateway {
  calls: string[] = [];
  failOnce = new Map<string, number>();
  async complete(req: TurnRequest) {
    this.calls.push(req.purpose);
    const left = this.failOnce.get(req.purpose) ?? 0;
    if (left > 0) {
      this.failOnce.set(req.purpose, left - 1);
      throw new JobError({ retryable: true, code: 'rate_limited', summary: 'gateway throttled', source: 'truefoundry' });
    }
    return { text: `out:${req.purpose}`, model: 'gemini-3.5-flash', provider: 'google', latencyMs: 5 };
  }
}

class FakeTools implements ToolHost {
  calls: ToolRequest[] = [];
  async call(req: ToolRequest) {
    this.calls.push(req);
    return { externalId: `${req.server}:${req.tool}`, title: 't', summary: 's', payload: { ok: 1 }, latencyMs: 5 };
  }
}

class FakeStore implements WorkStore {
  modelCalls: { jobId: string; purpose: string }[] = [];
  evidence: { jobId: string; subjectKey: string }[] = [];
  failRecordOnce = new Map<string, number>(); // purpose -> remaining throws
  async hasModelCall(jobId: string, purpose: string) {
    return this.modelCalls.some((m) => m.jobId === jobId && m.purpose === purpose);
  }
  async recordModelCall(rec: { jobId: string; purpose: string }) {
    const left = this.failRecordOnce.get(rec.purpose) ?? 0;
    if (left > 0) {
      this.failRecordOnce.set(rec.purpose, left - 1);
      throw new JobError({ retryable: true, code: 'store_write_failed', summary: 'persist failed', source: 'worker' });
    }
    this.modelCalls.push({ jobId: rec.jobId, purpose: rec.purpose });
  }
  async hasEvidence(jobId: string, subjectKey: string) {
    return this.evidence.some((e) => e.jobId === jobId && e.subjectKey === subjectKey);
  }
  async recordEvidence(rec: { jobId: string; subjectKey: string }) {
    this.evidence.push({ jobId: rec.jobId, subjectKey: rec.subjectKey });
  }
}

function setup(over: Partial<JobRow> = {}) {
  const clock = fixedClock();
  const db = new FakeDb();
  const incident = db.seedIncident({ service_name: 'checkout', hypotheses: [], timeline: [] });
  const gateway = new FakeGateway();
  const tools = new FakeTools();
  const store = new FakeStore();
  const executePhase = makeInvestigationExecutor({ gateway, tools, store, now: () => clock.now() });
  const job = db.seedJob({
    job_type: 'incident_investigation',
    target_type: 'incident',
    target_id: incident.id,
    state: 'queued',
    next_run_at: isoSeconds(clock.now()),
    lease_expires_at: LEASE_FREE,
    trigger_summary: { mode: 'viability', service_name: 'checkout', repo: 'acme/checkout' },
    ...over,
  });
  return { clock, db, gateway, tools, store, executePhase, job, incident };
}

const COUNTS = { modelCalls: 4, evidence: 2 }; // triage/correlate/hypotheses/summarize + 2 signals

describe('viability investigation executor', () => {
  it('runs the full loop in one unbounded tick and records each artifact once', async () => {
    const { db, gateway, tools, store, executePhase, job } = setup();

    const res = await runTick(db, { workerId: 'w1', clock: fixedClock(), phaseDelayMs: 0, executePhase });

    expect(res).toMatchObject({ claimed: 1, succeeded: 1 });
    expect((await db.getJob(job.id))?.state).toBe('succeeded');
    expect(gateway.calls).toEqual(['triage', 'correlate', 'hypotheses', 'summarize']);
    expect(tools.calls).toHaveLength(2);
    expect(store.modelCalls).toHaveLength(COUNTS.modelCalls);
    expect(store.evidence).toHaveLength(COUNTS.evidence);
  });

  it('is a no-op for a job not flagged as a viability run', async () => {
    const { db, gateway, store, executePhase } = setup({ trigger_summary: {} });
    await runTick(db, { workerId: 'w1', clock: fixedClock(), phaseDelayMs: 0, executePhase });
    expect(gateway.calls).toHaveLength(0);
    expect(store.modelCalls).toHaveLength(0);
  });

  it('de-duplicates a model call when a phase re-enters (mid-phase kill guard)', async () => {
    const { store, executePhase, job } = setup();
    await executePhase({ job, phaseKey: 'triage', attempt: 1 });
    await executePhase({ job, phaseKey: 'triage', attempt: 2 }); // resume re-enter
    expect(store.modelCalls.filter((m) => m.purpose === 'triage')).toHaveLength(1);
  });
});

describe('bounded phases per tick (resume via next_run_at)', () => {
  it('processes maxPhasesPerTick phases, requeues, and resumes to completion without duplication', async () => {
    const clock = fixedClock();
    const { db, gateway, store, executePhase, job } = setup();
    const opts = { workerId: 'w1', clock, phaseDelayMs: 0, executePhase, maxPhasesPerTick: 2 };

    const r1 = await runTick(db, opts);
    expect(r1).toMatchObject({ claimed: 1, requeued: 1 });
    const mid = await db.getJob(job.id);
    expect(mid?.state).toBe('queued'); // requeued, not running
    expect(mid?.next_run_at).toBeTruthy();
    expect(mid?.phases.filter((p) => p.state === 'succeeded')).toHaveLength(2);

    const r2 = await runTick(db, opts);
    expect(r2.requeued).toBe(1); // 2 more phases (4/5 done)
    const r3 = await runTick(db, opts);
    expect(r3.succeeded).toBe(1); // last phase

    const done = await db.getJob(job.id);
    expect(done?.state).toBe('succeeded');
    expect(done?.phases.every((p) => p.state === 'succeeded')).toBe(true);
    // Real work happened exactly once despite spanning three ticks.
    expect(gateway.calls).toEqual(['triage', 'correlate', 'hypotheses', 'summarize']);
    expect(store.modelCalls).toHaveLength(COUNTS.modelCalls);
    expect(store.evidence).toHaveLength(COUNTS.evidence);
  });
});

describe('interruption + resume', () => {
  it('resumes an abandoned (lease-expired) run from persisted phases without re-recording completed work', async () => {
    const clock = fixedClock();
    const { db, gateway, store, executePhase, incident } = setup();
    db.jobs.clear(); // drop setup()'s default due job; this test drives only the abandoned one
    // Simulate a crash after triage + gather_signals committed: those phases are
    // persisted as succeeded and their records already exist in the store.
    const job = db.seedJob({
      job_type: 'incident_investigation',
      target_type: 'incident',
      target_id: incident.id,
      state: 'running',
      locked_by: 'dead-worker',
      lease_expires_at: isoSeconds(addSeconds(clock.now(), -120)), // expired
      attempt_count: 1,
      trigger_summary: { mode: 'viability', service_name: 'checkout', repo: 'acme/checkout' },
      phases: [
        { key: 'triage', label: 'Triage', state: 'succeeded' },
        { key: 'gather_signals', label: 'Gather', state: 'succeeded' },
        { key: 'correlate', label: 'Correlate', state: 'pending' },
        { key: 'hypotheses', label: 'Hypotheses', state: 'pending' },
        { key: 'summarize', label: 'Summarize', state: 'pending' },
      ],
    });
    store.modelCalls.push({ jobId: job.id, purpose: 'triage' });
    store.evidence.push({ jobId: job.id, subjectKey: `${job.id}:github:list_recent_commits` });
    store.evidence.push({ jobId: job.id, subjectKey: `${job.id}:datadog:query_metric` });

    const res = await runTick(db, { workerId: 'w2', clock, phaseDelayMs: 0, executePhase });

    expect(res).toMatchObject({ claimed: 1, succeeded: 1 });
    expect((await db.getJob(job.id))?.state).toBe('succeeded');
    // Completed phases were not re-run; only the remaining 3 turns executed.
    expect(gateway.calls).toEqual(['correlate', 'hypotheses', 'summarize']);
    expect(store.modelCalls).toHaveLength(COUNTS.modelCalls); // triage not duplicated
    expect(store.evidence).toHaveLength(COUNTS.evidence); // signals not duplicated
  });

  it('retries a retryable gateway failure and resumes without duplicating prior records', async () => {
    const clock = fixedClock();
    const { db, gateway, store, executePhase, job } = setup();
    gateway.failOnce.set('correlate', 1); // first correlate turn throttles

    const r1 = await runTick(db, { workerId: 'w1', clock, phaseDelayMs: 0, executePhase });
    expect(r1.retrying).toBe(1);
    const mid = await db.getJob(job.id);
    expect(mid?.state).toBe('retrying');
    expect(mid?.next_run_at).toBeTruthy();
    expect(store.modelCalls).toHaveLength(1); // only triage recorded before the failure
    expect(store.evidence).toHaveLength(2); // gather_signals committed

    clock.advance(60); // past backoff
    const r2 = await runTick(db, { workerId: 'w1', clock, phaseDelayMs: 0, executePhase });
    expect(r2.succeeded).toBe(1);
    expect((await db.getJob(job.id))?.state).toBe('succeeded');
    // correlate was attempted twice but recorded once; nothing else duplicated.
    expect(gateway.calls.filter((c) => c === 'correlate')).toHaveLength(2);
    expect(store.modelCalls).toHaveLength(COUNTS.modelCalls);
    expect(store.evidence).toHaveLength(COUNTS.evidence);
  });

  it('a retryable failure in the LAST chunk still retries (bounded requeues do not burn the budget)', async () => {
    const clock = fixedClock();
    const { db, gateway, store, executePhase, job } = setup(); // max_attempts default 3
    gateway.failOnce.set('summarize', 1); // fails on the final phase, after 2 requeues
    const opts = { workerId: 'w1', clock, phaseDelayMs: 0, executePhase, maxPhasesPerTick: 2 };

    expect((await runTick(db, opts)).requeued).toBe(1); // triage, gather_signals
    expect((await runTick(db, opts)).requeued).toBe(1); // correlate, hypotheses
    const r3 = await runTick(db, opts); // summarize throttles
    // The two prior requeues must NOT have consumed the retry budget, so this is a
    // retry — not a terminal failure.
    expect(r3.retrying).toBe(1);
    const mid = await db.getJob(job.id);
    expect(mid?.state).toBe('retrying');
    expect(mid?.attempt_count).toBe(1); // still the first real attempt

    clock.advance(60);
    expect((await runTick(db, opts)).succeeded).toBe(1);
    expect((await db.getJob(job.id))?.state).toBe('succeeded');
    expect(store.modelCalls).toHaveLength(COUNTS.modelCalls); // no duplication
    expect(store.evidence).toHaveLength(COUNTS.evidence);
  });

  it('a failing persistence write surfaces as a retry, then resumes cleanly', async () => {
    const clock = fixedClock();
    const { db, store, executePhase, job } = setup();
    store.failRecordOnce.set('triage', 1); // first attempt to persist triage throws

    const r1 = await runTick(db, { workerId: 'w1', clock, phaseDelayMs: 0, executePhase });
    expect(r1.retrying).toBe(1);
    expect((await db.getJob(job.id))?.state).toBe('retrying');
    expect(store.modelCalls).toHaveLength(0); // nothing persisted on the failed write

    clock.advance(60);
    const r2 = await runTick(db, { workerId: 'w1', clock, phaseDelayMs: 0, executePhase });
    expect(r2.succeeded).toBe(1);
    expect(store.modelCalls).toHaveLength(COUNTS.modelCalls); // triage recorded once on resume
    expect(store.evidence).toHaveLength(COUNTS.evidence);
  });
});
