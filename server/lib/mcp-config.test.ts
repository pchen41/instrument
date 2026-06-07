import { describe, expect, it } from 'vitest';
import { buildMcpServerConfig, findSecretLikeValues, isWriteTool, partitionTools } from './mcp-config';

const CHECKED = '2026-06-06T12:00:00.000Z';

describe('isWriteTool / partitionTools', () => {
  it('classifies GitHub read vs write tools (known list + patterns)', () => {
    const { read, write } = partitionTools('github', [
      'get_file_contents',
      'get_pull_request_diff',
      'list_commits',
      'create_pull_request',
      'add_comment_to_pending_review',
      'create_or_update_file',
      'merge_pull_request',
    ]);
    expect(read).toEqual(['get_file_contents', 'get_pull_request_diff', 'list_commits']);
    expect(write).toEqual(['add_comment_to_pending_review', 'create_or_update_file', 'create_pull_request', 'merge_pull_request']);
  });

  it('treats Datadog create_datadog_monitor as a write tool, reads stay read', () => {
    expect(isWriteTool('datadog', 'create_datadog_monitor')).toBe(true);
    const { read, write } = partitionTools('datadog', ['get_logs', 'query_metrics', 'list_monitors', 'create_datadog_monitor']);
    expect(read).toEqual(['get_logs', 'list_monitors', 'query_metrics']);
    expect(write).toEqual(['create_datadog_monitor']);
  });

  it('a read-only virtual MCP never classifies a tool as write', () => {
    expect(isWriteTool('instrument-investigation', 'create_branch')).toBe(false);
    const { read, write } = partitionTools('instrument-investigation', ['query_truefoundry_model_metrics', 'create_branch']);
    expect(write).toEqual([]);
    expect(read).toEqual(['create_branch', 'query_truefoundry_model_metrics']);
  });
});

describe('buildMcpServerConfig', () => {
  it('builds a non-secret config entry with explicit read/write allowlists', () => {
    const cfg = buildMcpServerConfig({
      name: 'github',
      serverUrl: 'https://gateway.truefoundry.ai/peterc/mcp/github/server',
      fqn: 'peterc:mcp:github',
      toolNames: ['list_commits', 'create_pull_request'],
      health: 'healthy',
      checkedAt: CHECKED,
    });
    expect(cfg).toMatchObject({
      name: 'github',
      fqn: 'peterc:mcp:github',
      server_url: 'https://gateway.truefoundry.ai/peterc/mcp/github/server',
      read_only: false,
      allowed_tools: { read: ['list_commits'], write: ['create_pull_request'] },
      health: 'healthy',
      last_checked_at: CHECKED,
    });
  });

  it('forces read_only for instrument-investigation and empties the write list', () => {
    const cfg = buildMcpServerConfig({
      name: 'instrument-investigation',
      serverUrl: 'https://gateway.truefoundry.ai/peterc/mcp/instrument-investigation/server',
      toolNames: ['get_truefoundry_trace_spans', 'create_datadog_monitor'],
      health: 'healthy',
      checkedAt: CHECKED,
    });
    expect(cfg.read_only).toBe(true);
    expect(cfg.allowed_tools.write).toEqual([]);
    expect(cfg.allowed_tools.read).toContain('create_datadog_monitor');
  });
});

describe('findSecretLikeValues', () => {
  it('returns [] for clean non-secret MCP config', () => {
    const clean = buildMcpServerConfig({
      name: 'datadog',
      serverUrl: 'https://gateway.truefoundry.ai/peterc/mcp/datadog/server',
      toolNames: ['get_logs', 'create_datadog_monitor'],
      health: 'healthy',
      checkedAt: CHECKED,
    });
    expect(findSecretLikeValues(clean)).toEqual([]);
  });

  it('flags a JWT/PAT value and a secret-named field', () => {
    expect(findSecretLikeValues({ token: 'github_pat_11ABCDEFGHIJKLMNOPQRSTUV' })).toContain('token');
    expect(findSecretLikeValues({ nested: { pat: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload' } })).toContain('nested.pat');
    expect(findSecretLikeValues({ auth: 'Bearer abc123def456' })).toContain('auth');
    expect(findSecretLikeValues({ note: 'plain text', count: 3 })).toEqual([]);
  });
});
