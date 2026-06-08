import { describe, expect, it } from 'vitest';
import {
  type CommitFact,
  type EvidenceFact,
  type IncidentContext,
  type InvestigateMcp,
  type InvestigateStore,
  type InvestigationOutput,
  type RepoRef,
  type SignalFact,
  type StoredHypothesis,
  type TfFact,
  INVESTIGATION_SCHEMA_VERSION,
  buildCorrelatedChanges,
  buildInvestigationMessages,
  confidenceLabel,
  investigationContext,
  investigationOutputSchema,
  isRealInvestigation,
  makeInvestigateExecutor,
  selectHypotheses,
} from './agent-investigate';
import type { AgentInvokeRequest, AgentInvokeResult, AgentInvoker, EvidenceRow, ModelCallRow, ModelCallStore } from './model-call';
import { schemaRegistry } from './schema-validation';
import type { JobRow } from './types';

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: UUID(1),
    workspace_id: UUID(2),
    job_type: 'incident_investigation',
    state: 'running',
    target_type: 'incident',
    target_id: UUID(3),
    idempotency_key: 'k',
    safe_to_retry: true,
    attempt_count: 1,
    max_attempts: 3,
    retry_policy: {},
    phases: [],
    attempts: [],
    audit_events: [],
    trigger_summary: { source: 'console' },
    progress_version: 1,
    ...over,
  } as JobRow;
}

const facts = (over: Partial<EvidenceFact> = {}): EvidenceFact => ({
  key: 'E1',
  id: UUID(10),
  verified: true,
  sourceType: 'datadog_alert_event',
  provider: 'datadog',
  title: 'Datadog alert',
  summary: 'retries climbing',
  externalId: 'evt-1',
  uri: null,
  ...over,
});

describe('investigationContext / isRealInvestigation', () => {
  it('resolves a console or datadog_alert incident investigation', () => {
    expect(investigationContext(job({ trigger_summary: { source: 'console' } }))).toMatchObject({ incidentId: UUID(3), source: 'console', jobId: UUID(1) });
    expect(investigationContext(job({ trigger_summary: { source: 'datadog_alert' } }))?.source).toBe('datadog_alert');
    expect(isRealInvestigation(job())).toBe(true);
  });
  it('rejects viability / simulated / non-incident / other-type jobs', () => {
    expect(investigationContext(job({ trigger_summary: { source: 'console', mode: 'viability' } }))).toBeNull();
    expect(investigationContext(job({ trigger_summary: { source: 'console', simulate: { fail_phase: 'triage' } } }))).toBeNull();
    expect(investigationContext(job({ trigger_summary: { source: 'seed' } }))).toBeNull();
    expect(investigationContext(job({ job_type: 'proactive_scan' }))).toBeNull();
    expect(investigationContext(job({ target_type: 'recommendation' }))).toBeNull();
  });
});

