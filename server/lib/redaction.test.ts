import { describe, expect, it } from 'vitest';
import { findSecretLikeValues, isSecretValue, scrubSecrets } from './redaction';

describe('isSecretValue — catches embedded tokens (not just ^-anchored)', () => {
  it('catches provider token shapes anywhere in the string', () => {
    expect(isSecretValue('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toBe(true);
    expect(isSecretValue('prefix github_pat_11ABCDEFGHIJKLMNOPQRSTUV more')).toBe(true);
    expect(isSecretValue('Authorization: Bearer eyJabcdefgh.payloadpart.sigpart')).toBe(true);
    expect(isSecretValue('eyJhbGciOiJSUzI1NiIs.eyJzdWIiOiJ4.signature_here')).toBe(true); // JWT mid-/start
    expect(isSecretValue('use key sk-proj-ABCDEFGHIJKLMNOPQRSTUV here')).toBe(true); // sk-proj
  });
  it('does not flag ordinary strings', () => {
    expect(isSecretValue('task-runner')).toBe(false); // not an sk- key
    expect(isSecretValue('instrument/instrument')).toBe(false);
    expect(isSecretValue('a1b2c3d')).toBe(false);
    expect(isSecretValue('https://gateway.truefoundry.ai/peterc/mcp/github/server')).toBe(false);
  });
});

describe('scrubSecrets', () => {
  it('masks every secret-shaped occurrence', () => {
    const s = scrubSecrets('a=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 b=ghp_ZYXWVUTSRQPONMLKJIHGFEDCBA543210');
    expect(s).not.toMatch(/ghp_/);
    expect(s.match(/‹redacted›/g)).toHaveLength(2);
  });
  it('leaves clean text untouched', () => {
    expect(scrubSecrets('p95 rose 180ms→920ms')).toBe('p95 rose 180ms→920ms');
  });
});

describe('findSecretLikeValues', () => {
  it('flags secret-named fields and secret-shaped values, by path', () => {
    expect(findSecretLikeValues({ token: 'github_pat_11ABCDEFGHIJKLMNOPQRSTUV' })).toContain('token');
    expect(findSecretLikeValues({ datadog_key: 'whatever' })).toContain('datadog_key'); // bare *_key name
    expect(findSecretLikeValues({ key: 'x' })).toContain('key');
    expect(findSecretLikeValues({ nested: { pat: 'eyJhbGc.eyJzdWI.sig_here' } })).toContain('nested.pat');
    expect(findSecretLikeValues({ a: { b: 'Authorization: Bearer eyJaa.bbccdd.eeffgg' } })).toContain('a.b'); // embedded value
  });
  it('returns [] for clean config-shaped objects', () => {
    expect(findSecretLikeValues({ server_url: 'https://gateway.truefoundry.ai/peterc/mcp/github/server', allowed_tools: { read: ['list_commits'], write: ['create_pull_request'] }, health: 'healthy', model_fqn: 'peterc:virtual-model:instrument/instrument' })).toEqual([]);
    expect(findSecretLikeValues({ note: 'plain text', count: 3, monkey: 'banana' })).toEqual([]);
  });
});
