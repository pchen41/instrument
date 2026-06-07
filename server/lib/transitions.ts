import type { ApprovalState, JobRow, RecommendationState } from './types';

// Allowed state transitions, in one place so every endpoint enforces the same
// rules a database trigger eventually would (docs/ERD.md "RLS and Security").
// A rejected transition is a 409, not a silent no-op.

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

// ---- Recommendations --------------------------------------------------------

const RECOMMENDATION_TRANSITIONS: Record<RecommendationState, RecommendationState[]> = {
  active: ['dismissed', 'accepted', 'outdated'],
  dismissed: ['active'], // restore
  accepted: [],
  outdated: [],
};

export function assertRecommendationTransition(from: RecommendationState, to: RecommendationState): void {
  if (!RECOMMENDATION_TRANSITIONS[from]?.includes(to)) {
    throw new TransitionError(`Cannot move recommendation from ${from} to ${to}.`);
  }
}

// ---- Approvals --------------------------------------------------------------

const APPROVAL_TRANSITIONS: Record<ApprovalState, ApprovalState[]> = {
  requested: ['approved', 'rejected'],
  approved: ['revoked', 'executed'],
  rejected: [],
  revoked: [],
  executed: [],
};

export function assertApprovalTransition(from: ApprovalState, to: ApprovalState): void {
  if (!APPROVAL_TRANSITIONS[from]?.includes(to)) {
    throw new TransitionError(`Cannot move approval from ${from} to ${to}.`);
  }
}

// ---- Investigation jobs -----------------------------------------------------

/** An incident can start an investigation only when none is in flight. */
export function canStartInvestigation(job: Pick<JobRow, 'state'> | null): boolean {
  if (!job) return true;
  // A previously failed investigation is restarted through the retry path, not
  // start; queued/running/retrying/succeeded all block a fresh start.
  return false;
}

/** Manual retry is allowed only for a job that terminally failed and is safe. */
export function canRetryJob(job: Pick<JobRow, 'state' | 'safe_to_retry'>): boolean {
  return job.state === 'failed' && job.safe_to_retry === true;
}
