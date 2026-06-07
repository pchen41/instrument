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

// Real UUIDs (reused from the dev DB) — the FakeStore enforces uuid + NOT NULL to
// mirror the actual ai_model_calls/evidence_items schema, so a row the real
// Postgres would reject also fails here.
const WS = '051048f8-a226-4126-91a7-33fa150c7abb';
const JOB = 'fc6094d5-537a-4af5-a1a7-4f4898ebcf60';
const INC = 'd842df66-4a5f-48ab-9220-f8b2b3310a18';
const INT = 'cd9e2c06-5707-486f-9637-2c554e269c64';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class FakeInvoker implements AgentInvoker {
  requests: AgentInvokeRequest[] = [];
  constructor(private readonly impl: (req: AgentInvokeRequest) => AgentInvokeResult | Promise<AgentInvokeResult>) {}
  async invoke(req: AgentInvokeRequest): Promise<AgentInvokeResult> {
    this.requests.push(req);
    return this.impl(req);
  }
}

type Persisted = ModelCallRow & { id: string };

/**
 * In-memory store that ENFORCES the real schema contract: NOT NULL + uuid checks,
 * the store's sentinel coercions (model_name / schema versions / integration), and
 * the (job_id, purpose) upsert (a later success overwrites an earlier failure).
 */
class FakeStore implements ModelCallStore {
  modelCalls: Persisted[] = [];
  evidence: EvidenceRow[] = [];
  private seq = 0;

  async saveModelCall(row: ModelCallRow): Promise<{ id: string; deduped: boolean }> {
    requireNonEmpty('ai_model_calls', { workspace_id: row.workspaceId, purpose: row.purpose, api_surface: row.apiSurface, input_hash: row.inputHash, validation_status: row.validationStatus, status: row.status, started_at: row.startedAt });
    requireUuid('ai_model_calls.job_id', row.jobId);
    const persisted: Persisted = {
      ...row,
      integrationId: row.integrationId ?? INT,
      modelName: row.modelName ?? 'unknown',
      requestSchemaVersion: row.requestSchemaVersion ?? 'none',
      outputSchemaVersion: row.outputSchemaVersion ?? 'none',
      id: '',
    };
    requireUuid('ai_model_calls.integration_id', persisted.integrationId!);
    const existing = this.modelCalls.find((m) => m.jobId === row.jobId && m.purpose === row.purpose);
    if (existing) {
      if (row.status === 'succeeded') Object.assign(existing, persisted, { id: existing.id }); // upsert failed→succeeded
      return { id: existing.id, deduped: true };
    }
    persisted.id = `mc_${++this.seq}`;
    this.modelCalls.push(persisted);
    return { id: persisted.id, deduped: false };
  }

  async saveEvidence(rows: EvidenceRow[]): Promise<void> {
    for (const r of rows) {
      requireNonEmpty('evidence_items', { workspace_id: r.workspaceId, ai_model_call_id: r.aiModelCallId, subject_type: r.subjectType, claim_type: r.claimType, content_hash: r.contentHash, source_type: r.sourceType, collected_at: r.collectedAt });
      requireUuid('evidence_items.subject_id', r.subjectId);
    }
    this.evidence.push(...rows);
  }
}

function requireNonEmpty(table: string, fields: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === '') throw new Error(`${table}.${k} violates NOT NULL`);
  }
}
function requireUuid(col: string, v: unknown): void {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new Error(`${col} must be a uuid (got ${String(v)})`);
}

const NOW = () => new Date('2026-06-06T12:00:00.000Z');
const baseSpec = { workspaceId: WS, integrationId: INT, jobId: JOB, purpose: 'summarize', gatewayBaseUrlName: 'truefoundry' };

