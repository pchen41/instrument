import { describe, expect, it } from 'vitest';
import { parseMetricNames, parseMonitors } from './recgen-store';

// Regression on the LIVE Datadog MCP read shapes (us5), probed 2026-06-07:
//   search_datadog_metrics → a bare JSON array of names
//   search_datadog_monitors → a bare JSON array of monitor objects, each with `query`

describe('parseMetricNames', () => {
  it('reads a bare array of metric names', () => {
    expect(parseMetricNames('["instrument.job.error","instrument.job.retry"]')).toEqual(['instrument.job.error', 'instrument.job.retry']);
  });
  it('reads a {metrics:[…]} wrapper too', () => {
    expect(parseMetricNames('{"metrics":["a.b"]}')).toEqual(['a.b']);
  });
  it('returns [] on non-JSON', () => {
    expect(parseMetricNames('error while executing tool')).toEqual([]);
  });
});

describe('parseMonitors', () => {
  it('keeps id+name+query for each monitor (the coverage signal)', () => {
    const text = JSON.stringify([
      { id: 20351331, name: 'Instrument job retry rate is elevated', type: 'metric alert', status: 'No Data', query: 'avg(last_5m):avg:instrument.job.retry{*} > 5', message: 'x' },
    ]);
    const out = parseMonitors(text);
    expect(out).toEqual([{ id: 20351331, name: 'Instrument job retry rate is elevated', query: 'avg(last_5m):avg:instrument.job.retry{*} > 5', type: 'metric alert', message: 'x' }]);
  });
  it('drops entries without an id or name, and tolerates a wrapper', () => {
    expect(parseMonitors('{"monitors":[{"id":1,"name":"m","query":"q"},{"name":"no id"}]}')).toEqual([{ id: 1, name: 'm', query: 'q', type: null, message: null }]);
  });
  it('returns [] on non-JSON', () => {
    expect(parseMonitors('deadline exceeded')).toEqual([]);
  });
});
