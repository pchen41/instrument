import { describe, expect, it } from 'vitest';
import {
  SCAN_FINDINGS_SCHEMA_VERSION,
  type ScanFinding,
  buildScanMessages,
  recommendationFields,
  scanDedupeFingerprint,
  scanFindingsSchema,
} from './scan';
import { schemaRegistry } from './schema-validation';

const REPO = 'pchen41/instrument';
function finding(over: Partial<ScanFinding> = {}): ScanFinding {
  return scanFindingsSchema.parse({
    findings: [{ issue_type: 'missing_metric', file_path: 'src/checkout.ts', code_anchor: 'handleCheckout', title: 'Add checkout latency metric', rationale: 'The new handler has no latency metric.', proposed_next_step: 'Add a p95 histogram around the call.', severity: 'medium', ...over }],
  }).findings[0];
}

describe('scan findings schema', () => {
  it('is registered', () => expect(schemaRegistry.has(SCAN_FINDINGS_SCHEMA_VERSION)).toBe(true));
  it('accepts an empty findings array', () => {
    expect(schemaRegistry.validate(SCAN_FINDINGS_SCHEMA_VERSION, { findings: [] }).status).toBe('valid');
  });
  it('drops a malformed finding but keeps the batch', () => {
    const res = schemaRegistry.validate<{ findings: unknown[] }>(SCAN_FINDINGS_SCHEMA_VERSION, {
      findings: [{ issue_type: 'x', file_path: 'a.ts' }, finding()], // first missing title/rationale/next_step → dropped
    });
    expect(res.status).toBe('valid');
    expect(res.value!.findings).toHaveLength(1);
  });
  it('treats a non-array root as invalid', () => {
    expect(schemaRegistry.validate(SCAN_FINDINGS_SCHEMA_VERSION, { findings: 'bad' }).status).toBe('invalid');
  });
});

describe('scanDedupeFingerprint', () => {
  it('is stable across reworded issue_type (same anchor) but distinguishes kinds + files', () => {
    const base = finding({ issue_type: 'missing_metric' });
    expect(scanDedupeFingerprint(REPO, finding({ issue_type: 'no latency metric' }))).toBe(scanDedupeFingerprint(REPO, base));
    expect(scanDedupeFingerprint(REPO, finding({ issue_type: 'missing_log' }))).not.toBe(scanDedupeFingerprint(REPO, base));
    expect(scanDedupeFingerprint(REPO, finding({ file_path: 'src/other.ts' }))).not.toBe(scanDedupeFingerprint(REPO, base));
  });
  it('is prefixed for readability', () => {
    expect(scanDedupeFingerprint(REPO, finding()).startsWith('instr:')).toBe(true);
  });
});

describe('recommendationFields', () => {
  it('scrubs + bounds and builds an affected code path', () => {
    const f = recommendationFields(finding({ title: 'leak ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' }));
    expect(f.title).not.toMatch(/ghp_/);
    expect(f.affectedCodePath).toContain('src/checkout.ts');
  });
});

describe('buildScanMessages', () => {
  it('includes the repo, branch, and changed code', () => {
    const m = buildScanMessages({ repoFullName: REPO, branch: 'main', headSha: 'abc1234', changedCode: 'DIFF_HERE' });
    expect(m[0].role).toBe('system');
    expect(m[1].content).toContain('DIFF_HERE');
    expect(m[1].content).toContain(REPO);
  });
});
