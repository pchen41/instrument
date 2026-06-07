import { describe, expect, it } from 'vitest';
import { assessIntegrationHealth } from './integration-health';

const NOW = '2026-06-06T00:00:00.000Z';

describe('assessIntegrationHealth', () => {
  it('connected: credentials present, registered, no recent failures', () => {
    const r = assessIntegrationHealth({ hasCredentials: true, mcpRegistered: true, recentFailures: [], now: NOW });
    expect(r).toEqual({ status: 'connected', lastErrorCode: null, lastErrorSummary: null, checkedAt: NOW });
  });

  it('missing_credentials wins over everything else', () => {
    const r = assessIntegrationHealth({ hasCredentials: false, mcpRegistered: false, recentFailures: [{ code: 'rate_limited', kind: 'rate_limit' }], now: NOW });
    expect(r.status).toBe('missing_credentials');
    expect(r.lastErrorCode).toBe('missing_credentials');
  });

  it('rate_limited when a recent failure is a rate limit (by kind or by code text)', () => {
    expect(assessIntegrationHealth({ hasCredentials: true, recentFailures: [{ kind: 'rate_limit', code: 'rate_limited', summary: 'slow down' }], now: NOW }).status).toBe('rate_limited');
    expect(assessIntegrationHealth({ hasCredentials: true, recentFailures: [{ code: 'http_429' }], now: NOW }).status).toBe('rate_limited');
  });

  it('degraded when MCP is unregistered', () => {
    const r = assessIntegrationHealth({ hasCredentials: true, mcpRegistered: false, recentFailures: [], now: NOW });
    expect(r.status).toBe('degraded');
    expect(r.lastErrorCode).toBe('mcp_unregistered');
  });

  it('degraded when our telemetry submission to the provider is failing', () => {
    const r = assessIntegrationHealth({ hasCredentials: true, mcpRegistered: true, telemetrySubmissionFailed: true, now: NOW });
    expect(r.status).toBe('degraded');
    expect(r.lastErrorCode).toBe('telemetry_submit_failed');
  });

  it('degraded on non-rate-limit provider failures, carrying redacted diagnostics', () => {
    const r = assessIntegrationHealth({
      hasCredentials: true,
      mcpRegistered: true,
      recentFailures: [{ code: 'gateway_http_502', summary: 'bad gateway with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', at: '2026-06-06T00:00:00Z' }],
      now: NOW,
    });
    expect(r.status).toBe('degraded');
    expect(r.lastErrorCode).toBe('gateway_http_502');
    expect(r.lastErrorSummary).not.toMatch(/ghp_/);
    expect(r.lastErrorSummary).toContain('‹redacted›');
  });

  it('classifies on the MOST RECENT failure — a newer error is not masked by an older rate-limit', () => {
    const r = assessIntegrationHealth({
      hasCredentials: true,
      mcpRegistered: true,
      recentFailures: [
        { code: 'rate_limited', kind: 'rate_limit', at: '2026-06-05T00:00:00Z' }, // older
        { code: 'gateway_http_502', at: '2026-06-06T00:00:00Z' }, // newer, not a rate limit
      ],
      now: NOW,
    });
    expect(r.status).toBe('degraded');
    expect(r.lastErrorCode).toBe('gateway_http_502');
  });

  it('does NOT classify rate_limited from free-text summary alone (only kind/code)', () => {
    const r = assessIntegrationHealth({
      hasCredentials: true,
      recentFailures: [{ code: 'gateway_http_502', summary: 'mentions rate limit in prose' }],
      now: NOW,
    });
    expect(r.status).toBe('degraded'); // not rate_limited
  });

  it('treats an auth/invalid-credential rejection (creds present) as degraded with an invalid-credential code', () => {
    expect(assessIntegrationHealth({ hasCredentials: true, recentFailures: [{ kind: 'auth' }], now: NOW }).lastErrorCode).toBe('invalid_credentials');
    const byCode = assessIntegrationHealth({ hasCredentials: true, recentFailures: [{ code: 'gateway_http_401' }], now: NOW });
    expect(byCode.status).toBe('degraded');
    expect(byCode.lastErrorCode).toBe('gateway_http_401');
  });

  it('picks the most recent failure by timestamp for diagnostics', () => {
    const r = assessIntegrationHealth({
      hasCredentials: true,
      mcpRegistered: true,
      recentFailures: [
        { code: 'old', summary: 'older', at: '2026-06-05T00:00:00Z' },
        { code: 'new', summary: 'newer', at: '2026-06-06T00:00:00Z' },
      ],
      now: NOW,
    });
    expect(r.lastErrorCode).toBe('new');
  });
});
