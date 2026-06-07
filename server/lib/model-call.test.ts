import { describe, expect, it } from 'vitest';
import {
  runModelCall,
  summarizeToolCalls,
  type AgentInvokeRequest,
  type AgentInvokeResult,
  type AgentInvoker,
  type EvidenceRow,
  type ModelCallRow,
  type ModelCallStore,
} from './model-call';
import { SchemaRegistry, assertValidForDisplay, assertValidForExternalPosting, z } from './schema-validation';

// A fixed gateway result; tests override per case.
class FakeInvoker implements AgentInvoker {
  requests: AgentInvokeRequest[] = [];
  constructor(
    private readonly impl: (req: AgentInvokeRequest) => AgentInvokeResult | Promise<AgentInvokeResult>,
  ) {}
  async invoke(req: AgentInvokeRequest): Promise<AgentInvokeResult> {
    this.requests.push(req);
    return this.impl(req);
  }
}

// In-memory store that mints ids and can simulate a unique-constraint dedup.
class FakeStore implements ModelCallStore {
  modelCalls: (ModelCallRow & { id: string })[] = [];
  evidence: EvidenceRow[] = [];
  dedupKeys = new Set<string>(); // `${jobId}:${purpose}` that should report deduped
  private seq = 0;
  async saveModelCall(row: ModelCallRow): Promise<{ id: string; deduped: boolean }> {
    const key = `${row.jobId}:${row.purpose}`;
    if (row.jobId && this.dedupKeys.has(key)) {
      const existing = this.modelCalls.find((m) => m.jobId === row.jobId && m.purpose === row.purpose);
      if (existing) return { id: existing.id, deduped: true };
    }
    const id = `mc_${++this.seq}`;
    this.modelCalls.push({ ...row, id });
    return { id, deduped: false };
  }
  async saveEvidence(rows: EvidenceRow[]): Promise<void> {
    this.evidence.push(...rows);
  }
}

const NOW = () => new Date('2026-06-06T12:00:00.000Z');
const baseSpec = {
  workspaceId: 'ws1',
  integrationId: 'int1',
  jobId: 'job1',
  purpose: 'summarize',
  gatewayBaseUrlName: 'truefoundry',
};

describe('runModelCall — non-tool response (AC1)', () => {
  it('persists one full ai_model_calls row with usage, latency, ids, and validation', async () => {
    const registry = new SchemaRegistry().register(
      'summary.v1',
      z.object({ cause: z.string().min(1), next_step: z.string().min(1) }),
    );
    const invoker = new FakeInvoker(() => ({
      text: '```json\n{"cause":"pool exhaustion","next_step":"raise pool size"}\n```',
      model: 'gemini-3.5-flash',
      provider: 'google',
      responseId: 'resp_abc',
      traceId: 'trace_1',
      spanId: 'span_1',
      inputTokens: 40,
      outputTokens: 60,
      totalTokens: 100,
      costUsd: 0.0001,
      latencyMs: 2100,
    }));
    const store = new FakeStore();

    const out = await runModelCall(
      { gateway: invoker, store, registry, now: NOW },
      {
        ...baseSpec,
        request: { apiSurface: 'agent_chat_completions', messages: [{ role: 'user', content: 'summarize' }], maxTokens: 240 },
        outputSchemaVersion: 'summary.v1',
        requestSchemaVersion: 'req.v1',
      },
    );

    expect(out.validation.status).toBe('valid');
    expect(out.modelCallId).toBe('mc_1');
    expect(store.modelCalls).toHaveLength(1);
    const row = store.modelCalls[0];
    expect(row.status).toBe('succeeded');
    expect(row.apiSurface).toBe('agent_chat_completions');
    expect(row.providerName).toBe('google');
    expect(row.modelName).toBe('gemini-3.5-flash');
    expect(row.responseId).toBe('resp_abc');
    expect(row.traceId).toBe('trace_1');
    expect(row.spanId).toBe('span_1');
    expect(row.inputTokens).toBe(40);
    expect(row.totalTokens).toBe(100);
    expect(row.costUsd).toBe(0.0001);
    expect(row.latencyMs).toBe(2100);
    expect(row.validationStatus).toBe('valid');
    expect(row.outputSchemaVersion).toBe('summary.v1');
    expect(row.requestSchemaVersion).toBe('req.v1');
    expect(row.gatewayBaseUrlName).toBe('truefoundry');
    expect(row.inputHash).toMatch(/^[a-f0-9]{8,}$/);
    expect(row.toolCallsRedacted).toEqual([]);
    expect(store.evidence).toHaveLength(0);
    // The valid output may be displayed and posted.
    expect(() => assertValidForDisplay(out.validation)).not.toThrow();
    expect(() => assertValidForExternalPosting(out.validation)).not.toThrow();
  });

  it('freeform output (no schema) is not_applicable: displayable, not postable', async () => {
    const invoker = new FakeInvoker(() => ({ text: 'check the deploy first', model: 'm', provider: 'p', latencyMs: 5 }));
    const store = new FakeStore();
    const out = await runModelCall(
      { gateway: invoker, store, now: NOW },
      { ...baseSpec, purpose: 'triage', request: { apiSurface: 'agent_chat_completions', messages: [{ role: 'user', content: 'triage' }] } },
    );
    expect(out.validation.status).toBe('not_applicable');
    expect(store.modelCalls[0].validationStatus).toBe('not_applicable');
    expect(() => assertValidForDisplay(out.validation)).not.toThrow();
    expect(() => assertValidForExternalPosting(out.validation)).toThrow();
  });
});

