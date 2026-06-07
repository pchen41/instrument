// Stable idempotency keys. The jobs table is unique on
// (workspace_id, job_type, idempotency_key), so a deterministic key makes
// duplicate enqueue attempts (double-click, webhook replay) collapse onto the
// same durable job instead of spawning a second one.

/** A console-started investigation: one job per incident. */
export function investigationKey(incidentId: string): string {
  return `incident:${incidentId}`;
}

/** An approved generation job: keyed to the approval so a re-enqueue is a no-op. */
export function generationKey(approvalId: string): string {
  return `approval:${approvalId}`;
}

/** A proactive scan keyed to the repository + commit it was triggered for. */
export function scanKey(repositoryId: string, sha: string): string {
  return `scan:${repositoryId}:${sha}`;
}
