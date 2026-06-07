import { describe, expect, it, vi } from 'vitest';
import {
  buildEmission,
  emitReliabilitySignal,
  METRIC_JOB_ERROR,
  METRIC_JOB_RETRY,
  sanitizeTagValue,
  toDatadogTags,
  workflowFor,
  type DatadogSubmitter,
  type EmissionRecord,
  type EmissionStore,
  type JobFailureSignal,
  type TelemetryContext,
} from './telemetry';

const CTX: TelemetryContext = { service: 'instrument', environment: 'production' };

function signal(over: Partial<JobFailureSignal> = {}): JobFailureSignal {
  return {
    kind: 'retry',
    workspaceId: 'ws-1',
    jobId: 'job-abc',
    jobType: 'incident_investigation',
    attempt: 2,
    error: { retryable: true, code: 'rate_limited', summary: 'A dependency was rate limited.', source: 'truefoundry' },
    traceId: 'trace-xyz',
    requestId: 'req-123',
    ...over,
  };
}

describe('buildEmission — routing tags', () => {
  it('includes the required routing tags and never a raw job id', () => {
    const rec = buildEmission(CTX, signal());
    expect(rec.routingTags).toMatchObject({
      service: 'instrument',
      env: 'production',
      workflow: 'incident_investigation',
      job_type: 'incident_investigation',
      integration: 'truefoundry',
      error_code: 'rate_limited',
    });
    // Hard rule: no job id leaks into any tag.
    const allTagText = JSON.stringify(rec.tags) + rec.event.tags.join(',') + toDatadogTags(rec.routingTags).join(',');
    expect(allTagText).not.toContain('job-abc');
  });

  it('carries trace/request IDs in the stored + event tags, not in metric routing tags', () => {
    const rec = buildEmission(CTX, signal());
    expect(rec.tags.trace_id).toBe('trace-xyz');
    expect(rec.tags.request_id).toBe('req-123');
    // routing (metric) tags stay low-cardinality — no trace/request id.
    expect(rec.routingTags.trace_id).toBeUndefined();
    expect(rec.routingTags.request_id).toBeUndefined();
    // event carries them so the investigation can find the TrueFoundry evidence.
    expect(rec.event.tags).toContain('trace_id:trace-xyz');
    expect(rec.event.tags).toContain('request_id:req-123');
  });

  it('omits trace/request tags when not available', () => {
    const rec = buildEmission(CTX, signal({ traceId: null, requestId: null }));
    expect(rec.tags.trace_id).toBeUndefined();
    expect(rec.tags.request_id).toBeUndefined();
    expect(rec.traceId).toBeNull();
  });

  it('uses the stable metric names and a stable idempotency key', () => {
    expect(buildEmission(CTX, signal({ kind: 'retry' })).metricName).toBe(METRIC_JOB_RETRY);
    expect(buildEmission(CTX, signal({ kind: 'error' })).metricName).toBe(METRIC_JOB_ERROR);
    expect(buildEmission(CTX, signal({ jobId: 'j9', attempt: 3 })).idempotencyKey).toBe('j9:attempt-3');
  });

  it('hashes the job id in the event aggregation key — no raw job id reaches Datadog', () => {
    const rec = buildEmission(CTX, signal({ jobId: 'job-abc' }));
    expect(rec.event.aggregationKey).not.toContain('job-abc');
    expect(rec.event.aggregationKey.startsWith('instrument.job.retry:')).toBe(true);
    // stable for the same job (events thread together)
    expect(buildEmission(CTX, signal({ jobId: 'job-abc', attempt: 5 })).event.aggregationKey).toBe(rec.event.aggregationKey);
  });

  it('falls back to error.source for the integration tag and worker when absent', () => {
    expect(buildEmission(CTX, signal({ source: null, error: { retryable: false, code: 'worker_error', summary: 'x', source: null } })).routingTags.integration).toBe('worker');
    expect(buildEmission(CTX, signal({ source: 'datadog' })).routingTags.integration).toBe('datadog');
  });

  it('event text is redacted (no secret-shaped token survives)', () => {
    const rec = buildEmission(CTX, signal({ error: { retryable: true, code: 'rate_limited', summary: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 leaked', source: 'github' } }));
    expect(rec.event.text).not.toMatch(/ghp_/);
    expect(rec.event.text).toContain('‹redacted›');
  });
});

describe('toDatadogTags / sanitizeTagValue', () => {
  it('lowercases and sanitizes values, skips empties', () => {
    expect(sanitizeTagValue('Rate Limited!')).toBe('rate_limited_');
    expect(toDatadogTags({ a: 'X', b: '', c: 'y/z' })).toEqual(['a:x', 'c:y/z']);
  });
});

describe('workflowFor', () => {
  it('maps job types to stable workflow names', () => {
    expect(workflowFor('github_pr_review_analysis')).toBe('pr_review');
    expect(workflowFor('datadog_alert_generation')).toBe('monitor_draft');
  });
});

// --- submission orchestration ---------------------------------------------------

function fakeStore(initial?: { alreadySucceeded?: boolean }): EmissionStore & { reserved: EmissionRecord[]; finishes: { id: string; state: string; emittedAt: string | null }[] } {
  const reserved: EmissionRecord[] = [];
  const finishes: { id: string; state: string; emittedAt: string | null }[] = [];
  return {
    reserved,
    finishes,
    async reserve(rec) {
      reserved.push(rec);
      return { id: `row-${reserved.length}`, alreadySucceeded: initial?.alreadySucceeded ?? false };
    },
    async finish(id, state, emittedAt) {
      finishes.push({ id, state, emittedAt });
    },
  };
}

function fakeDatadog(over: Partial<DatadogSubmitter> = {}): DatadogSubmitter {
  return {
    enabled: true,
    submitMetric: vi.fn(async () => {}),
    submitEvent: vi.fn(async () => {}),
    ...over,
  };
}

const deps = (store: EmissionStore, datadog: DatadogSubmitter) => ({ store, datadog, now: () => new Date('2026-06-06T00:00:00.000Z') });

describe('emitReliabilitySignal', () => {
  it('submits the metric and event exactly once and finishes succeeded', async () => {
    const store = fakeStore();
    const dd = fakeDatadog();
    const res = await emitReliabilitySignal(deps(store, dd), CTX, signal());
    expect(res.outcome).toBe('succeeded');
    expect(dd.submitMetric).toHaveBeenCalledTimes(1);
    expect(dd.submitEvent).toHaveBeenCalledTimes(1);
    expect(dd.submitMetric).toHaveBeenCalledWith(METRIC_JOB_RETRY, 1, expect.arrayContaining(['workflow:incident_investigation', 'integration:truefoundry']));
    expect(store.finishes).toEqual([{ id: 'row-1', state: 'succeeded', emittedAt: '2026-06-06T00:00:00.000Z' }]);
  });

  it('skips Datadog entirely when the idempotency key already succeeded', async () => {
    const store = fakeStore({ alreadySucceeded: true });
    const dd = fakeDatadog();
    const res = await emitReliabilitySignal(deps(store, dd), CTX, signal());
    expect(res.outcome).toBe('skipped_duplicate');
    expect(dd.submitMetric).not.toHaveBeenCalled();
    expect(dd.submitEvent).not.toHaveBeenCalled();
    expect(store.finishes).toEqual([]); // already terminal; nothing to flip
  });

  it('records failed (does not throw) when Datadog submission errors', async () => {
    const store = fakeStore();
    const dd = fakeDatadog({ submitMetric: vi.fn(async () => { throw Object.assign(new Error('boom'), { code: 'datadog_http_500' }); }) });
    const res = await emitReliabilitySignal(deps(store, dd), CTX, signal());
    expect(res.outcome).toBe('failed');
    expect(res.error).toBe('datadog_http_500'); // redacted code, not the raw message
    expect(store.finishes).toEqual([{ id: 'row-1', state: 'failed', emittedAt: null }]);
  });

  it('event failure AFTER a 2xx metric still finishes succeeded (no metric double-send)', async () => {
    const store = fakeStore();
    const dd = fakeDatadog({ submitEvent: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'datadog_http_400' }); }) });
    const res = await emitReliabilitySignal(deps(store, dd), CTX, signal());
    expect(res.outcome).toBe('succeeded'); // the metric (the monitor signal) landed
    expect(res.eventError).toBe('datadog_http_400');
    expect(dd.submitMetric).toHaveBeenCalledTimes(1);
    expect(store.finishes).toEqual([{ id: 'row-1', state: 'succeeded', emittedAt: '2026-06-06T00:00:00.000Z' }]);
  });

  it('disabled (mock) sink: persists the row succeeded with NULL emitted_at and never calls Datadog', async () => {
    const store = fakeStore();
    const dd = fakeDatadog({ enabled: false });
    const res = await emitReliabilitySignal(deps(store, dd), CTX, signal());
    expect(res).toMatchObject({ outcome: 'succeeded', mock: true });
    expect(dd.submitMetric).not.toHaveBeenCalled();
    expect(dd.submitEvent).not.toHaveBeenCalled();
    // emitted_at NULL distinguishes a never-submitted mock row from a real us5 2xx.
    expect(store.finishes).toEqual([{ id: 'row-1', state: 'succeeded', emittedAt: null }]);
  });

  it('does not leak a raw error message into the result on an unshaped metric throw', async () => {
    const store = fakeStore();
    const dd = fakeDatadog({ submitMetric: vi.fn(async () => { throw new Error('Authorization: Bearer secret123456789'); }) });
    const res = await emitReliabilitySignal(deps(store, dd), CTX, signal());
    expect(res.outcome).toBe('failed');
    expect(res.error).toBe('datadog_submit_failed');
  });
});