describe('runModelCall — streamed tool loop (AC2)', () => {
  it('stores bounded tool_calls_redacted and cited evidence linked to the call', async () => {
    const invoker = new FakeInvoker(() => ({
      text: 'investigation complete',
      model: 'gemini-3.5-flash',
      provider: 'google',
      latencyMs: 9000,
      toolCalls: [
        { server: 'github', tool: 'list_commits', args: { repo: 'pchen41/instrument' }, result: { commits: 3 }, status: 'ok', latencyMs: 420 },
        { server: 'datadog', tool: 'query_metric', args: { metric: 'p95', big: 'x'.repeat(5000) }, result: { series: 'y'.repeat(5000) }, status: 'ok', latencyMs: 610 },
      ],
      evidence: [
        {
          subjectKey: 'job1:github:list_commits',
          sourceType: 'commit',
          sourceProvider: 'github',
          claimType: 'recent_change',
          externalId: 'sha_a1b2c3',
          title: 'Recent deploy',
          summary: 'pool size bump merged 40m before alert',
          payload: { sha: 'a1b2c3' },
        },
        {
          subjectKey: 'job1:datadog:query_metric',
          sourceType: 'datadog_metric',
          sourceProvider: 'datadog',
          claimType: 'latency_signal',
          externalId: 'metric_p95',
          title: 'p95 breach',
          summary: 'p95 rose 180ms→920ms',
          payload: { series: [180, 920] },
        },
      ],
    }));
    const store = new FakeStore();

    await runModelCall(
      { gateway: invoker, store, now: NOW },
      {
        ...baseSpec,
        purpose: 'investigate',
        subjectType: 'incident',
        subjectId: 'inc1',
        request: {
          apiSurface: 'agent_responses',
          messages: [{ role: 'user', content: 'investigate' }],
          mcpServers: [{ name: 'github' }, { name: 'datadog', fqn: 'peterc:datadog' }],
          agentIterationLimit: 6,
        },
      },
    );

    const row = store.modelCalls[0];
    expect(row.apiSurface).toBe('agent_responses');
    expect(row.agentIterationLimit).toBe(6);
    expect(row.mcpServersRequested).toEqual([{ name: 'github' }, { name: 'datadog', fqn: 'peterc:datadog' }]);
    // tool calls are summarized + bounded (args/result truncated well under raw 5000 chars).
    expect(row.toolCallsRedacted).toHaveLength(2);
    expect(row.toolCallsRedacted[0]).toMatchObject({ server: 'github', tool: 'list_commits', status: 'ok', latency_ms: 420 });
    expect(row.toolCallsRedacted[1].args_summary!.length).toBeLessThanOrEqual(401);
    expect(row.toolCallsRedacted[1].result_summary!.length).toBeLessThanOrEqual(601);

    // evidence persisted, linked to the model call, with content hashes + subject.
    expect(store.evidence).toHaveLength(2);
    expect(store.evidence.every((e) => e.aiModelCallId === row.id)).toBe(true);
    expect(store.evidence[0]).toMatchObject({ sourceProvider: 'github', subjectType: 'incident', subjectId: 'inc1', collectedByJobId: 'job1' });
    expect(store.evidence[0].contentHash).toMatch(/^[a-f0-9]{8,}$/);
  });
});

