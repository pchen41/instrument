// Local end-to-end ingestion smoke (Task 6, slice 1) against the REAL dev DB.
// Drives the actual Deno store + idempotent enqueue (not fakes — fake stores hide
// schema bugs, the 5C/5D lesson): signed-fixture → inbound_webhooks + PR upsert +
// job enqueue, then prove delivery-replay + revision dedupe, then clean up.
// Run: node_modules/.bin/vite-node scripts/smoke-github-webhook.ts
import { readFileSync } from 'node:fs';
import { createAdminClient } from '@insforge/sdk';
import { createGithubWebhookStore } from '../server/functions/_shared/github-webhook-store.ts';
import { createPgDb } from '../server/functions/_shared/pgdb.ts';
import {
  boundedPullRequestPayload,
  parsePullRequestEvent,
  prCorrelationKey,
  prReviewJobKey,
} from '../server/lib/github-webhook.ts';

const cfg = JSON.parse(readFileSync('.insforge/project.json', 'utf8'));
const admin = createAdminClient({ baseUrl: cfg.oss_host, apiKey: cfg.api_key });
const store = createGithubWebhookStore(admin);
const db = createPgDb(admin);

const TEST_PR_NUMBER = 990001; // clearly-synthetic; deleted at the end
const headSha = `smoke${Date.now().toString(36)}`;
const deliveryId = `smoke-${crypto.randomUUID()}`;

function payload(action: string, sha: string) {
  return {
    action,
    number: TEST_PR_NUMBER,
    pull_request: {
      node_id: 'PR_smoke', number: TEST_PR_NUMBER, title: 'SMOKE add latency timing', state: 'open',
      draft: false, merged: false, user: { login: 'smoke-bot' },
      base: { ref: 'main', sha: 'base0' }, head: { ref: 'smoke/branch', sha },
      html_url: 'https://github.com/pchen41/instrument/pull/990001',
      created_at: '2026-06-06T10:00:00Z', updated_at: '2026-06-06T10:05:00Z', closed_at: null, merged_at: null,
    },
    repository: {
      id: 9090, name: 'instrument', full_name: 'pchen41/instrument', owner: { login: 'pchen41' },
      default_branch: 'main', html_url: 'https://github.com/pchen41/instrument', clone_url: 'https://github.com/pchen41/instrument.git', private: true,
    },
    sender: { login: 'smoke-bot' },
  };
}

let ok = true;
const check = (label: string, cond: boolean) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) ok = false; };

// Capture repo meta so refreshRepoMeta can be restored (don't pollute the allowlist row).
const repoCtx = await store.findRepo('pchen41', 'instrument');
if (!repoCtx) { console.error('repo not allowlisted — aborting'); process.exit(1); }
check('repo resolves with both pr_review flags', repoCtx.prReviewEnabled === true && repoCtx.workspacePrReviewEnabled === true);
const { data: repoBefore } = await admin.database.from('repositories').select('external_repo_id, default_branch, html_url, clone_url, last_synced_at, updated_at').eq('id', repoCtx.id).maybeSingle();

const now = new Date().toISOString();
const p = payload('opened', headSha);
const parsed = parsePullRequestEvent(p)!;

let createdPrId: string | null = null;
let createdJobId: string | null = null;
try {
  const deliveryRow = () => ({
    workspaceId: repoCtx.workspaceId, integrationId: repoCtx.integrationId,
    eventType: 'pull_request', eventAction: 'opened', externalDeliveryId: deliveryId,
    providerCorrelationKey: prCorrelationKey(parsed.repo, parsed.pr.number),
    signatureValid: true, headersRedacted: { event: 'pull_request', delivery: deliveryId, signature_present: true },
    payloadRedacted: boundedPullRequestPayload(p), receivedAt: now, processingStatus: 'received' as const,
  });

  // 1. record delivery
  const delivery = await store.recordDelivery(deliveryRow());
  check('delivery recorded (not duplicate)', !!delivery.id && !delivery.duplicate);

  // 2. replay BEFORE processed (mid-flight) → re-process, NOT a duplicate (review HIGH fix)
  const midReplay = await store.recordDelivery(deliveryRow());
  check('mid-flight replay re-processes (same row, not deduped)', !midReplay.duplicate && midReplay.id === delivery.id);

  // 3. mark processed, THEN replay → now a terminal duplicate (short-circuit)
  await store.markDelivery(delivery.id, { processingStatus: 'processed', processedAt: now });
  const doneReplay = await store.recordDelivery(deliveryRow());
  check('processed replay deduped to same row', doneReplay.duplicate && doneReplay.id === delivery.id);

  // 3. PR upsert
  await store.refreshRepoMeta(repoCtx.id, parsed.repo, now);
  createdPrId = await store.upsertPullRequest(repoCtx.workspaceId, repoCtx.id, parsed.pr, now);
  check('PR upserted', !!createdPrId);
  const reUpsert = await store.upsertPullRequest(repoCtx.workspaceId, repoCtx.id, parsed.pr, now);
  check('PR upsert is idempotent (same id)', reUpsert === createdPrId);

  // 4. enqueue analysis job idempotently
  const key = prReviewJobKey(createdPrId, headSha);
  const job = await db.insertJob({
    workspace_id: repoCtx.workspaceId, job_type: 'github_pr_review_analysis', state: 'queued',
    target_type: 'pull_request', target_id: createdPrId, idempotency_key: key, created_by: null,
    safe_to_retry: true, attempt_count: 0, max_attempts: 3, retry_policy: {}, phases: [], attempts: [],
    audit_events: [{ at: now, kind: 'enqueued', summary: 'smoke' }],
    trigger_summary: { source: 'github_webhook', action: 'opened', head_sha: headSha, pr_number: TEST_PR_NUMBER },
    queued_at: now, next_run_at: now, lease_expires_at: '1970-01-01T00:00:00.000Z', locked_by: null, progress_version: 1,
  });
  createdJobId = job.id;
  check('analysis job enqueued', !!job.id && job.job_type === 'github_pr_review_analysis' && job.target_id === createdPrId);

  // 5. same revision enqueue → dedup via idempotency
  const dup = await db.findJobByIdempotency(repoCtx.workspaceId, 'github_pr_review_analysis', key);
  check('same-revision job dedup hits the same job', dup?.id === job.id);
} finally {
  // ---- cleanup: delete created rows + restore repo meta ----
  if (createdJobId) await admin.database.from('jobs').delete().eq('id', createdJobId);
  if (createdPrId) await admin.database.from('github_pull_requests').delete().eq('id', createdPrId);
  await admin.database.from('inbound_webhooks').delete().eq('provider', 'github').eq('external_delivery_id', deliveryId);
  if (repoBefore) await admin.database.from('repositories').update(repoBefore).eq('id', repoCtx.id);
  // verify cleanup
  const { data: jLeft } = await admin.database.from('jobs').select('id').eq('id', createdJobId ?? '00000000-0000-0000-0000-000000000000').maybeSingle();
  const { data: wLeft } = await admin.database.from('inbound_webhooks').select('id').eq('external_delivery_id', deliveryId).maybeSingle();
  check('cleanup: job removed', !jLeft);
  check('cleanup: webhook row removed', !wLeft);
}

console.log(ok ? '\nALL GREEN' : '\nFAILURES PRESENT');
process.exit(ok ? 0 : 1);
