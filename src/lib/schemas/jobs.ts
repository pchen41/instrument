import { z } from 'zod';
import { isoTimestamp } from './common';
import { jobPhaseState } from './enums';

// jobs.phases[] — ordered, UI-ready progress objects.
export const jobPhase = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    state: jobPhaseState,
    started_at: isoTimestamp.nullish(),
    completed_at: isoTimestamp.nullish(),
    detail: z.string().nullish(),
  })
  .strict();
export type JobPhase = z.infer<typeof jobPhase>;

// jobs.attempts[] — bounded retry-attempt summaries. The reliability proof reads
// these (e.g. TrueFoundry rate-limit retries on the job worker).
export const jobAttempt = z
  .object({
    attempt: z.number().int().nonnegative(),
    outcome: z.enum(['succeeded', 'failed', 'retrying']),
    started_at: isoTimestamp,
    completed_at: isoTimestamp.nullish(),
    error_code: z.string().nullish(),
    error_summary: z.string().nullish(),
    next_run_at: isoTimestamp.nullish(),
  })
  .strict();
export type JobAttempt = z.infer<typeof jobAttempt>;

// jobs.audit_events[] — bounded, UI-safe audit notes.
export const jobAuditEvent = z
  .object({
    at: isoTimestamp,
    kind: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();
export type JobAuditEvent = z.infer<typeof jobAuditEvent>;
