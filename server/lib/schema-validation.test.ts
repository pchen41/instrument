import { describe, expect, it } from 'vitest';
import {
  SchemaRegistry,
  SchemaValidationError,
  assertValidForDisplay,
  assertValidForExternalPosting,
  z,
} from './schema-validation';

// A representative structured-output schema (the kind Tasks 6/7/9/11/12 will
// register): a ranked-hypotheses block for an incident summary.
const hypothesesSchema = z.object({
  hypotheses: z
    .array(
      z.object({
        rank: z.number().int().positive(),
        summary: z.string().min(1),
        confidence: z.enum(['high', 'likely', 'low']),
      }),
    )
    .min(1)
    .max(3),
});

function freshRegistry(): SchemaRegistry {
  return new SchemaRegistry().register('incident_hypotheses.v1', hypothesesSchema);
}

describe('SchemaRegistry.validate', () => {
  it('returns valid + parsed value for conforming output', () => {
    const r = freshRegistry().validate('incident_hypotheses.v1', {
      hypotheses: [{ rank: 1, summary: 'connection pool exhausted', confidence: 'high' }],
    });
    expect(r.status).toBe('valid');
    expect(r.errors).toEqual([]);
    expect((r.value as { hypotheses: unknown[] }).hypotheses).toHaveLength(1);
  });

  it('returns invalid + errors for non-conforming output', () => {
    const r = freshRegistry().validate('incident_hypotheses.v1', {
      hypotheses: [{ rank: 0, summary: '', confidence: 'maybe' }],
    });
    expect(r.status).toBe('invalid');
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.join(' ')).toMatch(/hypotheses\.0/);
  });

  it('is not_applicable when no version is requested (freeform output)', () => {
    const r = freshRegistry().validate(undefined, 'any text');
    expect(r.status).toBe('not_applicable');
    expect(r.errors).toEqual([]);
  });

  it('is not_applicable (never valid) for an unregistered version, with a reason', () => {
    const r = freshRegistry().validate('does_not_exist.v9', { anything: true });
    expect(r.status).toBe('not_applicable');
    expect(r.errors[0]).toMatch(/not registered/);
  });

  it('assertRegistered throws for an unknown version', () => {
    expect(() => freshRegistry().assertRegistered('nope.v1')).toThrow(/no structured-output schema/);
    expect(() => freshRegistry().assertRegistered('incident_hypotheses.v1')).not.toThrow();
  });
});

describe('release gates', () => {
  it('display blocks invalid but allows valid and freeform', () => {
    expect(() => assertValidForDisplay({ status: 'invalid', errors: ['bad'] })).toThrow(SchemaValidationError);
    expect(() => assertValidForDisplay({ status: 'valid', errors: [] })).not.toThrow();
    expect(() => assertValidForDisplay({ status: 'not_applicable', errors: [] })).not.toThrow();
  });

  it('external posting requires valid — rejects invalid AND not_applicable', () => {
    expect(() => assertValidForExternalPosting({ status: 'valid', errors: [] })).not.toThrow();
    expect(() => assertValidForExternalPosting({ status: 'invalid', errors: ['bad'] })).toThrow(/refusing to post/);
    expect(() => assertValidForExternalPosting({ status: 'not_applicable', errors: [] })).toThrow(/no validated schema/);
  });

  it('SchemaValidationError carries status + errors', () => {
    try {
      assertValidForExternalPosting({ status: 'invalid', errors: ['hypotheses.0.rank: too small'] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaValidationError);
      expect((e as SchemaValidationError).status).toBe('invalid');
      expect((e as SchemaValidationError).errors).toContain('hypotheses.0.rank: too small');
    }
  });
});
