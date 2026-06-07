import { describe, expect, it } from 'vitest';
import {
  assertApprovalTransition,
  assertRecommendationTransition,
  canRetryJob,
  canStartInvestigation,
  TransitionError,
} from './transitions';

describe('transitions', () => {
  it('allows dismiss + restore but not reviving an accepted recommendation', () => {
    expect(() => assertRecommendationTransition('active', 'dismissed')).not.toThrow();
    expect(() => assertRecommendationTransition('dismissed', 'active')).not.toThrow();
    expect(() => assertRecommendationTransition('accepted', 'active')).toThrow(TransitionError);
    expect(() => assertRecommendationTransition('outdated', 'active')).toThrow(TransitionError);
  });

  it('enforces the approval state machine', () => {
    expect(() => assertApprovalTransition('requested', 'approved')).not.toThrow();
    expect(() => assertApprovalTransition('requested', 'rejected')).not.toThrow();
    expect(() => assertApprovalTransition('approved', 'revoked')).not.toThrow();
    expect(() => assertApprovalTransition('rejected', 'approved')).toThrow(TransitionError);
    expect(() => assertApprovalTransition('executed', 'revoked')).toThrow(TransitionError);
  });

  it('only starts an investigation when none exists, and only retries safe failed jobs', () => {
    expect(canStartInvestigation(null)).toBe(true);
    expect(canStartInvestigation({ state: 'running' })).toBe(false);
    expect(canStartInvestigation({ state: 'failed' })).toBe(false); // failed → retry path

    expect(canRetryJob({ state: 'failed', safe_to_retry: true })).toBe(true);
    expect(canRetryJob({ state: 'failed', safe_to_retry: false })).toBe(false);
    expect(canRetryJob({ state: 'running', safe_to_retry: true })).toBe(false);
  });
});