describe('investigationOutputSchema', () => {
  it('is registered under the schema version', () => {
    expect(schemaRegistry.has(INVESTIGATION_SCHEMA_VERSION)).toBe(true);
  });
  it('requires an array root and drops only malformed hypotheses', () => {
    expect(investigationOutputSchema.safeParse({ hypotheses: 'nope' }).success).toBe(false);
    const ok = investigationOutputSchema.safeParse({
      summary: 's',
      hypotheses: [{ title: 'T', reasoning: 'R' }, { nope: true }],
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.hypotheses).toHaveLength(1);
    expect(ok.success && ok.data.hypotheses[0].confidence).toBe('likely'); // default via .catch
  });
});

describe('buildInvestigationMessages', () => {
  const incident: IncidentContext = {
    id: UUID(3), workspaceId: UUID(2), serviceName: 'instrument-worker', environment: 'production',
    title: 'retry rate elevated', description: 'retries climbing', alertState: 'firing', incidentState: 'active',
    monitorId: '123', datadogUrl: null, traceId: 'abc123', requestId: 'req-9', startedAt: null, signals: [],
  };
  it('lists evidence keys + the trace id, and flags an unavailable TrueFoundry source', () => {
    const msgs = buildInvestigationMessages(incident, [facts({ key: 'E1' }), facts({ key: 'E2', sourceType: 'commit', title: 'Commit a1b2c3d' })], false);
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain('E1');
    expect(user).toContain('E2');
    expect(user).toContain('abc123');
    expect(user).toContain('TrueFoundry');
  });
  it('omits the unavailable note when TrueFoundry is reachable', () => {
    const msgs = buildInvestigationMessages(incident, [facts()], true);
    expect(msgs.find((m) => m.role === 'user')!.content).not.toContain('Unavailable sources');
  });
});

describe('selectHypotheses', () => {
  const evidence = [facts({ key: 'E1', id: UUID(10) }), facts({ key: 'E2', id: UUID(11), sourceType: 'commit' })];

  it('resolves cited keys to verified ids and drops unknown citations', () => {
    const [h] = selectHypotheses(
      [{ title: 'pool exhausted', reasoning: 'deploy raised pool', confidence: 'high', root_cause_type: 'code', instrument_can_fix: true, evidence_keys: ['E1', 'E2', 'E9'] }],
      evidence,
    );
    expect(h.evidence_ids).toEqual([UUID(10), UUID(11)]); // E9 dropped
    expect(h.rank).toBe(1);
    expect(h.leading).toBe(true);
    expect(h.confidence).toBe('high'); // has evidence
    expect(h.instrument_can_fix).toBe(true);
  });

  it('caps "high" confidence with no resolvable evidence down to "likely"', () => {
    const [h] = selectHypotheses(
      [{ title: 'x', reasoning: 'y', confidence: 'high', root_cause_type: 'code', instrument_can_fix: true, evidence_keys: ['E9'] }],
      evidence,
    );
    expect(h.confidence).toBe('likely');
    expect(h.evidence_ids).toEqual([]);
  });

  it('folds a no-code-fix explanation + next step into runtime/upstream causes', () => {
    const [h] = selectHypotheses(
      [{ title: 'upstream latency', reasoning: 'provider slow', confidence: 'likely', root_cause_type: 'upstream', instrument_can_fix: false, evidence_keys: ['E1'], no_fix_reason: 'third-party API is slow', suggested_next_step: 'open a provider ticket' }],
      evidence,
    );
    expect(h.instrument_can_fix).toBe(false);
    expect(h.detail).toContain("can't fix this automatically");
    expect(h.detail).toContain('open a provider ticket');
    expect(h.no_fix_reason).toBe('third-party API is slow');
  });

  it('never marks a non-code cause as Instrument-fixable even if the model claims it', () => {
    const [h] = selectHypotheses(
      [{ title: 'config', reasoning: 'r', confidence: 'likely', root_cause_type: 'runtime_config', instrument_can_fix: true, evidence_keys: ['E1'] }],
      evidence,
    );
    expect(h.instrument_can_fix).toBe(false); // gated to code-only
    expect(h.detail).toContain("can't fix this automatically");
  });

  it('emits a single inconclusive low-confidence hypothesis when nothing survives', () => {
    const out = selectHypotheses([], evidence);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ rank: 1, leading: true, confidence: 'low', root_cause_type: 'unknown', instrument_can_fix: false });
  });
});

describe('confidenceLabel', () => {
  it('uses "Root cause" only for high confidence', () => {
    expect(confidenceLabel('high')).toBe('Root cause');
    expect(confidenceLabel('likely')).toBe('Leading hypothesis');
    expect(confidenceLabel('low')).toBe('Leading hypothesis');
    expect(confidenceLabel(null)).toBe('Leading hypothesis');
  });
});

describe('buildCorrelatedChanges', () => {
  it('maps commit evidence to commit pointers with a valid url and evidence id', () => {
    const changes = buildCorrelatedChanges([
      { id: UUID(11), commit: { sha: 'a1b2c3d4e5', message: 'raise pool size', author: 'pat', url: 'https://github.com/o/r/commit/a1b2c3d4e5', committedAt: null } },
      { id: UUID(12), commit: { sha: 'deadbeef', message: 'bad url', author: null, url: 'javascript:alert(1)', committedAt: null } },
    ]);
    expect(changes[0]).toMatchObject({ kind: 'commit', ref: 'a1b2c3d4e5', evidence_id: UUID(11) });
    expect(changes[0].url).toContain('github.com');
    expect(changes[1].url).toBeNull(); // unsafe url dropped
  });
});

