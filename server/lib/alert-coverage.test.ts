import { describe, expect, it } from 'vitest';
import {
  type AlertFinding,
  type MonitorSnapshot,
  alertDedupeFingerprint,
  alertFindingsSchema,
  buildAlertCoverageMessages,
  metricCoverage,
  parseAlertFindings,
  selectAlertRecommendations,
} from './alert-coverage';

const monitor = (over: Partial<MonitorSnapshot> = {}): MonitorSnapshot => ({ id: 1, name: 'retry rate', query: 'avg(last_5m):avg:instrument.job.retry{*} > 5', type: 'metric alert', ...over });

const newMonitorFinding = (over: Partial<AlertFinding> = {}): AlertFinding => ({
  recommendation_type: 'new_monitor',
  title: 'Alert on job errors',
  rationale: 'The error metric has no monitor.',
  severity: 'high',
  metric_name: 'instrument.job.error',
  monitor_type: 'metric alert',
  query: 'avg(last_5m):avg:instrument.job.error{*} > 3',
  message: 'errors elevated',
  ...over,
}) as AlertFinding;

const improvementFinding = (over: Partial<AlertFinding> = {}): AlertFinding => ({
  recommendation_type: 'monitor_improvement',
  title: 'Tighten the retry monitor',
  rationale: 'It has no no-data handling.',
  severity: 'medium',
  monitor_name: 'retry rate',
  diff_rows: [{ k: 'notify_no_data', from: 'false', to: 'true' }],
  ...over,
}) as AlertFinding;

const base = {
  namespace: 'instrument',
  liveMetrics: ['instrument.job.retry', 'instrument.job.error'],
  coveredMetrics: ['instrument.job.retry'],
  existingMonitors: [monitor()],
  hasInstrumentationGaps: false,
};

describe('metricCoverage', () => {
  it('marks a metric covered iff some monitor query references it', () => {
    const c = metricCoverage(['instrument.job.retry', 'instrument.job.error'], [monitor()]);
    expect(c.covered).toEqual(['instrument.job.retry']);
    expect(c.uncovered).toEqual(['instrument.job.error']);
  });
  it('treats a metric with no monitor at all as uncovered', () => {
    expect(metricCoverage(['a.b.c'], []).uncovered).toEqual(['a.b.c']);
  });
  it('counts a Datadog rollup suffix (.as_count()) as covering the base metric', () => {
    const c = metricCoverage(['instrument.job.error'], [monitor({ query: 'sum(last_5m):sum:instrument.job.error.as_count(){*} > 5' })]);
    expect(c.covered).toEqual(['instrument.job.error']);
  });
  it('correctly distinguishes metrics that share a common prefix (no substring false positives)', () => {
    const c = metricCoverage(['instrument.job', 'instrument.job.retry'], [monitor()]);
    expect(c.covered).toEqual(['instrument.job.retry']);
    expect(c.uncovered).toEqual(['instrument.job']);
  });
});

describe('selectAlertRecommendations — new_monitor', () => {
  it('creates a verified, creatable monitor step for an uncovered metric that exists now', () => {
    const out = selectAlertRecommendations({ ...base, findings: [newMonitorFinding()] });
    expect(out).toHaveLength(1);
    expect(out[0].step).toMatchObject({ kind: 'datadog_new_monitor', state: 'available', metric_verification_state: 'verified_in_datadog' });
    expect(out[0].step.proposed_payload).toMatchObject({ metric_name: 'instrument.job.error', query: expect.stringContaining('instrument.job.error') });
  });

  it('DROPS a monitor for an already-covered metric (no duplicate)', () => {
    const out = selectAlertRecommendations({ ...base, findings: [newMonitorFinding({ metric_name: 'instrument.job.retry', query: 'avg(last_5m):avg:instrument.job.retry{*} > 9' })] });
    expect(out).toHaveLength(0);
  });

  it('DROPS an unverified metric (absent from Datadog, no prerequisite) — no creatable alert', () => {
    const out = selectAlertRecommendations({ ...base, findings: [newMonitorFinding({ metric_name: 'instrument.job.ghost', query: 'avg(last_5m):avg:instrument.job.ghost{*} > 1' })] });
    expect(out).toHaveLength(0);
  });

  it('produces a LOCKED expected_after_step step when the metric is absent but the model flags instrumentation AND the scan found gaps', () => {
    const out = selectAlertRecommendations({
      ...base,
      hasInstrumentationGaps: true,
      findings: [newMonitorFinding({ metric_name: 'instrument.job.ghost', query: 'avg(last_5m):avg:instrument.job.ghost{*} > 1', needs_instrumentation_first: true })],
    });
    expect(out).toHaveLength(1);
    expect(out[0].step).toMatchObject({ state: 'locked', metric_verification_state: 'expected_after_step' });
    expect(out[0].step.waits_for).toContain('instrument.job.ghost');
  });

  it('still DROPS an expected-after-step claim when the scan found NO instrumentation gaps (model claim alone is not enough)', () => {
    const out = selectAlertRecommendations({
      ...base,
      hasInstrumentationGaps: false,
      findings: [newMonitorFinding({ metric_name: 'instrument.job.ghost', query: 'q > 1', needs_instrumentation_first: true })],
    });
    expect(out).toHaveLength(0);
  });

  it('drops a malformed new_monitor finding with no metric/query', () => {
    const out = selectAlertRecommendations({ ...base, findings: [newMonitorFinding({ metric_name: undefined, query: undefined })] });
    expect(out).toHaveLength(0);
  });

  it('DROPS a finding whose query alerts on a DIFFERENT metric than the verified metric_name', () => {
    // metric_name is verified+uncovered, but the query fires on another metric → unsafe.
    const out = selectAlertRecommendations({ ...base, findings: [newMonitorFinding({ metric_name: 'instrument.job.error', query: 'avg(last_5m):avg:instrument.job.other{*} > 1' })] });
    expect(out).toHaveLength(0);
  });

  it('synthesizes title + rationale when the model omits them (the live gemini case)', () => {
    const out = selectAlertRecommendations({ ...base, findings: [newMonitorFinding({ title: undefined, rationale: undefined })] });
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain('instrument.job.error');
    expect(out[0].rationale.length).toBeGreaterThan(0);
    expect(out[0].step.proposed_payload).toMatchObject({ name: expect.stringContaining('instrument.job.error') });
  });
});

