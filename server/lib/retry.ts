import type { JobRow, RetryPolicy } from './types';

// Engine default backoff. base 20s, x2 per attempt, capped at 5 min. A job's own
// `retry_policy` column overrides any field. 20s base means a retrying job is
// visibly "investigating" across the console's 2s polling and resumes on the
// next ~1-min worker cron tick — the reliability story without a long wait.
export const DEFAULT_RETRY_POLICY: Required<RetryPolicy> = {
  max_attempts: 3,
  base_seconds: 20,
  factor: 2,
  max_seconds: 300,
};

export function resolvePolicy(job: Pick<JobRow, 'retry_policy' | 'max_attempts'>): Required<RetryPolicy> {
  const p = job.retry_policy ?? {};
  return {
    // `jobs.max_attempts` is the authoritative attempt budget (a real column);
    // retry_policy.max_attempts is only a fallback if the column is unset.
    max_attempts: job.max_attempts ?? p.max_attempts ?? DEFAULT_RETRY_POLICY.max_attempts,
    base_seconds: p.base_seconds ?? DEFAULT_RETRY_POLICY.base_seconds,
    factor: p.factor ?? DEFAULT_RETRY_POLICY.factor,
    max_seconds: p.max_seconds ?? DEFAULT_RETRY_POLICY.max_seconds,
  };
}

/** Backoff (seconds) before the given 1-based attempt's *next* retry. */
export function backoffSeconds(policy: Required<RetryPolicy>, attempt: number): number {
  const raw = policy.base_seconds * Math.pow(policy.factor, Math.max(0, attempt - 1));
  return Math.min(Math.round(raw), policy.max_seconds);
}

export interface ClassifiedError {
  retryable: boolean;
  code: string;
  summary: string;
  source: string | null;
}

/**
 * Map a thrown error to the engine's redacted failure shape. Errors raised by
 * the engine's own simulation carry the classification directly; anything else
 * is treated as a retryable worker error (transient by default, bounded by
 * max_attempts) with a redacted summary — we never surface raw provider/internal
 * detail to the console.
 */
export function classifyError(err: unknown): ClassifiedError {
  if (err && typeof err === 'object' && 'retryable' in err && 'code' in err) {
    const e = err as Partial<ClassifiedError>;
    return {
      retryable: !!e.retryable,
      code: e.code ?? 'worker_error',
      summary: e.summary ?? 'The job failed.',
      source: e.source ?? null,
    };
  }
  return { retryable: true, code: 'worker_error', summary: 'The job hit an unexpected error.', source: 'worker' };
}

/** A classified error the engine throws to drive retry vs terminal failure. */
export class JobError extends Error implements ClassifiedError {
  retryable: boolean;
  code: string;
  summary: string;
  source: string | null;
  constructor(opts: ClassifiedError) {
    super(opts.summary);
    this.name = 'JobError';
    this.retryable = opts.retryable;
    this.code = opts.code;
    this.summary = opts.summary;
    this.source = opts.source;
  }
}

/**
 * Decide what happens after an attempt fails. A retryable error with budget left
 * → `retrying` and a scheduled next run; otherwise → terminal `failed`. The
 * attempt that just ran is `attempt` (1-based, == the post-increment count).
 */
export function decideAfterFailure(
  policy: Required<RetryPolicy>,
  attempt: number,
  error: ClassifiedError,
): { state: 'retrying'; backoffSeconds: number } | { state: 'failed' } {
  const hasBudget = attempt < policy.max_attempts;
  if (error.retryable && hasBudget) {
    return { state: 'retrying', backoffSeconds: backoffSeconds(policy, attempt) };
  }
  return { state: 'failed' };
}