describe('runModelCall — non-tool response (AC1)', () => {
  it('persists one full ai_model_calls row with usage, latency, ids, and validation', async () => {
    const registry = new SchemaRegistry().register('summary.v1', z.object({ cause: z.string().min(1), next_step: z.string().min(1) }));
    const invoker = new FakeInvoker(() => ({
      text: '```json\n{"cause":"pool exhaustion","next_step":"raise pool size"}\n```',
      model: 'gemini-3.5-flash', provider: 'google', responseId: 'resp_abc', traceId: 'trace_1', spanId: 'span_1',
      inputTokens: 40, outputTokens: 60, totalTokens: 100, costUsd: 0.0001, latencyMs: 2100,
    }));
    const store = new FakeStore();
    const out = await runModelCall(
      { gateway: invoker, store, registry, now: NOW },
      { ...baseSpec, request: { apiSurface: 'agent_chat_completions', messages: [{ role: 'user', content: 'summarize' }], maxTokens: 240 }, outputSchemaVersion: 'summary.v1', requestSchemaVersion: 'req.v1' },
    );

    expect(out.validation.status).toBe('valid');
    expect(out.modelCallId).toBe('mc_1');
    const row = store.modelCalls[0];
    expect(row.status).toBe('succeeded');
    expect(row.apiSurface).toBe('agent_chat_completions');
    expect(row.providerName).toBe('google');
    expect(row.modelName).toBe('gemini-3.5-flash');
    expect(row.responseId).toBe('resp_abc');
    expect(row.traceId).toBe('trace_1');
    expect(row.spanId).toBe('span_1');
    expect(row.totalTokens).toBe(100);
    expect(row.costUsd).toBe(0.0001);
    expect(row.latencyMs).toBe(2100);
    expect(row.validationStatus).toBe('valid');
    expect(row.outputSchemaVersion).toBe('summary.v1');
    expect(row.inputHash).toMatch(/^[a-f0-9]{8,}$/);
    expect(row.toolCallsRedacted).toEqual([]);
    expect(store.evidence).toHaveLength(0);
    expect(() => assertValidForDisplay(out.validation)).not.toThrow();
    expect(() => assertValidForExternalPosting(out.validation)).not.toThrow();
  });

  it('freeform output (no schema) is not_applicable: displayable, not postable; NOT NULL schema versions are coerced', async () => {
    const invoker = new FakeInvoker(() => ({ text: 'check the deploy first', model: 'm', provider: 'p', latencyMs: 5 }));
    const store = new FakeStore();
    const out = await runModelCall(
      { gateway: invoker, store, now: NOW },
      { ...baseSpec, purpose: 'triage', request: { apiSurface: 'agent_chat_completions', messages: [{ role: 'user', content: 'triage' }] } },
    );
    expect(out.validation.status).toBe('not_applicable');
    const row = store.modelCalls[0];
    expect(row.validationStatus).toBe('not_applicable');
    expect(row.requestSchemaVersion).toBe('none'); // coerced, not null
    expect(row.outputSchemaVersion).toBe('none');
    expect(() => assertValidForDisplay(out.validation)).not.toThrow();
    expect(() => assertValidForExternalPosting(out.validation)).toThrow();
  });
});

