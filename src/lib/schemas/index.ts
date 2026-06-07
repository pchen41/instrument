// Runtime validation for the jsonb shapes stored in the first-slice schema.
// Each entry in COLUMN_SCHEMAS maps a `table.column` jsonb array to the element
// schema its documents must satisfy (docs/ERD.md table notes + "JSON
// Vocabularies"). Used by tests now and by edge functions/workers later, so AI
// output is validated before it is written or rendered.
import { z } from 'zod';
import { jobAttempt, jobAuditEvent, jobPhase } from './jobs';
import { serviceMapEntry } from './repositories';
import { recommendationLifecycleEvent, recommendationStep } from './recommendations';
import {
  incidentCorrelatedChange,
  incidentHypothesis,
  incidentSignal,
  incidentTimelineEntry,
} from './incidents';
import { toolCallRedacted } from './ai';

export * from './enums';
export * from './common';
export * from './jobs';
export * from './repositories';
export * from './recommendations';
export * from './incidents';
export * from './ai';

// Element schema per jsonb-array column. The stored value is an array of these.
export const COLUMN_SCHEMAS = {
  'jobs.phases': jobPhase,
  'jobs.attempts': jobAttempt,
  'jobs.audit_events': jobAuditEvent,
  'repositories.service_map': serviceMapEntry,
  'recommendations.steps': recommendationStep,
  'recommendations.lifecycle_events': recommendationLifecycleEvent,
  'incidents.signals': incidentSignal,
  'incidents.timeline': incidentTimelineEntry,
  'incidents.hypotheses': incidentHypothesis,
  'incidents.correlated_changes': incidentCorrelatedChange,
  'ai_model_calls.tool_calls_redacted': toolCallRedacted,
} as const satisfies Record<string, z.ZodTypeAny>;

export type ColumnSchemaKey = keyof typeof COLUMN_SCHEMAS;

// Validate the jsonb array stored in `table.column`. Throws on the first invalid
// document; returns the typed array on success.
export function validateColumn<K extends ColumnSchemaKey>(
  column: K,
  value: unknown,
): z.infer<(typeof COLUMN_SCHEMAS)[K]>[] {
  return z.array(COLUMN_SCHEMAS[column]).parse(value) as z.infer<(typeof COLUMN_SCHEMAS)[K]>[];
}
