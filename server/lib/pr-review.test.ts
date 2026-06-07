import { describe, expect, it } from 'vitest';
import {
  COMMENT_MARKER,
  PR_FINDINGS_SCHEMA_VERSION,
  type PrFinding,
  formatCommentBody,
  materiallyChanged,
  normalizeFixSummary,
  parseFindings,
  prFindingsSchema,
  reviewCommentWriteKey,
  revisionFingerprint,
  semanticFingerprint,
} from './pr-review';
import { schemaRegistry } from './schema-validation';

const REPO = 'pchen41/instrument';
const SHA = 'headaaa111';

function finding(over: Partial<PrFinding> = {}): PrFinding {
  return prFindingsSchema.parse({
    findings: [
      {
        issue_type: 'missing_latency_metric',
        file_path: 'src/checkout.ts',
        line_number: 42,
        side: 'RIGHT',
        code_anchor: 'checkoutHandler',
        severity: 'medium',
        body: 'This new handler makes an external call with no latency metric.',
        suggested_code: null,
        fix_summary: 'add p95 latency histogram around checkout handler',
        ...over,
      },
    ],
  }).findings[0];
}

describe('findings schema', () => {
  it('is registered for the external-post gate', () => {
    expect(schemaRegistry.has(PR_FINDINGS_SCHEMA_VERSION)).toBe(true);
  });
  it('accepts an empty findings array (no gap)', () => {
    expect(schemaRegistry.validate(PR_FINDINGS_SCHEMA_VERSION, { findings: [] }).status).toBe('valid');
  });
  it('rejects a finding missing the line number', () => {
    const res = schemaRegistry.validate(PR_FINDINGS_SCHEMA_VERSION, { findings: [{ issue_type: 'x', file_path: 'a.ts', body: 'b', fix_summary: 'f' }] });
    expect(res.status).toBe('invalid');
  });
  it('defaults side=RIGHT and severity=medium', () => {
    const parsed = prFindingsSchema.parse({ findings: [{ issue_type: 'x', file_path: 'a.ts', line_number: 3, body: 'b', fix_summary: 'f' }] });
    expect(parsed.findings[0]).toMatchObject({ side: 'RIGHT', severity: 'medium' });
  });
});

describe('parseFindings', () => {
  it('extracts the JSON object from a noisy completion', () => {
    const text = 'Here is my review:\n```json\n{"findings":[{"issue_type":"x","file_path":"a.ts","line_number":1,"body":"b","fix_summary":"f"}]}\n```\nDone.';
    const obj = parseFindings(text) as { findings: unknown[] };
    expect(obj.findings).toHaveLength(1);
  });
  it('falls back to empty findings on unparseable text', () => {
    expect(parseFindings('no json here')).toEqual({ findings: [] });
  });
});

describe('fingerprints', () => {
  it('semantic is stable across a line shift but revision is not', () => {
    const a = finding({ line_number: 42 });
    const b = finding({ line_number: 88 }); // same gap, moved lines
    expect(semanticFingerprint(REPO, a)).toBe(semanticFingerprint(REPO, b));
    const sem = semanticFingerprint(REPO, a);
    expect(revisionFingerprint(sem, SHA, a)).not.toBe(revisionFingerprint(sem, SHA, b));
  });
  it('semantic changes when the fix or file changes', () => {
    const base = finding();
    expect(semanticFingerprint(REPO, finding({ fix_summary: 'totally different fix' }))).not.toBe(semanticFingerprint(REPO, base));
    expect(semanticFingerprint(REPO, finding({ file_path: 'src/other.ts' }))).not.toBe(semanticFingerprint(REPO, base));
  });
  it('normalizeFixSummary collapses cosmetic differences', () => {
    expect(normalizeFixSummary('Add `p95` Latency-histogram!!')).toBe('add latency histogram');
  });
});

describe('materiallyChanged', () => {
  it('is false for a bare line shift (same suggested fix)', () => {
    expect(materiallyChanged({ suggested_code: null }, finding({ line_number: 90, suggested_code: null }))).toBe(false);
  });
  it('is true when the suggested fix changed', () => {
    expect(materiallyChanged({ suggested_code: null }, finding({ suggested_code: 'metrics.timing("checkout", ms)' }))).toBe(true);
    expect(materiallyChanged({ suggested_code: 'old' }, finding({ suggested_code: 'new' }))).toBe(true);
  });
});

describe('reviewCommentWriteKey', () => {
  it('is stable per pull request + revision fingerprint', () => {
    const f = finding();
    const rev = revisionFingerprint(semanticFingerprint(REPO, f), SHA, f);
    expect(reviewCommentWriteKey('pr-1', rev)).toBe(reviewCommentWriteKey('pr-1', rev));
    expect(reviewCommentWriteKey('pr-1', rev).startsWith('github_review_comment:pr-1:')).toBe(true);
  });
});

describe('formatCommentBody', () => {
  it('includes the marker and a suggestion block, scrubbing secrets', () => {
    const body = formatCommentBody(finding({ body: 'leak ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', suggested_code: 'x' }));
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain('```suggestion');
    expect(body).not.toMatch(/ghp_/);
  });
  it('omits the suggestion block when there is no suggested code', () => {
    expect(formatCommentBody(finding({ suggested_code: null }))).not.toContain('```suggestion');
  });
});
