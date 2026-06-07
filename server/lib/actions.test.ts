import { beforeEach, describe, expect, it } from 'vitest';
import { handleAction, type ActionContext } from './actions';
import { FakeDb, fixedClock } from './fake-db';

let db: FakeDb;
let ctx: ActionContext;

beforeEach(() => {
  db = new FakeDb();
  db.seedWorkspace('ws-1', 'user-1');
  ctx = { userId: 'user-1', clock: fixedClock() };
});

describe('start_investigation', () => {
  it('enqueues a durable job, links it to the incident, and is idempotent on a repeat', async () => {
    db.seedIncident({ id: 'inc-1', workspace_id: 'ws-1' });

    const first = await handleAction(db, ctx, { action: 'start_investigation', incident_id: 'inc-1' });
    expect(first).toMatchObject({ ok: true, deduped: false });
    const incident = await db.getIncident('inc-1');
    expect(incident?.investigation_job_id).toBe(first.job_id);

    const second = await handleAction(db, ctx, { action: 'start_investigation', incident_id: 'inc-1' });
    expect(second).toMatchObject({ ok: true, job_id: first.job_id, deduped: true });
    expect([...db.jobs.values()].filter((j) => j.target_id === 'inc-1')).toHaveLength(1);
  });

  it('rejects starting when an investigation already exists', async () => {
    const job = db.seedJob({ workspace_id: 'ws-1', state: 'running' });
    db.seedIncident({ id: 'inc-1', workspace_id: 'ws-1', investigation_job_id: job.id });
    await expect(
      handleAction(db, ctx, { action: 'start_investigation', incident_id: 'inc-1' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a non-member and a missing incident', async () => {
    db.seedIncident({ id: 'inc-other', workspace_id: 'ws-2' }); // user-1 is not a member of ws-2
    await expect(
      handleAction(db, ctx, { action: 'start_investigation', incident_id: 'inc-other' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      handleAction(db, ctx, { action: 'start_investigation', incident_id: 'nope' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('retry_job', () => {
  it('re-queues a safe failed job with a fresh budget and preserved phases', async () => {
    const job = db.seedJob({
      workspace_id: 'ws-1',
      state: 'failed',
      safe_to_retry: true,
      attempt_count: 3,
      max_attempts: 3,
      error_code: 'rate_limited',
      phases: [{ key: 'triage', label: 'Reading the alert', state: 'succeeded' }],
    });

    const res = await handleAction(db, ctx, { action: 'retry_job', job_id: job.id });
    expect(res).toMatchObject({ ok: true, job_id: job.id });
    const after = await db.getJob(job.id);
    expect(after?.state).toBe('queued');
    expect(after?.next_run_at).toBeTruthy();
    expect(after?.max_attempts).toBeGreaterThan(3); // fresh attempt budget
    expect(after?.error_code).toBeNull();
    expect(after?.phases).toHaveLength(1); // preserved
  });

  it('adds a fixed retry budget so repeated manual retries do not compound', async () => {
    // A job that already retried once (attempt 6 / max 6). The next retry must add
    // the configured per-retry budget (3) → 9, not double to 12.
    const job = db.seedJob({ workspace_id: 'ws-1', state: 'failed', safe_to_retry: true, attempt_count: 6, max_attempts: 6 });
    await handleAction(db, ctx, { action: 'retry_job', job_id: job.id });
    expect((await db.getJob(job.id))?.max_attempts).toBe(9);
  });

  it('rejects retrying a job that is not safely failed', async () => {
    const running = db.seedJob({ workspace_id: 'ws-1', state: 'running' });
    await expect(handleAction(db, ctx, { action: 'retry_job', job_id: running.id })).rejects.toMatchObject({
      status: 409,
    });
    const unsafe = db.seedJob({ workspace_id: 'ws-1', state: 'failed', safe_to_retry: false });
    await expect(handleAction(db, ctx, { action: 'retry_job', job_id: unsafe.id })).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('set_recommendation_state', () => {
  it('dismisses and restores, rejecting an illegal transition', async () => {
    const rec = db.seedRecommendation({ id: 'rec-1', workspace_id: 'ws-1', state: 'active' });
    await handleAction(db, ctx, { action: 'set_recommendation_state', recommendation_id: 'rec-1', state: 'dismissed' });
    expect((await db.getRecommendation('rec-1'))?.state).toBe('dismissed');
    expect((await db.getRecommendation('rec-1'))?.dismissed_at).toBeTruthy();

    await handleAction(db, ctx, { action: 'set_recommendation_state', recommendation_id: 'rec-1', state: 'active' });
    expect((await db.getRecommendation('rec-1'))?.state).toBe('active');

    db.seedRecommendation({ id: 'rec-accepted', workspace_id: 'ws-1', state: 'accepted' });
    await expect(
      handleAction(db, ctx, { action: 'set_recommendation_state', recommendation_id: 'rec-accepted', state: 'active' }),
    ).rejects.toMatchObject({ status: 409 });
    void rec;
  });
});

describe('set_investigation_mode', () => {
  it('updates a valid mode and rejects bad input / missing workspace', async () => {
    await expect(
      handleAction(db, ctx, { action: 'set_investigation_mode', workspace_id: 'ws-1', mode: 'auto' }),
    ).resolves.toMatchObject({ ok: true, investigation_start_mode: 'auto' });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleAction(db, ctx, { action: 'set_investigation_mode', workspace_id: 'ws-1', mode: 'bogus' as any }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      handleAction(db, ctx, { action: 'set_investigation_mode', workspace_id: 'ws-x', mode: 'auto' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('approval + generation enqueue', () => {
  const payload = { branch: 'fix-rate-limit' };

  it('runs request → approve → enqueue, idempotently', async () => {
    db.seedRecommendation({ id: 'rec-1', workspace_id: 'ws-1', state: 'active' });

    const req = await handleAction(db, ctx, {
      action: 'request_approval',
      target_type: 'recommendation',
      target_id: 'rec-1',
      action_type: 'generate_pr',
      approval_summary: 'Open a PR adding the trace span',
      payload,
    });
    expect(req.ok).toBe(true);
    const approvalId = req.approval_id as string;

    // Duplicate request reuses the active approval.
    const dupReq = await handleAction(db, ctx, {
      action: 'request_approval',
      target_type: 'recommendation',
      target_id: 'rec-1',
      action_type: 'generate_pr',
      approval_summary: 'again',
      payload,
    });
    expect(dupReq).toMatchObject({ approval_id: approvalId, deduped: true });

    await handleAction(db, ctx, { action: 'decide_approval', approval_id: approvalId, decision: 'approved', payload });

    // Duplicate decide_approval is idempotent and succeeds when payload matches
    const dupDecide = await handleAction(db, ctx, { action: 'decide_approval', approval_id: approvalId, decision: 'approved', payload });
    expect(dupDecide).toMatchObject({ ok: true, state: 'approved' });

    // Duplicate decide_approval throws stale_payload if payload changes
    await expect(
      handleAction(db, ctx, { action: 'decide_approval', approval_id: approvalId, decision: 'approved', payload: { branch: 'something-else' } }),
    ).rejects.toMatchObject({ status: 409, code: 'stale_payload' });

    const enq = await handleAction(db, ctx, { action: 'enqueue_generation', approval_id: approvalId });
    expect(enq).toMatchObject({ ok: true, deduped: false });
    expect((await db.getJob(enq.job_id as string))?.job_type).toBe('recommendation_pr_generation');

    const enq2 = await handleAction(db, ctx, { action: 'enqueue_generation', approval_id: approvalId });
    expect(enq2).toMatchObject({ job_id: enq.job_id, deduped: true });
  });

  it('rejects an approval whose payload changed (stale hash) and enqueue before approval', async () => {
    db.seedRecommendation({ id: 'rec-1', workspace_id: 'ws-1', state: 'active' });
    const req = await handleAction(db, ctx, {
      action: 'request_approval',
      target_type: 'recommendation',
      target_id: 'rec-1',
      action_type: 'generate_pr',
      approval_summary: 'Open a PR',
      payload,
    });
    const approvalId = req.approval_id as string;

    await expect(
      handleAction(db, ctx, {
        action: 'decide_approval',
        approval_id: approvalId,
        decision: 'approved',
        payload: { branch: 'something-else' },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'stale_payload' });

    // Still 'requested' (approval did not transition) → enqueue is rejected.
    await expect(
      handleAction(db, ctx, { action: 'enqueue_generation', approval_id: approvalId }),
    ).rejects.toMatchObject({ status: 409, code: 'not_approved' });
  });

  it('binds a provided target_step_key to a real, kind-compatible step', async () => {
    db.seedRecommendation({
      id: 'rec-step',
      workspace_id: 'ws-1',
      state: 'active',
      steps: [{ key: 'generate-pr', kind: 'code_pr', state: 'available' }],
    });

    // A forged/unknown step key is rejected.
    await expect(
      handleAction(db, ctx, {
        action: 'request_approval',
        target_type: 'recommendation',
        target_id: 'rec-step',
        target_step_key: 'no-such-step',
        action_type: 'generate_pr',
        approval_summary: 'x',
        payload,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'step_not_found' });

    // A real step of an incompatible kind for the action is rejected.
    db.seedRecommendation({
      id: 'rec-mon',
      workspace_id: 'ws-1',
      state: 'active',
      steps: [{ key: 'create-monitor', kind: 'datadog_new_monitor', state: 'available' }],
    });
    await expect(
      handleAction(db, ctx, {
        action: 'request_approval',
        target_type: 'recommendation',
        target_id: 'rec-mon',
        target_step_key: 'create-monitor',
        action_type: 'generate_pr',
        approval_summary: 'x',
        payload,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'step_kind_mismatch' });

    // The matching code_pr step is accepted.
    const ok = await handleAction(db, ctx, {
      action: 'request_approval',
      target_type: 'recommendation',
      target_id: 'rec-step',
      target_step_key: 'generate-pr',
      action_type: 'generate_pr',
      approval_summary: 'ok',
      payload,
    });
    expect(ok.ok).toBe(true);
  });

  it('rejects approvals for a workspace the user is not a member of', async () => {
    db.seedRecommendation({ id: 'rec-2', workspace_id: 'ws-2', state: 'active' });
    await expect(
      handleAction(db, ctx, {
        action: 'request_approval',
        target_type: 'recommendation',
        target_id: 'rec-2',
        action_type: 'generate_pr',
        approval_summary: 'x',
        payload,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
