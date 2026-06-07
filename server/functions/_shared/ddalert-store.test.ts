// Contract test for parseMonitor: the datadog MCP nests the created monitor under
// `response.monitor` ({"response":{"monitor":{"id":...}}}) and omits the URL, so
// the id must be read from there and the link built from the site. Captured live
// from create_datadog_monitor (the parsePr-style nested-shape gotcha).
import { describe, expect, it } from 'vitest';
import { parseMonitor } from './ddalert-store';

const SITE = 'us5.datadoghq.com';

describe('parseMonitor', () => {
  it('reads the id from response.monitor and builds the site URL', () => {
    const text = '{"response":{"monitor":{"id":20351331,"name":"Retry rate","type":"metric alert"}}}';
    expect(parseMonitor(text, SITE)).toEqual({ id: 20351331, url: 'https://us5.datadoghq.com/monitors/20351331' });
  });

  it('accepts a top-level monitor or id, and an explicit url', () => {
    expect(parseMonitor('{"monitor":{"id":7,"url":"https://x/monitors/7"}}', SITE)).toEqual({ id: 7, url: 'https://x/monitors/7' });
    expect(parseMonitor('{"id":9}', SITE)?.id).toBe(9);
  });

  it('falls back to a numeric id scraped from non-JSON text', () => {
    expect(parseMonitor('created monitor "id": 12345 ok', SITE)).toEqual({ id: 12345, url: 'https://us5.datadoghq.com/monitors/12345' });
  });

  it('returns null when no id is present', () => {
    expect(parseMonitor('{"response":{"monitor":{"name":"no id"}}}', SITE)).toBeNull();
    expect(parseMonitor('totally unrelated', SITE)).toBeNull();
  });
});