describe('selectAlertRecommendations — monitor_improvement (read-only)', () => {
  it('renders a configuration_diff against a monitor we actually read, with no approval/generation path', () => {
    const out = selectAlertRecommendations({ ...base, findings: [improvementFinding()] });
    expect(out).toHaveLength(1);
    expect(out[0].step).toMatchObject({ kind: 'datadog_monitor_change', state: 'available' });
    expect(out[0].step.proposed_payload).toBeUndefined(); // never a creatable write
    expect(out[0].step.configuration_diff).toMatchObject({ monitor: 'retry rate', rows: [{ k: 'notify_no_data', from: 'false', to: 'true' }] });
  });

  it('DROPS an improvement that names a monitor we never read (no phantom diff)', () => {
    const out = selectAlertRecommendations({ ...base, findings: [improvementFinding({ monitor_name: 'does-not-exist' })] });
    expect(out).toHaveLength(0);
  });

  it('drops an improvement with no diff rows', () => {
    const out = selectAlertRecommendations({ ...base, findings: [improvementFinding({ diff_rows: undefined })] });
    expect(out).toHaveLength(0);
  });
});

describe('dedupe + batch collapse', () => {
  it('is deterministic per (namespace, kind, key) and distinct across them', () => {
    expect(alertDedupeFingerprint('instrument', 'monitor', 'instrument.job.error')).toBe(alertDedupeFingerprint('instrument', 'monitor', 'instrument.job.error'));
    expect(alertDedupeFingerprint('instrument', 'monitor', 'instrument.job.error')).not.toBe(alertDedupeFingerprint('instrument', 'improve', 'instrument.job.error'));
  });
  it('collapses two findings for the same metric into one upsert', () => {
    const out = selectAlertRecommendations({ ...base, findings: [newMonitorFinding(), newMonitorFinding({ title: 'reworded but same metric' })] });
    expect(out).toHaveLength(1);
  });
});

describe('schema + prompt', () => {
  it('drops malformed findings but keeps the batch (per-item leniency)', () => {
    const parsed = alertFindingsSchema.parse({ findings: [newMonitorFinding(), { recommendation_type: 'nonsense' }, 42] });
    expect(parsed.findings).toHaveLength(1);
  });
  it('parseAlertFindings coerces a bare array into {findings}', () => {
    expect(parseAlertFindings(JSON.stringify([{ recommendation_type: 'new_monitor' }]))).toMatchObject({ findings: [{ recommendation_type: 'new_monitor' }] });
  });
  it('parseAlertFindings survives a ```json code fence (the live gemini wrapping)', () => {
    const fenced = '```json\n{\n  "findings": [\n    {"recommendation_type":"new_monitor","metric_name":"instrument.job.error","query":"sum(last_5m):sum:instrument.job.error{*} > 5","monitor_type":"metric alert","severity":"critical"}\n  ]\n}\n```';
    const parsed = alertFindingsSchema.parse(parseAlertFindings(fenced));
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({ metric_name: 'instrument.job.error', severity: 'medium' }); // off-vocab "critical" coerced
  });
  it('the prompt lists uncovered metrics and existing monitors, and warns off covered metrics', () => {
    const msgs = buildAlertCoverageMessages({ repoFullName: 'pchen41/instrument', namespace: 'instrument', uncoveredMetrics: ['instrument.job.error'], coveredMetrics: ['instrument.job.retry'], existingMonitors: [monitor()], instrumentationGaps: ['no error log on handler'] });
    const user = msgs[1].content;
    expect(user).toContain('instrument.job.error');
    expect(user).toContain('do NOT propose monitors');
    expect(user).toContain('retry rate');
  });
});
