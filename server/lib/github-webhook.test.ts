import { describe, expect, it } from 'vitest';
import { hmacSha256Hex } from './hash';
import {
  boundedHeaderValue,
  boundedPullRequestPayload,
  isAnalysisAction,
  isLifecycleAction,
  parsePullRequestEvent,
  prCorrelationKey,
  prLifecycleReason,
  prReviewJobKey,
  redactedHeaders,
  verifyGithubSignature,
} from './github-webhook';

const SECRET = 'whsec_test_0123456789abcdef';

// A minimal but realistic `pull_request` payload; `over` lets each test tweak it.
function prPayload(over: { action?: string; sha?: string; state?: string; draft?: boolean; merged?: boolean; merged_at?: string | null; closed_at?: string | null } = {}): Record<string, unknown> {
  return {
    action: over.action ?? 'opened',
    number: 42,
    pull_request: {
      node_id: 'PR_kwDOABC',
      number: 42,
      title: 'Add checkout latency timing',
      state: over.state ?? 'open',
      draft: over.draft ?? false,
      merged: over.merged ?? false,
      user: { login: 'octocat' },
      base: { ref: 'main', sha: 'base000' },
      head: { ref: 'feat/checkout-timing', sha: over.sha ?? 'headaaa111' },
      html_url: 'https://github.com/pchen41/instrument/pull/42',
      created_at: '2026-06-06T10:00:00Z',
      updated_at: '2026-06-06T10:05:00Z',
      closed_at: over.closed_at ?? null,
      merged_at: over.merged_at ?? null,
    },
    repository: {
      id: 9090,
      name: 'instrument',
      full_name: 'pchen41/instrument',
      owner: { login: 'pchen41' },
      default_branch: 'main',
      html_url: 'https://github.com/pchen41/instrument',
      clone_url: 'https://github.com/pchen41/instrument.git',
      private: true,
    },
    sender: { login: 'octocat' },
  };
}

