import { describe, expect, it } from 'vitest';
import {
  backoffSeconds,
  classifyError,
  decideAfterFailure,
  DEFAULT_RETRY_POLICY,
  JobError,
  resolvePolicy,
} from './retry';

describe('retry policy', () => {
  it('resolves the job column max_attempts over the policy default', () => {
    expect(resolvePolicy({ retry_policy: {}, max_attempts: 5 }).max_attempts).toBe(5);
    expect(resolvePolicy({ retry_policy: { base_seconds: 10 }, max_attempts: 3 }).base_seconds).toBe(10);
  });

  it('grows backoff exponentially and caps at max_seconds', () => {
    const p = { ...DEFAULT_RETRY_POLICY, base_seconds: 20, factor: 2, max_seconds: 300 };
    expect(backoffSeconds(p, 1)).toBe(20);
    expect(backoffSeconds(p, 2)).toBe(40);
    expect(backoffSeconds(p, 3)).toBe(80);
    expect(backoffSeconds(p, 10)).toBe(300); // capped
  });

  it('retries when retryable with budget left, otherwise fails terminally', () => {
    const p = resolvePolicy({ retry_policy: {}, max_attempts: 3 });
    expect(decideAfterFailure(p, 1, { retryable: true, code: 'x', summary: '', source: null })).toEqual({
      state: 'retrying',
      backoffSeconds: 20,
    });
    // budget exhausted (attempt == max_attempts)
    expect(decideAfterFailure(p, 3, { retryable: true, code: 'x', summary: '', source: null })).toEqual({
      state: 'failed',
    });
    // non-retryable fails even with budget
    expect(decideAfterFailure(p, 1, { retryable: false, code: 'x', summary: '', source: null })).toEqual({
      state: 'failed',
    });
  });

  it('classifies a JobError directly and unknown errors as retryable worker errors', () => {
    const je = new JobError({ retryable: false, code: 'fatal', summary: 'boom', source: 'github' });
    expect(classifyError(je)).toMatchObject({ retryable: false, code: 'fatal', source: 'github' });
    expect(classifyError(new Error('whoops'))).toMatchObject({ retryable: true, code: 'worker_error' });
  });
});
