import { describe, expect, it } from 'vitest';
import { canonicalJson, hashPayload } from './hash';

describe('payload hashing', () => {
  it('canonicalises key order so equal payloads hash equally', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(hashPayload({ a: 1, b: { c: 3, d: 4 } })).toBe(hashPayload({ b: { d: 4, c: 3 }, a: 1 }));
  });

  it('produces a different hash when any value changes (stale-approval detection)', () => {
    expect(hashPayload({ branch: 'fix-1' })).not.toBe(hashPayload({ branch: 'fix-2' }));
  });
});
