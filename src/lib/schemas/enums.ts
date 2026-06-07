import { z } from 'zod';

// JSON vocabularies from docs/ERD.md ("JSON Vocabularies"). These live only
// inside jsonb documents, so they are validated in application code rather than
// as Postgres enums.

export const jobPhaseState = z.enum([
  'pending',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'skipped',
]);

export const recommendationStepKind = z.enum([
  'code_pr',
  'datadog_new_monitor',
  'datadog_monitor_change',
  'dashboard_panel',
  'manual_check',
  'pr_review_record',
]);

export const recommendationStepState = z.enum([
  'locked',
  'available',
  'generating',
  'ready',
  'done',
  'failed',
  'skipped',
]);

export const metricExistenceState = z.enum([
  'verified_in_datadog',
  'expected_after_step',
  'unverified',
]);

export const stepCompletionSource = z.enum([
  'generated_pr_merged',
  'datadog_monitor_created',
  'external_monitor_change',
  'manual_mark',
  'pr_review_recorded',
  'dashboard_panel_added',
]);

export const incidentRootCauseType = z.enum(['code', 'runtime_config', 'upstream', 'unknown']);

// Reused typed-column enums that also appear inside jsonb documents.
export const confidenceLevel = z.enum(['high', 'likely', 'low']);
export type ConfidenceLevel = z.infer<typeof confidenceLevel>;
export const integrationProvider = z.enum(['github', 'datadog', 'truefoundry']);
export type IntegrationProviderName = z.infer<typeof integrationProvider>;