// ---- executor end-to-end (fakes) --------------------------------------------

class FakeModelStore implements ModelCallStore {
  rows: ModelCallRow[] = [];
  evidence: EvidenceRow[] = [];
  async saveModelCall(row: ModelCallRow) {
    this.rows.push(row);
    return { id: UUID(99), deduped: false };
  }
  async saveEvidence(rows: EvidenceRow[]) {
    this.evidence.push(...rows);
  }
}

class FakeGateway implements AgentInvoker {
  constructor(private text: string) {}
  calls = 0;
  async invoke(_req: AgentInvokeRequest): Promise<AgentInvokeResult> {
    this.calls += 1;
    return { text: this.text, model: 'instrument/instrument', provider: 'truefoundry', latencyMs: 5 };
  }
}

const repo: RepoRef = { id: UUID(20), owner: 'pchen41', name: 'instrument', fullName: 'pchen41/instrument', defaultBranch: 'main' };

class FakeStore implements InvestigateStore {
  calls: string[] = [];
  // seeded alert-event fact (Task 10) + gathered evidence rows
  evidenceRows: { id: string; jobId: string; subjectKey: string; sourceType: string; verified: boolean; payload?: any }[] = [
    { id: UUID(10), jobId: '', subjectKey: 'alert', sourceType: 'datadog_alert_event', verified: true },
  ];
  incident: IncidentContext = {
    id: UUID(3), workspaceId: UUID(2), serviceName: 'instrument-worker', environment: 'production',
    title: 'retry rate elevated', description: 'retries climbing', alertState: 'firing', incidentState: 'active',
    monitorId: '123', datadogUrl: null, traceId: 'abc123', requestId: 'req-9', startedAt: '2026-06-07T00:00:00.000Z',
    signals: [{ key: 'trace_id', label: 'Trace', value: 'abc123' }],
  };
  written: { hypotheses?: StoredHypothesis[]; summary?: string; correlated?: any[]; signals?: any[] } = {};
  output: InvestigationOutput | null = null;
  snapshotFacts: EvidenceFact[] = [];
  private idc = 100;

  async loadIncident() {
    this.calls.push('loadIncident');
    return this.incident;
  }
  async loadRepo() {
    this.calls.push('loadRepo');
    return repo;
  }
  async saveCommitEvidence({ commit }: { commit: CommitFact }) {
    this.calls.push('saveCommitEvidence');
    this.evidenceRows.push({ id: UUID(this.idc++), jobId: UUID(1), subjectKey: `commit:${commit.sha}`, sourceType: 'commit', verified: true, payload: { sha: commit.sha, message: commit.message } });
  }
  async saveSignalEvidence({ sourceType, fact }: { sourceType: string; fact: SignalFact }) {
    this.calls.push(`saveSignalEvidence:${sourceType}`);
    this.evidenceRows.push({ id: UUID(this.idc++), jobId: UUID(1), subjectKey: fact.externalId, sourceType, verified: true });
  }
  async saveTruefoundryEvidence({ fact }: { fact: TfFact }) {
    this.calls.push('saveTruefoundryEvidence');
    const sourceType = fact.kind === 'request_log' ? 'truefoundry_log' : 'truefoundry_metric';
    this.evidenceRows.push({ id: UUID(this.idc++), jobId: UUID(1), subjectKey: `tf:${fact.kind}`, sourceType, verified: true });
  }
  async saveUnavailableTruefoundry() {
    this.calls.push('saveUnavailableTruefoundry');
    this.evidenceRows.push({ id: UUID(this.idc++), jobId: UUID(1), subjectKey: 'tf', sourceType: 'truefoundry_metric', verified: false });
  }
  async loadEvidenceFacts(): Promise<EvidenceFact[]> {
    return this.evidenceRows
      .filter((r) => r.verified && r.sourceType !== 'ai_model_call')
      .map((r, i) => ({ key: `E${i + 1}`, id: r.id, verified: true, sourceType: r.sourceType, provider: null, title: r.sourceType, summary: '', externalId: null, uri: null }));
  }
  async loadCommitEvidence() {
    return this.evidenceRows.filter((r) => r.sourceType === 'commit').map((r) => ({ id: r.id, commit: { sha: r.payload.sha, message: r.payload.message, author: null, url: null, committedAt: null } as CommitFact }));
  }
  async hasHypothesesOutput() {
    return this.output !== null;
  }
  async saveHypothesesOutput({ output, facts }: { output: InvestigationOutput; facts: EvidenceFact[] }) {
    this.calls.push('saveHypothesesOutput');
    this.output = output;
    this.snapshotFacts = facts;
  }
  async loadHypothesesOutput() {
    return this.output ? { output: this.output, facts: this.snapshotFacts } : null;
  }
  async writeCorrelatedChanges({ changes }: { changes: any[] }) {
    this.calls.push('writeCorrelatedChanges');
    this.written.correlated = changes;
  }
  async writeHypotheses({ hypotheses, summary, addSignals }: { hypotheses: StoredHypothesis[]; summary: string; addSignals: any[] }) {
    this.calls.push('writeHypotheses');
    this.written.hypotheses = hypotheses;
    this.written.summary = summary;
    this.written.signals = addSignals;
  }
}

