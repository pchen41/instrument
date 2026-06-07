import type { JobPhase, JobType } from './types';

// Named phase plans per job type. These are the engine's UI-ready progress
// objects (jobs.phases) — the same shape the console's GenProgress already
// renders. Task 5A ships the durable progression through these phases; the real
// provider work that *happens* inside each phase lands in Tasks 5C/6/7/8/9/12.

interface PhaseDef {
  key: string;
  label: string;
}

export const PHASE_PLANS: Record<JobType, PhaseDef[]> = {
  incident_investigation: [
    { key: 'triage', label: 'Reading the alert' },
    { key: 'gather_signals', label: 'Pulling traces, logs, and deploys' },
    { key: 'correlate', label: 'Correlating recent changes' },
    { key: 'hypotheses', label: 'Forming hypotheses' },
    { key: 'summarize', label: 'Summarizing the leading cause' },
  ],
  proactive_scan: [
    { key: 'enumerate', label: 'Scanning the codebase' },
    { key: 'analyze', label: 'Analyzing instrumentation gaps' },
    { key: 'rank', label: 'Ranking findings' },
  ],
  recommendation_generation: [
    { key: 'gather', label: 'Gathering context' },
    { key: 'draft', label: 'Drafting recommendation' },
    { key: 'validate', label: 'Validating against schema' },
  ],
  datadog_alert_generation: [
    { key: 'inspect', label: 'Inspecting the alert' },
    { key: 'draft_monitor', label: 'Drafting a monitor' },
    { key: 'validate', label: 'Validating the draft' },
  ],
  github_pr_review_analysis: [
    { key: 'fetch_diff', label: 'Reading the diff' },
    { key: 'analyze', label: 'Analyzing for issues' },
    { key: 'compose', label: 'Composing review comments' },
  ],
  recommendation_pr_generation: [
    { key: 'plan', label: 'Planning the change' },
    { key: 'compose_patch', label: 'Composing the patch' },
    { key: 'handoff', label: 'Preparing the external write' },
  ],
};

export function planFor(jobType: JobType): PhaseDef[] {
  return PHASE_PLANS[jobType] ?? PHASE_PLANS.incident_investigation;
}

/**
 * Merge the plan with any phases already persisted (so a resumed job keeps its
 * completed phases and only the not-yet-succeeded ones run again). Returns the
 * full ordered phase list seeded to `pending` where no prior state exists.
 */
export function mergePhases(jobType: JobType, existing: JobPhase[] | undefined): JobPhase[] {
  const byKey = new Map((existing ?? []).map((p) => [p.key, p]));
  return planFor(jobType).map(
    (def): JobPhase => byKey.get(def.key) ?? { key: def.key, label: def.label, state: 'pending' },
  );
}
