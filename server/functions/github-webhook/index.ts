// GitHub webhook ingestion endpoint (Task 6). Public URL configured as the repo's
// `pull_request` (and later `push`) webhook. Strict order so an unverified or
// non-allowlisted delivery never creates downstream rows:
//
//   cap body  →  HMAC X-Hub-Signature-256 over the RAW bytes
//   →  invalid: record a minimal rejected row (default workspace, header-only) + 401
//   →  valid: parse  →  resolve allowlisted repo  →  record delivery
//   →  upsert repositories + github_pull_requests
//   →  enqueue github_pr_review_analysis idempotently per PR revision
//
// The analysis itself runs in the durable worker (server/lib/agent-pr.ts), not
// here — the handler returns a fast 2xx to GitHub. Built to also carry merged/
// closed lifecycle updates (Task 8 extends the archival in the `closed` branch).
//
// Bundled to one file by scripts/build-functions.mjs; `npm:`/`node:` imports are
// resolved by Deno, the rest bundled from server/lib + _shared.
import { createAdminClient } from 'npm:@insforge/sdk';
import { json, preflight } from '../_shared/http.ts';
import { createPgDb } from '../_shared/pgdb.ts';
import { createGithubWebhookStore } from '../_shared/github-webhook-store.ts';
import { createConsoleSink, createInstrumentation } from '../../lib/instrumentation.ts';
import { createDatadogClient } from '../_shared/datadog-client.ts';
import { isoSeconds, LEASE_FREE, systemClock } from '../../lib/time.ts';
import {
  boundedHeaderValue,
  boundedPullRequestPayload,
  boundedPushPayload,
  decideScan,
  isAnalysisAction,
  isLifecycleAction,
  isPrimaryBranchPush,
  parsePullRequestEvent,
  parsePushEvent,
  prCorrelationKey,
  prLifecycleReason,
  prReviewJobKey,
  redactedHeaders,
  scanJobKey,
  verifyGithubSignature,
} from '../../lib/github-webhook.ts';

// deno-lint-ignore no-explicit-any
declare const Deno: any;

