import { describe, expect, it } from 'vitest';
import {
  buildDraftMonitor,
  canCreateAlert,
  ddMonitorSpecSchema,
  metricVerification,
  monitorMarkerTag,
  parseMonitorSpec,
  type DdMonitorSpec,
} from './datadog-alert';

const spec = (over: Partial<DdMonitorSpec> = {}): DdMonitorSpec =>
  ddMonitorSpecSchema.parse({
    metric_name: 'instrument.job.retry',
    monitor_type: 'metric alert',
    name: 'Instrument job retry rate',
    query: 'avg(last_5m):avg:instrument.job.retry{*} > 5',
    ...over,
  });

describe('metric verification', () => {
  it('is verified_in_datadog when the metric exists', () => {
    expect(metricVerification(true, false)).toBe('verified_in_datadog');
    expect(canCreateAlert('verified_in_datadog')).toBe(true);
  });
  it('is expected_after_step only when a prerequisite step is done', () => {
    expect(metricVerification(false, true)).toBe('expected_after_step');
    expect(canCreateAlert('expected_after_step')).toBe(false);
  });
  it('is unverified (not creatable) when the metric is absent and no prerequisite', () => {
    expect(metricVerification(false, false)).toBe('unverified');
    expect(canCreateAlert('unverified')).toBe(false);
  });
});

describe('buildDraftMonitor', () => {
  it('creates a non-notifying draft: no @-mentions, marker + draft tags, parsed threshold', () => {
    const m = buildDraftMonitor(spec(), 'Alert on job retry rate', 'rec-1', 'create-monitor');
    expect(m.message).not.toContain('@'); // no notification routing → draft
    expect(m.message).toContain('[instrument:draft]');
    expect(m.tags).toContain('source:instrument');
    expect(m.tags).toContain('instrument:draft');
    expect(m.tags).toContain(monitorMarkerTag('rec-1', 'create-monitor'));
    expect(m.type).toBe('metric alert');
    expect(m.options).toMatchObject({ notify_no_data: false, thresholds: { critical: 5 } });
  });

  it('neutralizes @-mentions in analyst text so a draft can never page anyone', () => {
    const m = buildDraftMonitor(spec({ message: 'retries climbing, page @slack-oncall and @pagerduty' }), 'rec', 'rec-2', null);
    expect(m.message).toContain('retries climbing'); // analyst text preserved
    expect(m.message).not.toContain('@'); // routing tokens neutralized → no notifications
  });

  it('keeps the marker + draft tags even when the spec is at the 20-tag cap', () => {
    const many = Array.from({ length: 20 }, (_, i) => `t:${i}`);
    const m = buildDraftMonitor(spec({ tags: many }), 'rec', 'rec-3', 'create-monitor');
    expect(m.tags.length).toBeLessThanOrEqual(20);
    expect(m.tags).toContain(monitorMarkerTag('rec-3', 'create-monitor'));
    expect(m.tags).toContain('instrument:draft');
  });
});

describe('monitorMarkerTag', () => {
  it('is deterministic per recommendation step', () => {
    expect(monitorMarkerTag('rec-1', 'create-monitor')).toBe(monitorMarkerTag('rec-1', 'create-monitor'));
    expect(monitorMarkerTag('rec-1', 'create-monitor')).not.toBe(monitorMarkerTag('rec-2', 'create-monitor'));
  });
});

describe('parseMonitorSpec', () => {
  it('accepts a well-formed spec and coerces an off-vocab type to metric alert', () => {
    expect(parseMonitorSpec({ metric_name: 'm', monitor_type: 'weird', name: 'n', query: 'q > 1' })?.monitor_type).toBe('metric alert');
  });
  it('rejects a spec missing required fields', () => {
    expect(parseMonitorSpec({ name: 'n' })).toBeNull();
    expect(parseMonitorSpec(null)).toBeNull();
  });
});