class FakeMcp implements InvestigateMcp {
  // tf defaults to [] → TrueFoundry telemetry unavailable (the degrade path).
  constructor(private tf: TfFact[] = []) {}
  async recentCommits(): Promise<CommitFact[]> {
    return [{ sha: 'a1b2c3d', message: 'raise pool size', author: 'pat', url: 'https://github.com/pchen41/instrument/commit/a1b2c3d', committedAt: null }];
  }
  async getTrace(traceId: string): Promise<SignalFact | null> {
    return { externalId: `dd_trace:${traceId}`, title: 'trace', summary: 'spans', uri: null, payload: {}, observedAt: null };
  }
  async searchServiceLogs(): Promise<SignalFact | null> {
    return { externalId: 'dd_logs:instrument-worker', title: 'logs', summary: '3 errors', uri: null, payload: {}, observedAt: null };
  }
  async truefoundryTelemetry(): Promise<TfFact[]> {
    return this.tf;
  }
}

const TF_MODEL_FACT: TfFact = { kind: 'model_metric', externalId: 'tf_model_metrics', title: 'TrueFoundry AI Gateway — model metrics (6h)', summary: '31 model call(s) across 2 model(s)', payload: { total_calls: 31 }, observedAt: null };

async function runAll(store: FakeStore, mcp: InvestigateMcp, gateway: AgentInvoker, j = job()) {
  const exec = makeInvestigateExecutor({ gateway, modelStore: new FakeModelStore(), mcp, store, now: () => new Date('2026-06-07T01:00:00.000Z') });
  for (const phaseKey of ['triage', 'gather_signals', 'correlate', 'hypotheses', 'summarize']) {
    await exec({ job: j, phaseKey, attempt: 1 });
  }
}

const GOOD_OUTPUT = JSON.stringify({
  summary: 'A deploy raised the pool size and exhausted connections.',
  hypotheses: [
    { title: 'Connection pool exhausted after deploy', reasoning: 'The recent deploy raised pool size; retries climbed right after.', confidence: 'high', root_cause_type: 'code', instrument_can_fix: true, evidence_keys: ['E1', 'E2'] },
    { title: 'Upstream provider latency', reasoning: 'A dependency slowed.', confidence: 'high', root_cause_type: 'upstream', instrument_can_fix: false, evidence_keys: ['E9'], no_fix_reason: 'the slow dependency is a third-party API', suggested_next_step: 'open a ticket with the provider' },
  ],
});

