import { describe, expect, it } from 'vitest';
import { COLUMN_SCHEMAS, validateColumn, type ColumnSchemaKey } from './index';

// Representative good documents for every jsonb-array column — these mirror the
// shapes the workflow seed writes, so they double as living documentation of the
// stored JSON.
const GOOD: Record<ColumnSchemaKey, unknown[]> = {
  'jobs.phases': [{ key: 'collect', label: 'Collect signals', state: 'succeeded', detail: 'x' }],
  'jobs.attempts': [
    {
      attempt: 1,
      outcome: 'retrying',
      started_at: '2026-06-06T14:22:40Z',
      error_code: 'tfy_429',
      error_summary: 'rate limit',
    },
  ],
  'jobs.audit_events': [{ at: '2026-06-06T14:22:31Z', kind: 'enqueued', summary: 'queued' }],
  'repositories.service_map': [
    { path_glob: 'functions/job-worker-tick/**', service_name: 'job-worker-tick', environment: 'production', confidence: 'high' },
  ],
  'recommendations.steps': [
    {
      key: 'add-retry-metric',
      order: 0,
      kind: 'code_pr',
      state: 'ready',
      label: 'Add a retry-rate metric',
      target_provider: 'github',
      metric_verification_state: 'expected_after_step',
      generated_pr: { number: 12, branch: 'instrument/x', files: ['functions/job-worker-tick/index.ts'] },
    },
    {
      key: 'create-retry-monitor',
      order: 1,
      kind: 'datadog_new_monitor',
      state: 'locked',
      label: 'Alert when retry > 5/min',
      prerequisite_step_key: 'add-retry-metric',
      waits_for: 'the metric PR is merged',
      generated_monitor: { monitor_id: '3098', draft: true },
    },
  ],
  'recommendations.lifecycle_events': [
    { at: '2026-06-06T13:41:20Z', event: 'created', detail: 'found by scan' },
  ],
  'incidents.signals': [{ key: 'retry_rate', label: 'job retry rate', value: '12.4/min' }],
  'incidents.timeline': [
    { at: '2026-06-06T14:22:07Z', kind: 'alert', title: 'Monitor fired', detail: 'x' },
  ],
  'incidents.hypotheses': [
    {
      rank: 1,
      leading: true,
      root_cause_type: 'runtime_config',
      summary: 'rate limit',
      detail: 'x',
      confidence: 'high',
      evidence_ids: ['11111111-1111-1111-1111-111111111111'],
    },
  ],
  'incidents.correlated_changes': [
    { kind: 'commit', ref: '9658c73', summary: 'raised limit', url: 'https://github.com/pchen41/instrument/commit/9658c73' },
  ],
  'ai_model_calls.tool_calls_redacted': [
    { server: 'datadog', tool: 'get_metric', arguments_summary: 'instrument.job.retry', ok: true },
  ],
};

// One invalid document per column (wrong enum, missing required field, bad type).
const BAD: Record<ColumnSchemaKey, unknown[]> = {
  'jobs.phases': [{ key: 'x', label: 'x', state: 'bogus' }],
  'jobs.attempts': [{ attempt: 1, outcome: 'retrying' }], // missing started_at
  'jobs.audit_events': [{ at: '2026-06-06T14:22:31Z', kind: 'x' }], // missing summary
  'repositories.service_map': [{ path_glob: 'x' }], // missing service_name
  'recommendations.steps': [{ key: 'x', order: 0, kind: 'code_pr', state: 'wrong', label: 'x' }],
  'recommendations.lifecycle_events': [{ event: 'created' }], // missing at
  'incidents.signals': [{ key: 'x', label: 'x' }], // missing value
  'incidents.timeline': [{ at: '2026-06-06T14:22:07Z', kind: 'explosion', title: 'x' }],
  'incidents.hypotheses': [{ rank: 0, summary: 'x', detail: 'x' }], // rank must be positive
  'incidents.correlated_changes': [{ kind: 'commit', ref: 'x' }], // missing summary
  'ai_model_calls.tool_calls_redacted': [{ tool: 'get_metric' }], // missing server
};

describe('jsonb column schemas', () => {
  const columns = Object.keys(COLUMN_SCHEMAS) as ColumnSchemaKey[];

  it('covers every documented jsonb column', () => {
    expect(columns.sort()).toEqual(
      [
        'ai_model_calls.tool_calls_redacted',
        'incidents.correlated_changes',
        'incidents.hypotheses',
        'incidents.signals',
        'incidents.timeline',
        'jobs.attempts',
        'jobs.audit_events',
        'jobs.phases',
        'recommendations.lifecycle_events',
        'recommendations.steps',
        'repositories.service_map',
      ].sort(),
    );
  });

  it.each(columns)('accepts a valid %s document', (col) => {
    expect(() => validateColumn(col, GOOD[col])).not.toThrow();
  });

  it.each(columns)('rejects an invalid %s document', (col) => {
    expect(() => validateColumn(col, BAD[col])).toThrow();
  });

  it('rejects a non-array value', () => {
    expect(() => validateColumn('jobs.phases', { not: 'an array' })).toThrow();
  });
});
