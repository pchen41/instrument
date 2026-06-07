import { describe, expect, it } from 'vitest';
import {
  COMMENT_MARKER,
  PR_FINDINGS_SCHEMA_VERSION,
  type PrFinding,
  formatCommentBody,
  issueKind,
  parseFindings,
  prFindingsSchema,
  prReviewDedupeFingerprint,
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
  it('drops a malformed finding (missing line) but keeps the batch valid', () => {
    const res = schemaRegistry.validate<{ findings: unknown[] }>(PR_FINDINGS_SCHEMA_VERSION, {
      findings: [
        { issue_type: 'x', file_path: 'a.ts', body: 'b', fix_summary: 'f' }, // no line → dropped
        { issue_type: 'y', file_path: 'b.ts', line_number: 5, body: 'b', fix_summary: 'f' }, // valid → kept
      ],
    });
    expect(res.status).toBe('valid');
    expect(res.value!.findings).toHaveLength(1);
  });
  it('defaults side=RIGHT and severity=medium; coerces a string line and an out-of-enum severity', () => {
    const parsed = prFindingsSchema.parse({ findings: [{ issue_type: 'x', file_path: 'a.ts', line_number: '3', severity: 'major', body: 'b', fix_summary: 'f' }] });
    expect(parsed.findings[0]).toMatchObject({ side: 'RIGHT', severity: 'medium', line_number: 3 });
  });
});

describe('parseFindings', () => {
  it('extracts the JSON object from a noisy completion', () => {
    const text = 'Here is my review:\n```json\n{"findings":[{"issue_type":"x","file_path":"a.ts","line_number":1,"body":"b","fix_summary":"f"}]}\n```\nDone.';
    const obj = parseFindings(text) as { findings: unknown[] };
    expect(obj.findings).toHaveLength(1);
  });
  it('returns null on unparseable text (so the schema flags it invalid, not a clean 0-gap run)', () => {
    expect(parseFindings('no json here')).toBeNull();
    expect(schemaRegistry.validate(PR_FINDINGS_SCHEMA_VERSION, parseFindings('no json')).status).toBe('invalid');
    expect(schemaRegistry.validate(PR_FINDINGS_SCHEMA_VERSION, parseFindings('{"findings":[]}')).status).toBe('valid');
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
  it('semantic is INVARIANT to the model rewording the same gap (issue_type buckets to one kind)', () => {
    // observed-live wordings for the SAME missing-instrumentation gap, same anchor
    const base = finding({ issue_type: 'missing_telemetry', fix_summary: 'add a timer' });
    const reworded = finding({ issue_type: 'uninstrumented_external_call', fix_summary: 'wrap the fetch in a histogram' });
    expect(semanticFingerprint(REPO, reworded)).toBe(semanticFingerprint(REPO, base));
  });
  it('distinguishes two different gap KINDS on the same anchor (no collapse)', () => {
    const metric = finding({ issue_type: 'missing_metric' });
    const errors = finding({ issue_type: 'missing_error_handling' });
    expect(semanticFingerprint(REPO, errors)).not.toBe(semanticFingerprint(REPO, metric));
  });
  it('semantic changes when the file or code anchor changes', () => {
    const base = finding();
    expect(semanticFingerprint(REPO, finding({ code_anchor: 'someOtherFunction' }))).not.toBe(semanticFingerprint(REPO, base));
    expect(semanticFingerprint(REPO, finding({ file_path: 'src/other.ts' }))).not.toBe(semanticFingerprint(REPO, base));
  });
  it('issueKind buckets reworded synonyms together but separates real kinds', () => {
    expect(issueKind('missing_telemetry')).toBe(issueKind('uninstrumented_external_call')); // both → trace/instrument bucket
    expect(issueKind('missing_metric')).toBe('metric');
    expect(issueKind('swallowed exception')).toBe('error_handling');
    expect(issueKind('missing_log')).toBe('log');
  });
});

describe('prReviewDedupeFingerprint', () => {
  it('is one stable key per PR, case-insensitive on the repo', () => {
    expect(prReviewDedupeFingerprint('pchen41/instrument', 42)).toBe('pr_review:pchen41/instrument#42');
    expect(prReviewDedupeFingerprint('PChen41/Instrument', 42)).toBe(prReviewDedupeFingerprint('pchen41/instrument', 42));
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
