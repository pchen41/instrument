import { describe, expect, it } from 'vitest';
import {
  PR_GEN_SCHEMA_VERSION,
  branchWriteKey,
  buildPatchMessages,
  buildPrBody,
  fileWriteKey,
  parsePatch,
  prGenBranchName,
  prGenPatchSchema,
  prWriteKey,
} from './pr-gen';
import { schemaRegistry } from './schema-validation';

describe('pr-gen patch schema', () => {
  it('is registered', () => expect(schemaRegistry.has(PR_GEN_SCHEMA_VERSION)).toBe(true));
  it('accepts a valid patch', () => {
    const v = schemaRegistry.validate(PR_GEN_SCHEMA_VERSION, { files: [{ path: 'a.ts', content: 'new content' }], pr_title: 'Add metric', pr_summary: 'Adds a latency metric.' });
    expect(v.status).toBe('valid');
  });
  it('rejects empty files or missing title', () => {
    expect(schemaRegistry.validate(PR_GEN_SCHEMA_VERSION, { files: [], pr_title: 't', pr_summary: 's' }).status).toBe('invalid');
    expect(schemaRegistry.validate(PR_GEN_SCHEMA_VERSION, { files: [{ path: 'a', content: 'c' }], pr_summary: 's' }).status).toBe('invalid');
  });
});

describe('parsePatch', () => {
  it('extracts the JSON object from noisy text', () => {
    const obj = parsePatch('```json\n{"files":[{"path":"a","content":"c"}],"pr_title":"t","pr_summary":"s"}\n```') as any;
    expect(obj.files[0].path).toBe('a');
  });
  it('returns null on unparseable text', () => expect(parsePatch('nope')).toBeNull());
});

describe('prGenBranchName', () => {
  it('is deterministic + namespaced (stable across retries)', () => {
    expect(prGenBranchName('rec-1', 'step-a')).toBe(prGenBranchName('rec-1', 'step-a'));
    expect(prGenBranchName('rec-1', 'step-a').startsWith('instrument/instr-')).toBe(true);
    expect(prGenBranchName('rec-1', 'step-a')).not.toBe(prGenBranchName('rec-1', 'step-b'));
  });
});

describe('external write keys', () => {
  it('are distinct per write kind + stable', () => {
    expect(branchWriteKey('r', 's')).toBe('github_create_branch:r:s');
    expect(prWriteKey('r', 's')).toBe('github_create_pr:r:s');
    expect(fileWriteKey('r', 's', 'a.ts')).toBe(fileWriteKey('r', 's', 'a.ts'));
    expect(fileWriteKey('r', 's', 'a.ts')).not.toBe(fileWriteKey('r', 's', 'b.ts'));
  });
});

describe('buildPrBody', () => {
  it('includes the marker + scrubs secrets', () => {
    const body = buildPrBody({ summary: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', recommendationTitle: 'Add metric', rationale: 'r' });
    expect(body).toContain('<!-- instrument:generated-pr -->');
    expect(body).not.toMatch(/ghp_/);
  });
});

describe('buildPatchMessages', () => {
  it('includes the current file content + the recommendation', () => {
    const m = buildPatchMessages({ repoFullName: 'o/r', recommendationTitle: 'Add metric', recommendationRationale: 'rr', proposedNextStep: 'ns', filePath: 'a.ts', currentContent: 'CURRENT_CODE' });
    expect(m[1].content).toContain('CURRENT_CODE');
    expect(m[1].content).toContain('a.ts');
  });
});

// quick guard that the schema bounds large content
describe('patch content bounds', () => {
  it('rejects oversized file content', () => {
    expect(prGenPatchSchema.safeParse({ files: [{ path: 'a', content: 'x'.repeat(40_001) }], pr_title: 't', pr_summary: 's' }).success).toBe(false);
  });
});
