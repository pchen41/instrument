import { z } from 'zod';
import { isoTimestamp, uuid } from './common';
import { confidenceLevel, incidentRootCauseType } from './enums';

// incidents.signals[] — key signal objects with evidence IDs when available.
export const incidentSignal = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    value: z.string().min(1),
    evidence_id: uuid.nullish(),
  })
  .strict();
export type IncidentSignal = z.infer<typeof incidentSignal>;

// incidents.timeline[] — ordered UI timeline.
export const incidentTimelineEntry = z
  .object({
    at: isoTimestamp,
    kind: z.enum(['alert', 'action', 'finding', 'note']),
    title: z.string().min(1),
    detail: z.string().nullish(),
    evidence_id: uuid.nullish(),
  })
  .strict();
export type IncidentTimelineEntry = z.infer<typeof incidentTimelineEntry>;

// incidents.hypotheses[] — ranked, validated RCA output.
export const incidentHypothesis = z
  .object({
    rank: z.number().int().positive(),
    leading: z.boolean().default(false),
    summary: z.string().min(1),
    detail: z.string().min(1),
    root_cause_type: incidentRootCauseType.nullish(),
    confidence: confidenceLevel.nullish(),
    evidence_ids: z.array(uuid).nullish(),
  })
  .strict();
export type IncidentHypothesis = z.infer<typeof incidentHypothesis>;

// incidents.correlated_changes[] — commit/PR/change pointers.
export const incidentCorrelatedChange = z
  .object({
    kind: z.enum(['commit', 'pr', 'deploy', 'config']),
    ref: z.string().min(1),
    summary: z.string().min(1),
    url: z.string().url().nullish(),
    evidence_id: uuid.nullish(),
  })
  .strict();
export type IncidentCorrelatedChange = z.infer<typeof incidentCorrelatedChange>;