describe('runModelCall — streamed tool loop (AC2)', () => {
  it('stores bounded+scrubbed tool_calls_redacted and cited evidence linked to the call', async () => {
    const invoker = new FakeInvoker(() => ({
      text: 'investigation complete', model: 'gemini-3.5-flash', provider: 'google', latencyMs: 9000,
      toolCalls: [
        { server: 'github', tool: 'list_commits', args: { repo: 'pchen41/instrument' }, result: { commits: 3 }, status: 'ok', latencyMs: 420 },
        { server: 'datadog', tool: 'query_metric', args: { metric: 'p95', big: 'x'.repeat(5000) }, result: { series: 'y'.repeat(5000) }, status: 'ok', latencyMs: 610 },
      ],
      evidence: [
        { subjectKey: 'job:github:list_commits', sourceType: 'commit', sourceProvider: 'github', claimType: 'recent_change', externalId: 'sha_a1b2c3', title: 'Recent deploy', summary: 'pool size bump merged 40m before alert', payload: { sha: 'a1b2c3' } },
        { subjectKey: 'job:datadog:query_metric', sourceType: 'datadog_metric', sourceProvider: 'datadog', claimType: 'latency_signal', externalId: 'metric_p95', title: 'p95 breach', summary: 'p95 rose 180ms→920ms', payload: { series: [180, 920] } },
      ],
    }));
    const store = new FakeStore();
    await runModelCall(
      { gateway: invoker, store, now: NOW },
      { ...baseSpec, purpose: 'investigate', subjectType: 'incident', subjectId: INC, request: { apiSurface: 'agent_responses', messages: [{ role: 'user', content: 'investigate' }], mcpServers: [{ name: 'github' }, { name: 'datadog', fqn: 'peterc:datadog' }], agentIterationLimit: 6 } },
    );

    const row = store.modelCalls[0];
    expect(row.apiSurface).toBe('agent_responses');
    expect(row.agentIterationLimit).toBe(6);
    expect(row.mcpServersRequested).toEqual([{ name: 'github' }, { name: 'datadog', fqn: 'peterc:datadog' }]);
    expect(row.toolCallsRedacted).toHaveLength(2);
    expect(row.toolCallsRedacted[0]).toMatchObject({ server: 'github', tool: 'list_commits', status: 'ok', latency_ms: 420 });
    expect(row.toolCallsRedacted[1].args_summary!.length).toBeLessThanOrEqual(401);
    expect(row.toolCallsRedacted[1].result_summary!.length).toBeLessThanOrEqual(601);

    expect(store.evidence).toHaveLength(2);
    expect(store.evidence.every((e) => e.aiModelCallId === row.id)).toBe(true);
    expect(store.evidence[0]).toMatchObject({ sourceProvider: 'github', subjectType: 'incident', subjectId: INC, collectedByJobId: JOB });
    expect(store.evidence[0].contentHash).toMatch(/^[a-f0-9]{8,}$/);
    expect(store.evidence[0].observedAt).toBe(store.evidence[0].collectedAt); // both default to completion time here
  });

  it('rejects evidence without a UUID subject (no half-write of the model call)', async () => {
    const invoker = new FakeInvoker(() => ({
      text: 'x', model: 'm', provider: 'p', latencyMs: 5,
      evidence: [{ subjectKey: 'k', sourceType: 'commit', sourceProvider: 'github', claimType: 'c', externalId: 'e', title: 't', summary: 's', payload: {} }],
    }));
    const store = new FakeStore();
    await expect(
      runModelCall({ gateway: invoker, store, now: NOW }, { ...baseSpec, request: { apiSurface: 'agent_responses', messages: [{ role: 'user', content: 'x' }] } }),
    ).rejects.toThrow(/UUID subject/);
    expect(store.modelCalls).toHaveLength(0);
    expect(store.evidence).toHaveLength(0);
  });

  it('scrubs secret-shaped values out of tool_calls_redacted', async () => {
    const invoker = new FakeInvoker(() => ({
      text: 'ok', model: 'm', provider: 'p', latencyMs: 5,
      toolCalls: [{ server: 'github', tool: 'get_me', args: { auth: 'Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' }, result: 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', status: 'ok' }],
    }));
    const store = new FakeStore();
    await runModelCall({ gateway: invoker, store, now: NOW }, { ...baseSpec, request: { apiSurface: 'agent_responses', messages: [{ role: 'user', content: 'x' }] } });
    const tc = store.modelCalls[0].toolCallsRedacted[0];
    expect(tc.args_summary).not.toMatch(/ghp_/);
    expect(tc.result_summary).not.toMatch(/ghp_/);
    expect(tc.args_summary).toContain('‹redacted›');
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
  });

  it('extracts JSON even with trailing prose containing a brace', async () => {
    const registry = new SchemaRegistry().register('summary.v1', z.object({ cause: z.string() }));
    const invoker = new FakeInvoker(() => ({ text: 'Here you go: {"cause":"pool"} — let me know if you need {more}.', model: 'm', provider: 'p', latencyMs: 5 }));
    const store = new FakeStore();
    const out = await runModelCall(
      { gateway: invoker, store, registry, now: NOW },
      { ...baseSpec, request: { apiSurface: 'agent_chat_completions', messages: [{ role: 'user', content: 'x' }] }, outputSchemaVersion: 'summary.v1' },
    );
    expect(out.validation.status).toBe('valid');
  });
});

describe('runModelCall — failure + idempotency', () => {
  it('persists a failed row (sanitized, NOT NULL satisfied) before rethrowing', async () => {
    const invoker = new FakeInvoker(() => {
      throw Object.assign(new Error('provider PII leaked here'), { code: 'gateway_http_429', summary: 'Gateway returned HTTP 429.' });
    });
    const store = new FakeStore();
    await expect(
      runModelCall({ gateway: invoker, store, now: NOW }, { ...baseSpec, request: { apiSurface: 'agent_chat_completions', messages: [{ role: 'user', content: 'x' }] } }),
    ).rejects.toThrow();
    const row = store.modelCalls[0];
    expect(row.status).toBe('failed');
    expect(row.modelName).toBe('unknown'); // coerced NOT NULL
    expect(row.requestSchemaVersion).toBe('none');
    expect(row.errorCode).toBe('gateway_http_429');
    expect(row.errorSummary).toBe('Gateway returned HTTP 429.');
    expect(row.errorSummary).not.toMatch(/PII/); // raw err.message never persisted
  });

  it('a retry success upserts the earlier failed row up to succeeded (no lost success)', async () => {
    const store = new FakeStore();
    const failing = new FakeInvoker(() => {
      throw Object.assign(new Error('boom'), { code: 'gateway_timeout', summary: 'timed out' });
    });
    await expect(
      runModelCall({ gateway: failing, store, now: NOW }, { ...baseSpec, purpose: 'correlate', request: { apiSurface: 'agent_chat_completions', messages: [{ role: 'user', content: 'x' }] } }),
    ).rejects.toThrow();
    expect(store.modelCalls).toHaveLength(1);
    expect(store.modelCalls[0].status).toBe('failed');

    const succeeding = new FakeInvoker(() => ({ text: 'done', model: 'gemini-3.5-flash', provider: 'google', latencyMs: 8 }));
    const out = await runModelCall({ gateway: succeeding, store, now: NOW }, { ...baseSpec, purpose: 'correlate', request: { apiSurface: 'agent_chat_completions', messages: [{ role: 'user', content: 'x' }] } });
    expect(out.deduped).toBe(true);
    expect(store.modelCalls).toHaveLength(1); // same slot
    expect(store.modelCalls[0].status).toBe('succeeded'); // upserted, not stuck on failed
    expect(store.modelCalls[0].modelName).toBe('gemini-3.5-flash');
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
