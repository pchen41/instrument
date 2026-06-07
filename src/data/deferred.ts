// Mutations that depend on a provider's external-write flow (generate a PR, apply
// or publish a Datadog monitor change, mark a PR merged, complete a step). These
// are rendered design-faithfully but route through runDeferredAction — a calm,
// honest notice — because the real behaviour needs the approval + external-write
// executor and provider workflows that ship with the GitHub / Datadog integration
// tasks, not Task 5A.
//
// Task 5A wired the rest to real `console-actions` endpoints (src/data/actions.ts):
// start / retry an investigation, dismiss / restore a recommendation, and the
// investigation-start setting are live and no longer pass through here.

export type DeferredAction =
  | 'generate_recommendation_pr'
  | 'generate_monitor_change'
  | 'create_datadog_monitor'
  | 'mark_pr_merged'
  | 'complete_step';

const VERB: Record<DeferredAction, string> = {
  generate_recommendation_pr: 'Generating a pull request',
  generate_monitor_change: 'Applying a monitor change',
  create_datadog_monitor: 'Publishing a draft monitor',
  mark_pr_merged: 'Marking a pull request merged',
  complete_step: 'Completing this step',
};

export interface DeferredResult {
  deferred: true;
  action: DeferredAction;
  message: string;
}

/**
 * Resolve a deferred action into the notice the console shows. Kept as a single
 * choke point so every "wire me up with the provider integration" site is
 * greppable.
 */
export function runDeferredAction(action: DeferredAction): DeferredResult {
  return {
    deferred: true,
    action,
    message: `${VERB[action]} runs through Instrument's approval and external-write flow, which ships with the provider integration.`,
  };
}