describe('runModelCall — invalid structured output (AC4)', () => {
  it('marks the row invalid and the gates refuse display + posting', async () => {
    const registry = new SchemaRegistry().register('summary.v1', z.object({ cause: z.string(), next_step: z.string() }));
    const invoker = new FakeInvoker(() => ({ text: '{"cause":"x"}', model: 'm', provider: 'p', latencyMs: 5 }));
    const store = new FakeStore();
    const out = await runModelCall(
      { gateway: invoker, store, registry, now: NOW },
      { ...baseSpec, request: { apiSurface: 'agent_chat_completions', messages: [{ role: 'user', content: 'x' }] }, outputSchemaVersion: 'summary.v1' },
    );
    expect(out.validation.status).toBe('invalid');
    expect(store.modelCalls[0].validationStatus).toBe('invalid');
    expect(() => assertValidForDisplay(out.validation)).toThrow();
    expect(() => assertValidForExternalPosting(out.validation)).toThrow();
  });

  it('unparseable output (not JSON) is invalid, not a crash', async () => {
    const registry = new SchemaRegistry().register('summary.v1', z.object({ cause: z.string() }));
    const invoker = new FakeInvoker(() => ({ text: 'sorry, I cannot help with that', model: 'm', provider: 'p', latencyMs: 5 }));
    const store = new FakeStore();
    const out = await runModelCall(
      { gateway: invoker, store, registry, now: NOW },
      { ...baseSpec, request: { apiSurface: 'agent_chat_completions', messages: [{ role: 'user', content: 'x' }] }, outputSchemaVersion: 'summary.v1' },
    );
    expect(out.validation.status).toBe('invalid');
    expect(store.modelCalls[0].validationStatus).toBe('invalid');
  });
});

describe('runModelCall — failure + idempotency', () => {
  it('persists a failed row (sanitized) before rethrowing', async () => {
    const invoker = new FakeInvoker(() => {
      throw Object.assign(new Error('provider PII leaked here'), { code: 'gateway_http_429', summary: 'Gateway returned HTTP 429.' });
    });
    const store = new FakeStore();
    await expect(
      runModelCall(
        { gateway: invoker, store, now: NOW },
        { ...baseSpec, request: { apiSurface: 'agent_chat_completions', messages: [{ role: 'user', content: 'x' }] } },
      ),
    ).rejects.toThrow();
    expect(store.modelCalls).toHaveLength(1);
    const row = store.modelCalls[0];
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('gateway_http_429');
    expect(row.errorSummary).toBe('Gateway returned HTTP 429.');
    expect(row.errorSummary).not.toMatch(/PII/);
    expect(store.evidence).toHaveLength(0);
  });

  it('reports deduped when the store hits the (job_id, purpose) unique index', async () => {
    const invoker = new FakeInvoker(() => ({ text: 'ok', model: 'm', provider: 'p', latencyMs: 5 }));
    const store = new FakeStore();
    // Seed an existing row, then mark the key as one the store should dedup.
    await store.saveModelCall({
      workspaceId: 'ws1', jobId: 'job1', purpose: 'summarize', apiSurface: 'agent_chat_completions', status: 'succeeded',
      mcpServersRequested: [], toolCallsRedacted: [], inputHash: 'seed', outputRedacted: 'seed', validationStatus: 'not_applicable', startedAt: NOW().toISOString(),
    });
    store.dedupKeys.add('job1:summarize');
    const out = await runModelCall(
      { gateway: invoker, store, now: NOW },
      { ...baseSpec, request: { apiSurface: 'agent_chat_completions', messages: [{ role: 'user', content: 'x' }] } },
    );
    expect(out.deduped).toBe(true);
    expect(out.modelCallId).toBe('mc_1');
  });
});

describe('summarizeToolCalls', () => {
  it('caps the number of tool calls', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ server: 'github', tool: `t${i}`, status: 'ok' as const }));
    expect(summarizeToolCalls(many)).toHaveLength(20);
    expect(summarizeToolCalls(many, { maxToolCalls: 3, maxArgsChars: 10, maxResultChars: 10 })).toHaveLength(3);
  });

  it('truncates long args and results and preserves status/error', () => {
    const [s] = summarizeToolCalls([
      { server: 'datadog', tool: 'q', args: { x: 'a'.repeat(1000) }, result: 'b'.repeat(1000), status: 'error', errorSummary: 'c'.repeat(1000), latencyMs: 10 },
    ]);
    expect(s.args_summary!.length).toBeLessThanOrEqual(401);
    expect(s.result_summary!.length).toBeLessThanOrEqual(601);
    expect(s.error_summary!.length).toBeLessThanOrEqual(601);
    expect(s.status).toBe('error');
    expect(s.latency_ms).toBe(10);
  });
});