// Cap the body before HMAC/parse — both run on unauthenticated input, so an
// unbounded body is a cheap CPU/memory DoS. GitHub caps deliveries at ~25 MB; we
// only ever need PR metadata, so 2 MB is generous.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const baseUrl = Deno.env.get('INSFORGE_BASE_URL');
  const apiKey = Deno.env.get('API_KEY');
  if (!baseUrl || !apiKey) return json({ error: 'server_misconfigured' }, 500);

  // Fail CLOSED: with no configured secret we cannot verify any signature, so
  // every delivery is rejected rather than trusted.
  const secret = Deno.env.get('GITHUB_WEBHOOK_SECRET');
  if (!secret) return json({ error: 'server_misconfigured' }, 500);

  const event = req.headers.get('x-github-event');
  const deliveryId = req.headers.get('x-github-delivery');
  if (!event || !deliveryId) return json({ error: 'missing_github_headers' }, 400);

  // Size cap (declared, then actual) before reading/hashing the body.
  const declaredLen = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
  const bodyBytes = new Uint8Array(await req.arrayBuffer());
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);

  // HMAC over the EXACT raw bytes GitHub signed (not a re-encoded string).
  const signatureValid = verifyGithubSignature(secret, bodyBytes, req.headers.get('x-hub-signature-256'));
  const headersRedacted = redactedHeaders((n) => req.headers.get(n));
  const safeEvent = boundedHeaderValue(event) ?? 'unknown';
  const safeDelivery = boundedHeaderValue(deliveryId) ?? deliveryId.slice(0, 200);

  const admin = createAdminClient({ baseUrl, apiKey });
  const store = createGithubWebhookStore(admin);
  const db = createPgDb(admin);
  const datadog = createDatadogClient();
  const instrument = createInstrumentation(
    { service: datadog.service, environment: datadog.environment, enabled: true },
    createConsoleSink(),
  ).child({ path: 'server', fn: 'github-webhook', event: safeEvent });
  const endSpan = instrument.span('server.github_webhook', { signatureValid });

  // Set once a delivery row exists + we begin downstream work, so the catch can
  // mark it `failed` → a GitHub redelivery re-processes instead of being dropped.
  let deliveryRowId: string | null = null;

  try {
    const now = isoSeconds(systemClock.now());

    // --- Invalid signature: minimal rejected record. No parse, no repo lookup,
    //     no attribution from the (forgeable) payload. -------------------------
    if (!signatureValid) {
      const workspaceId = await store.defaultWorkspaceId();
      if (workspaceId) {
        await store.recordDelivery({
          workspaceId,
          integrationId: null,
          eventType: safeEvent,
          eventAction: null,
          externalDeliveryId: safeDelivery,
          providerCorrelationKey: null,
          signatureValid: false,
          headersRedacted,
          payloadRedacted: { rejected: 'invalid_signature' },
          receivedAt: now,
          processingStatus: 'ignored',
        });
      }
      instrument.log('warn', 'github_webhook.rejected', { event: safeEvent, reason: 'invalid_signature' });
      endSpan({ ok: false, rejected: true });
      return json({ error: 'invalid_signature' }, 401);
    }

    // GitHub pings the endpoint when the hook is created — ack (no row).
    if (event === 'ping') {
      endSpan({ ok: true, pong: true });
      return json({ ok: true, pong: true });
    }

    // Parse the verified body. Handle GitHub's `application/x-www-form-urlencoded`
    // form too (`payload=<json>`); the HMAC above is over the raw body regardless.
    let jsonText = new TextDecoder().decode(bodyBytes);
    if ((req.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')) {
      const formPayload = new URLSearchParams(jsonText).get('payload');
      if (formPayload === null) return json({ error: 'bad_json' }, 400);
      jsonText = formPayload;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(jsonText);
    } catch {
      return json({ error: 'bad_json' }, 400);
    }

    // --- Push events (Task 7): primary-branch pushes trigger proactive scans. ---
    if (event === 'push') {
      const push = parsePushEvent(payload);
      const owner = push ? (payload as any)?.repository?.owner?.login ?? (payload as any)?.repository?.owner?.name : null;
      const pushRepo = owner && (payload as any)?.repository?.name ? await store.findRepo(owner, (payload as any).repository.name) : null;
      const pushWorkspace = pushRepo?.workspaceId ?? (await store.defaultWorkspaceId());
      if (!pushWorkspace) return json({ error: 'no_workspace' }, 500);
      // Record the delivery either way (ERD: record every push).
      const onPrimary = !!(push && pushRepo && isPrimaryBranchPush(push, pushRepo.defaultBranch));
      const pushDelivery = await store.recordDelivery({
        workspaceId: pushWorkspace,
        integrationId: pushRepo?.integrationId ?? null,
        eventType: safeEvent,
        eventAction: null,
        externalDeliveryId: safeDelivery,
        providerCorrelationKey: push ? `${(payload as any)?.repository?.full_name}@${push.branch}` : null,
        signatureValid: true,
        headersRedacted,
        payloadRedacted: push ? boundedPushPayload(payload) : { event: safeEvent },
        receivedAt: now,
        processingStatus: onPrimary ? 'received' : 'ignored',
      });
      if (pushDelivery.duplicate) {
        endSpan({ ok: true, deduped: true });
        return json({ ok: true, deduped: true, delivery_id: safeDelivery });
      }
      if (!onPrimary || !push || !pushRepo) {
        endSpan({ ok: true, ignored: true });
        return json({ ok: true, ignored: pushRepo ? 'not_primary_branch' : 'repo_not_allowlisted' });
      }
      deliveryRowId = pushDelivery.id;
      const decision = decideScan(push, await store.latestScan(pushRepo.id), pushRepo.scanCooldownSeconds, systemClock.now());
      let scanJobId: string | null = null;
      // coalesce → stamp pending on the in-flight scan; if it already finished
      // (markScanPending returns false), fall through to a fresh enqueue so the
      // push that raced the completion isn't lost.
      let enqueueSha: string | null = null;
      let enqueueRunAt = now;
      if (decision.action === 'coalesce') {
        const marked = await store.markScanPending(decision.ontoJobId, decision.sha, now);
        if (!marked) enqueueSha = decision.sha;
      } else if (decision.action === 'enqueue') {
        enqueueSha = decision.sha;
        enqueueRunAt = decision.runAt;
      }
      if (enqueueSha) {
        const key = scanJobKey(pushRepo.id, enqueueSha);
        const existing = await db.findJobByIdempotency(pushWorkspace, 'proactive_scan', key);
        if (existing) {
          scanJobId = existing.id;
        } else {
          const job = await db.insertJob({
            workspace_id: pushWorkspace,
            job_type: 'proactive_scan',
            state: 'queued',
            target_type: 'repository',
            target_id: pushRepo.id,
            idempotency_key: key,
            created_by: null,
            safe_to_retry: true,
            attempt_count: 0,
            max_attempts: 3,
            retry_policy: {},
            phases: [],
            attempts: [],
            audit_events: [{ at: now, kind: 'enqueued', summary: `Primary-branch push ${enqueueSha.slice(0, 7)}` }],
            trigger_summary: {
              source: 'github_push',
              webhook_event_id: pushDelivery.id,
              repo: { owner, name: (payload as any).repository.name, full_name: (payload as any)?.repository?.full_name },
              branch: push.branch,
              after_sha: enqueueSha,
              before_sha: push.before,
              head_commit_sha: push.headCommitSha,
              commit_count: push.commitCount,
              compare_url: push.compareUrl,
              pending_sha: null,
            },
            queued_at: now,
            next_run_at: enqueueRunAt,
            lease_expires_at: LEASE_FREE,
            locked_by: null,
            progress_version: 1,
          });
          scanJobId = job.id;
        }
      }
      await store.markDelivery(pushDelivery.id, { processingStatus: 'processed', processedAt: isoSeconds(systemClock.now()) });
      endSpan({ ok: true, scan: decision.action, scanJobId });
      return json({ ok: true, scan: decision.action, scan_job_id: scanJobId, reason: decision.action === 'skip' ? decision.reason : undefined });
    }

    const parsed = event === 'pull_request' ? parsePullRequestEvent(payload) : null;
    const action = typeof payload.action === 'string' ? payload.action : null;
    const repoCtx = parsed ? await store.findRepo(parsed.repo.owner, parsed.repo.name) : null;
    const workspaceId = repoCtx?.workspaceId ?? (await store.defaultWorkspaceId());
    if (!workspaceId) return json({ error: 'no_workspace' }, 500);
    const correlationKey = parsed ? prCorrelationKey(parsed.repo, parsed.pr.number) : null;

    // --- Verified but repo not allowlisted (or non-PR for this slice): ignore. ---
    if (!repoCtx || !parsed) {
      await store.recordDelivery({
        workspaceId,
        integrationId: repoCtx?.integrationId ?? null,
        eventType: safeEvent,
        eventAction: action,
        externalDeliveryId: safeDelivery,
        providerCorrelationKey: correlationKey,
        signatureValid: true,
        headersRedacted,
        payloadRedacted: event === 'pull_request' ? boundedPullRequestPayload(payload) : { event: safeEvent, action },
        receivedAt: now,
        processingStatus: 'ignored',
      });
      endSpan({ ok: true, ignored: true });
      return json({ ok: true, ignored: repoCtx ? 'unsupported_event' : 'repo_not_allowlisted' });
    }

    // --- Verified, allowlisted PR delivery. Record then process. ---------------
    const delivery = await store.recordDelivery({
      workspaceId,
      integrationId: repoCtx.integrationId,
      eventType: safeEvent,
      eventAction: action,
      externalDeliveryId: safeDelivery,
      providerCorrelationKey: correlationKey,
      signatureValid: true,
      headersRedacted,
      payloadRedacted: boundedPullRequestPayload(payload),
      receivedAt: now,
      processingStatus: 'received',
    });
    // A terminally-processed delivery replay → no second run. (A row left
    // mid-flight or previously rejected is re-processed by recordDelivery.)
    if (delivery.duplicate) {
      endSpan({ ok: true, deduped: true });
      return json({ ok: true, deduped: true, delivery_id: safeDelivery });
    }
    deliveryRowId = delivery.id;

    await store.refreshRepoMeta(repoCtx.id, parsed.repo, now);
    const pullRequestId = await store.upsertPullRequest(workspaceId, repoCtx.id, parsed.pr, now);

    let jobId: string | null = null;
    let deduped = false;
    // Scope gate: BOTH the workspace and the repo must have PR review enabled.
    const scopeEnabled = repoCtx.prReviewEnabled && repoCtx.workspacePrReviewEnabled;
    if (isAnalysisAction(action) && scopeEnabled) {
      const key = prReviewJobKey(pullRequestId, parsed.pr.headSha);
      const existing = await db.findJobByIdempotency(workspaceId, 'github_pr_review_analysis', key);
      if (existing) {
        jobId = existing.id;
        deduped = true;
      } else {
        const job = await db.insertJob({
          workspace_id: workspaceId,
          job_type: 'github_pr_review_analysis',
          state: 'queued',
          target_type: 'pull_request',
          target_id: pullRequestId,
          idempotency_key: key,
          created_by: null,
          safe_to_retry: true,
          attempt_count: 0,
          max_attempts: 3,
          retry_policy: {},
          phases: [],
          attempts: [],
          audit_events: [{ at: now, kind: 'enqueued', summary: `Enqueued from GitHub ${action} (${parsed.pr.headSha.slice(0, 7)}).` }],
          trigger_summary: {
            source: 'github_webhook',
            action,
            webhook_event_id: delivery.id,
            repo: { owner: parsed.repo.owner, name: parsed.repo.name, full_name: parsed.repo.fullName },
            pr_number: parsed.pr.number,
            pr_node_id: parsed.pr.nodeId,
            head_sha: parsed.pr.headSha,
            base_branch: parsed.pr.baseBranch,
            head_branch: parsed.pr.headBranch,
            html_url: parsed.pr.htmlUrl,
          },
          queued_at: now,
          next_run_at: now,
          lease_expires_at: LEASE_FREE,
          locked_by: null,
          progress_version: 1,
        });
        jobId = job.id;
      }
    }

    // Merged/closed lifecycle: PR state is updated by the upsert above; now
    // archive the PR's review recommendation (Task 8 will extend this branch to
    // sync GENERATED recommendation PRs — opened/merged/closed/stale).
    const isLifecycle = isLifecycleAction(action);
    if (isLifecycle) {
      await store.outdatePrReviewRecommendation(workspaceId, parsed.repo.fullName, parsed.pr.number, pullRequestId, prLifecycleReason(parsed.pr.merged), now);
      // Task 8: a merged GENERATED PR completes its recommendation step (scoped to
      // this repo — PR numbers are repo-local).
      if (parsed.pr.merged) {
        await store.markGeneratedPrMerged(workspaceId, repoCtx.id, parsed.pr.number, now);
      }
    } else if (action === 'reopened') {
      // Re-opening un-archives the recommendation (a re-analysis job is also enqueued above).
      await store.reactivatePrReviewRecommendation(workspaceId, parsed.repo.fullName, parsed.pr.number, now);
    }

    await store.markDelivery(delivery.id, { processingStatus: 'processed', processedAt: isoSeconds(systemClock.now()) });
    endSpan({ ok: true, enqueued: !!jobId && !deduped, deduped, lifecycle: isLifecycle });
    return json({ ok: true, pull_request_id: pullRequestId, job_id: jobId, deduped });
  } catch (err) {
    // Leave the delivery re-processable so a GitHub redelivery can finish the work.
    if (deliveryRowId) {
      try {
        await store.markDelivery(deliveryRowId, { processingStatus: 'failed', errorSummary: 'processing_error' });
      } catch {
        /* best-effort; the row stays 'received', which recordDelivery also re-processes */
      }
    }
    // Never echo a raw error (it can carry provider/internal detail).
    instrument.log('error', 'github_webhook.error', { error: err instanceof Error ? err.message : String(err) });
    endSpan({ ok: false });
    return json({ error: 'internal' }, 500);
  }
}