describe('verifyGithubSignature', () => {
  it('accepts a correct sha256 signature over the exact raw body', () => {
    const raw = JSON.stringify(prPayload());
    const sig = `sha256=${hmacSha256Hex(SECRET, raw)}`;
    expect(verifyGithubSignature(SECRET, raw, sig)).toBe(true);
  });

  it('rejects a tampered body (signature computed over the original)', () => {
    const raw = JSON.stringify(prPayload());
    const sig = `sha256=${hmacSha256Hex(SECRET, raw)}`;
    const tampered = raw.replace('octocat', 'attacker');
    expect(verifyGithubSignature(SECRET, tampered, sig)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const raw = JSON.stringify(prPayload());
    const sig = `sha256=${hmacSha256Hex('wrong-secret', raw)}`;
    expect(verifyGithubSignature(SECRET, raw, sig)).toBe(false);
  });

  it('fails closed on a missing secret or header', () => {
    const raw = JSON.stringify(prPayload());
    const sig = `sha256=${hmacSha256Hex(SECRET, raw)}`;
    expect(verifyGithubSignature('', raw, sig)).toBe(false);
    expect(verifyGithubSignature(SECRET, raw, null)).toBe(false);
    expect(verifyGithubSignature(SECRET, raw, undefined)).toBe(false);
  });

  it('verifies over the raw request bytes (Uint8Array), matching the string body', () => {
    const raw = JSON.stringify(prPayload());
    const bytes = new TextEncoder().encode(raw);
    const sig = `sha256=${hmacSha256Hex(SECRET, bytes)}`;
    expect(verifyGithubSignature(SECRET, bytes, sig)).toBe(true);
    // the bytes-keyed signature also verifies against the equivalent string body
    expect(verifyGithubSignature(SECRET, raw, sig)).toBe(true);
  });
});

describe('boundedHeaderValue', () => {
  it('scrubs secret-shaped tokens and truncates to the cap', () => {
    expect(boundedHeaderValue('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).not.toMatch(/ghp_/);
    expect(boundedHeaderValue('x'.repeat(500))!.length).toBe(200);
    expect(boundedHeaderValue(null)).toBeNull();
    expect(boundedHeaderValue('')).toBeNull();
  });
});

describe('action classification', () => {
  it('treats opened/reopened/synchronize/ready_for_review as analysis actions', () => {
    for (const a of ['opened', 'reopened', 'synchronize', 'ready_for_review']) expect(isAnalysisAction(a)).toBe(true);
    expect(isAnalysisAction('closed')).toBe(false);
    expect(isAnalysisAction('labeled')).toBe(false);
    expect(isAnalysisAction(null)).toBe(false);
  });
  it('treats closed as a lifecycle action', () => {
    expect(isLifecycleAction('closed')).toBe(true);
    expect(isLifecycleAction('opened')).toBe(false);
  });
  it('maps the lifecycle outdated reason from merged vs closed', () => {
    expect(prLifecycleReason(true)).toBe('pr_merged');
    expect(prLifecycleReason(false)).toBe('pr_closed');
  });
});

describe('parsePullRequestEvent', () => {
  it('normalizes an opened event', () => {
    const parsed = parsePullRequestEvent(prPayload({ action: 'opened' }))!;
    expect(parsed.action).toBe('opened');
    expect(parsed.repo).toMatchObject({ owner: 'pchen41', name: 'instrument', fullName: 'pchen41/instrument', defaultBranch: 'main', externalRepoId: '9090' });
    expect(parsed.pr).toMatchObject({ number: 42, state: 'open', draft: false, merged: false, baseBranch: 'main', headBranch: 'feat/checkout-timing', headSha: 'headaaa111', authorLogin: 'octocat' });
    expect(parsed.senderLogin).toBe('octocat');
  });

  it('carries the new head sha on synchronize (a new revision)', () => {
    const parsed = parsePullRequestEvent(prPayload({ action: 'synchronize', sha: 'headbbb222' }))!;
    expect(parsed.pr.headSha).toBe('headbbb222');
  });

  it('maps a ready_for_review event with draft cleared', () => {
    const parsed = parsePullRequestEvent(prPayload({ action: 'ready_for_review', draft: false }))!;
    expect(parsed.action).toBe('ready_for_review');
    expect(parsed.pr.draft).toBe(false);
  });

  it('collapses closed+merged into state "merged"', () => {
    const parsed = parsePullRequestEvent(prPayload({ action: 'closed', state: 'closed', merged: true, merged_at: '2026-06-06T12:00:00Z', closed_at: '2026-06-06T12:00:00Z' }))!;
    expect(parsed.pr.state).toBe('merged');
    expect(parsed.pr.merged).toBe(true);
    expect(parsed.pr.mergedAt).toBe('2026-06-06T12:00:00Z');
  });

  it('keeps state "closed" for a closed-without-merge event', () => {
    const parsed = parsePullRequestEvent(prPayload({ action: 'closed', state: 'closed', merged: false, closed_at: '2026-06-06T12:00:00Z' }))!;
    expect(parsed.pr.state).toBe('closed');
    expect(parsed.pr.merged).toBe(false);
  });

  it('returns null when required fields are missing', () => {
    expect(parsePullRequestEvent({ action: 'opened' })).toBeNull(); // no pull_request/repository
    expect(parsePullRequestEvent({ action: 'opened', pull_request: {}, repository: {} })).toBeNull();
  });

  it('scrubs a secret-shaped token out of the PR title', () => {
    const payload = prPayload();
    (payload.pull_request as Record<string, unknown>).title = 'leak ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 here';
    const parsed = parsePullRequestEvent(payload)!;
    expect(parsed.pr.title).not.toMatch(/ghp_/);
    expect(parsed.pr.title).toContain('‹redacted›');
  });
});

describe('boundedPullRequestPayload', () => {
  it('keeps only bounded structured fields and no diff/body', () => {
    const bounded = boundedPullRequestPayload(prPayload());
    expect(bounded).toMatchObject({ action: 'opened', number: 42 });
    const pr = bounded.pull_request as Record<string, unknown>;
    expect(pr.head).toEqual({ ref: 'feat/checkout-timing', sha: 'headaaa111' });
    expect(pr.user).toEqual({ login: 'octocat' });
    // no free-form body, diff, commits, or review content survived
    expect(JSON.stringify(bounded)).not.toMatch(/diff|patch|"body"/i);
  });

  it('scrubs secret-shaped tokens from free-text fields', () => {
    const payload = prPayload();
    (payload.pull_request as Record<string, unknown>).title = 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bounded = boundedPullRequestPayload(payload);
    expect(JSON.stringify(bounded)).not.toMatch(/ghp_/);
  });
});

describe('redactedHeaders', () => {
  it('keeps identifiers and never stores the signature value', () => {
    const headers: Record<string, string> = {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'd-123',
      'x-github-hook-id': '55',
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=deadbeef',
    };
    const red = redactedHeaders((n) => headers[n] ?? null);
    expect(red).toMatchObject({ event: 'pull_request', delivery: 'd-123', hook_id: '55', signature_present: true });
    expect(JSON.stringify(red)).not.toContain('deadbeef');
  });

  it('bounds oversized attacker-controlled header values', () => {
    const red = redactedHeaders((n) => (n === 'x-github-delivery' ? 'd'.repeat(500) : n === 'x-github-event' ? 'pull_request' : null));
    expect((red.delivery as string).length).toBe(200);
  });
});

describe('idempotency keys', () => {
  it('collapses same-revision deliveries and separates new revisions', () => {
    expect(prReviewJobKey('pr-uuid', 'headaaa111')).toBe('pr_review:pr-uuid:headaaa111');
    expect(prReviewJobKey('pr-uuid', 'headaaa111')).toBe(prReviewJobKey('pr-uuid', 'headaaa111'));
    expect(prReviewJobKey('pr-uuid', 'headbbb222')).not.toBe(prReviewJobKey('pr-uuid', 'headaaa111'));
  });
  it('builds a stable PR correlation key', () => {
    const parsed = parsePullRequestEvent(prPayload())!;
    expect(prCorrelationKey(parsed.repo, parsed.pr.number)).toBe('pchen41/instrument#42');
  });
});