describe('makeInvestigateExecutor (end to end)', () => {
  it('gathers verified evidence, marks TrueFoundry unavailable, and writes evidence-backed hypotheses', async () => {
    const store = new FakeStore();
    await runAll(store, new FakeMcp(), new FakeGateway(GOOD_OUTPUT));

    // gather persisted commit + trace + log + the degraded TrueFoundry marker.
    expect(store.calls).toContain('saveCommitEvidence');
    expect(store.calls).toContain('saveSignalEvidence:datadog_trace');
    expect(store.calls).toContain('saveSignalEvidence:datadog_log');
    expect(store.calls).toContain('saveUnavailableTruefoundry');
    // correlated changes derived from the commit evidence.
    expect(store.written.correlated?.[0]).toMatchObject({ kind: 'commit', ref: 'a1b2c3d' });

    const hyps = store.written.hypotheses!;
    expect(hyps).toHaveLength(2);
    // leading is evidence-backed + high; second is upstream → capped + no-fix folded.
    expect(hyps[0]).toMatchObject({ rank: 1, leading: true, confidence: 'high', instrument_can_fix: true });
    expect(hyps[1]).toMatchObject({ rank: 2, confidence: 'likely', instrument_can_fix: false });
    expect(hyps[1].detail).toContain("can't fix this automatically");
    expect(store.written.summary).toContain('TrueFoundry telemetry was unavailable');
  });

  it('gathers TrueFoundry telemetry as verified evidence when the federated tools are available', async () => {
    const store = new FakeStore();
    await runAll(store, new FakeMcp([TF_MODEL_FACT]), new FakeGateway(GOOD_OUTPUT));
    // gather persisted a verified truefoundry_metric row instead of the degraded marker.
    expect(store.calls).toContain('saveTruefoundryEvidence');
    expect(store.calls).not.toContain('saveUnavailableTruefoundry');
    expect(store.evidenceRows.some((r) => r.sourceType === 'truefoundry_metric' && r.verified)).toBe(true);
    // the summary no longer reports TrueFoundry as unavailable.
    expect(store.written.summary).not.toContain('unavailable');
  });

  it('every displayed evidence id points to a real verified evidence item', async () => {
    const store = new FakeStore();
    await runAll(store, new FakeMcp(), new FakeGateway(GOOD_OUTPUT));
    const verifiedIds = new Set(store.evidenceRows.filter((r) => r.verified).map((r) => r.id));
    for (const h of store.written.hypotheses!) {
      for (const id of h.evidence_ids) expect(verifiedIds.has(id)).toBe(true);
    }
  });

  it('falls back to an inconclusive hypothesis when the model output is unusable', async () => {
    const store = new FakeStore();
    await runAll(store, new FakeMcp(), new FakeGateway('not json at all'));
    expect(store.written.hypotheses).toHaveLength(1);
    expect(store.written.hypotheses![0]).toMatchObject({ confidence: 'low', root_cause_type: 'unknown' });
  });

  it('does not re-bill the gateway when resuming with hypotheses already persisted', async () => {
    const store = new FakeStore();
    const gateway = new FakeGateway(GOOD_OUTPUT);
    const exec = makeInvestigateExecutor({ gateway, modelStore: new FakeModelStore(), mcp: new FakeMcp(), store, now: () => new Date() });
    await exec({ job: job(), phaseKey: 'gather_signals', attempt: 1 });
    await exec({ job: job(), phaseKey: 'hypotheses', attempt: 1 });
    await exec({ job: job(), phaseKey: 'hypotheses', attempt: 2 }); // resume
    expect(gateway.calls).toBe(1);
  });

  it('is read-only: the executor only reads/persists evidence + updates the incident (no write-action calls)', async () => {
    const store = new FakeStore();
    await runAll(store, new FakeMcp(), new FakeGateway(GOOD_OUTPUT));
    // The InvestigateStore/Mcp surfaces expose NO branch/PR/monitor/approval/job
    // creation; assert every recorded call is a read, an evidence write, or an
    // incident write-back.
    const allowed = new Set(['loadIncident', 'loadRepo', 'saveCommitEvidence', 'saveSignalEvidence:datadog_trace', 'saveSignalEvidence:datadog_log', 'saveTruefoundryEvidence', 'saveUnavailableTruefoundry', 'saveHypothesesOutput', 'writeCorrelatedChanges', 'writeHypotheses']);
    for (const c of store.calls) expect(allowed.has(c)).toBe(true);
  });
});
