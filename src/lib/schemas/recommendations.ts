import { z } from 'zod';
import { isoTimestamp, uuid } from './common';
import {
  integrationProvider,
  metricExistenceState,
  recommendationStepKind,
  recommendationStepState,
  stepCompletionSource,
} from './enums';

// Schemas are `.strict()` so a misspelled or unexpected key is rejected rather
// than silently stripped — these validators exist to catch AI-output / seed
// field-name drift before it is written or rendered.

// Generated-PR result captured on a code_pr step. Folds generated_pull_requests:
// the planned/generated state lives here until GitHub sync creates the
// github_pull_requests row. Patch excerpts/hashes only — GitHub is authoritative.
export const generatedPrResult = z
  .object({
    number: z.number().int().positive().nullish(),
    branch: z.string().nullish(),
    url: z.string().url().nullish(),
    files: z.array(z.string()).nullish(),
    patch_excerpt: z.string().nullish(),
  })
  .strict();

// Reviewable Datadog monitor diff for a datadog_monitor_change step.
export const monitorConfigurationDiff = z
  .object({
    monitor: z.string().nullish(),
    rows: z
      .array(
        z
          .object({
            k: z.string(),
            v: z.string().nullish(),
            from: z.string().nullish(),
            to: z.string().nullish(),
          })
          .strict(),
      )
      .nullish(),
  })
  .strict();

// Generated draft Datadog monitor result for a datadog_new_monitor step. Draft
// only — publishing notifying monitors is later scope (docs/ERD.md).
export const generatedMonitorResult = z
  .object({
    monitor_id: z.string().nullish(),
    name: z.string().nullish(),
    url: z.string().url().nullish(),
    draft: z.boolean().nullish(),
  })
  .strict();

// recommendations.steps[] — ordered, dependent step objects. A later step stays
// `locked` until its prerequisite step is `done` (each step is its own reviewed
// change; there is no single "do it all" action).
export const recommendationStep = z
  .object({
    key: z.string().min(1),
    order: z.number().int().nonnegative(),
    kind: recommendationStepKind,
    state: recommendationStepState,
    label: z.string().min(1),
    prerequisite_step_key: z.string().nullish(),
    waits_for: z.string().nullish(),
    target_provider: integrationProvider.nullish(),
    proposed_payload: z.record(z.unknown()).nullish(),
    generated_pr: generatedPrResult.nullish(),
    configuration_diff: monitorConfigurationDiff.nullish(),
    generated_monitor: generatedMonitorResult.nullish(),
    // ERD calls this metric_existence_state (vocab) / steps[].verification_state.
    metric_verification_state: metricExistenceState.nullish(),
    approval_id: uuid.nullish(),
    job_id: uuid.nullish(),
    completion_source: stepCompletionSource.nullish(),
    completion_evidence_id: uuid.nullish(),
    created_at: isoTimestamp.nullish(),
    updated_at: isoTimestamp.nullish(),
  })
  .strict();
export type RecommendationStep = z.infer<typeof recommendationStep>;

// recommendations.lifecycle_events[] — bounded state history (folds
// recommendation_events).
export const recommendationLifecycleEvent = z
  .object({
    at: isoTimestamp,
    event: z.string().min(1),
    detail: z.string().nullish(),
    job_id: uuid.nullish(),
  })
  .strict();
export type RecommendationLifecycleEvent = z.infer<typeof recommendationLifecycleEvent>;
