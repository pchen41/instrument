// Mutations that depend on the Task 5A action endpoints (start / retry an
// investigation, dismiss / restore a recommendation, generate a PR, apply a
// monitor change, mark a PR merged). Task 4 is read + polling + persisted UI
// state, so these actions are rendered (design-faithful) but their persistence
// is intentionally deferred: each goes through runDeferredAction, which returns
// a calm, honest result the UI surfaces instead of silently failing an
// RLS-blocked write. Task 5A replaces this with real endpoint calls.
//
// The one console mutation that is NOT deferred is the investigation-start
// setting — it persists today via updateInvestigationStartMode (Task 2 grants
// the column-scoped UPDATE), so it does not appear here.

export type DeferredAction =
  | 'start_investigation'
  | 'retry_investigation'
  | 'dismiss_recommendation'
  | 'restore_recommendation'
  | 'generate_recommendation_pr'
  | 'generate_monitor_change'
  | 'create_datadog_monitor'
  | 'mark_pr_merged'
  | 'complete_step';

const VERB: Record<DeferredAction, string> = {
  start_investigation: 'Starting an investigation',
  retry_investigation: 'Retrying the investigation',
  dismiss_recommendation: 'Dismissing a recommendation',
  restore_recommendation: 'Restoring a recommendation',
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
 * Resolve a deferred action. Today it only produces the notice the console
 * shows; in Task 5A the caller awaits a real endpoint instead. Kept as a single
 * choke point so every "wire me up in 5A" site is greppable.
 */
export function runDeferredAction(action: DeferredAction): DeferredResult {
  return {
    deferred: true,
    action,
    message: `${VERB[action]} will be enabled when the action endpoints ship (Task 5A).`,
  };
}
