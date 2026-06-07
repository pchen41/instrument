// Runtime-agnostic GitHub webhook ingestion logic (Task 6). Pure TS: signature
// verification, payload normalization, bounded/redacted payload extraction, and
// the idempotency keys for delivery dedupe + per-revision job enqueue. No Deno,
// no network, no PostgREST — the IO edge (server/functions/github-webhook +
// _shared/github-webhook-store.ts) calls these and persists the result, so this
// file is fully unit-tested.
//
// Hard rule (PRD OBS-5 / ERD): never let a raw signature or token survive into a
// stored row. Signatures are dropped from headers_redacted; free-text payload
// fields are scrubbed; only a bounded set of structured fields is kept.
import { hmacSha256Hex } from './hash';
import { scrubSecrets } from './redaction';

// ---- Signature verification --------------------------------------------------

/**
 * Verify a GitHub `X-Hub-Signature-256` header (`sha256=<hexdigest>` of the raw
 * request body, HMAC-keyed by the configured webhook secret). Constant-time hex
 * compare; fails closed when the secret or header is missing. The caller MUST use
 * the exact raw body bytes — re-serialising the parsed JSON breaks the HMAC.
 */
export function verifyGithubSignature(secret: string, rawBody: string | Uint8Array, signatureHeader: string | null | undefined): boolean {
  if (!secret || !signatureHeader) return false;
  const expected = `sha256=${hmacSha256Hex(secret, rawBody)}`;
  return timingSafeEqual(expected, signatureHeader);
}

/** Constant-time string compare. Length is not secret, so a length mismatch short-circuits. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- Event classification ----------------------------------------------------

/** PR webhook actions that should enqueue a `github_pr_review_analysis` job. */
export const PR_ANALYSIS_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

/** PR webhook actions that update merged/closed lifecycle (Task 6 → 8). */
export const PR_LIFECYCLE_ACTIONS = new Set(['closed']);

export function isAnalysisAction(action: string | null | undefined): boolean {
  return !!action && PR_ANALYSIS_ACTIONS.has(action);
}
export function isLifecycleAction(action: string | null | undefined): boolean {
  return !!action && PR_LIFECYCLE_ACTIONS.has(action);
}

/** Reason a PR's review recommendation is outdated when the PR closes (merged vs closed). */
export function prLifecycleReason(merged: boolean): string {
  return merged ? 'pr_merged' : 'pr_closed';
}

// ---- Normalized payload shapes ----------------------------------------------

export interface NormalizedRepo {
  owner: string;
  name: string;
  fullName: string;
  externalRepoId: string | null;
  defaultBranch: string;
  htmlUrl: string | null;
  cloneUrl: string | null;
}

export interface NormalizedPr {
  number: number;
  nodeId: string | null;
  title: string;
  authorLogin: string | null;
  /** open | closed | merged (merged collapses closed+merged=true). */
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  merged: boolean;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  htmlUrl: string | null;
  openedAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
}

export interface ParsedPullRequestEvent {
  action: string;
  repo: NormalizedRepo;
  pr: NormalizedPr;
  senderLogin: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function scrubbed(v: unknown): string | null {
  const s = str(v);
  return s === null ? null : scrubSecrets(s);
}

/** Normalize a `pull_request` event payload, or null if it is not a usable PR event. */
export function parsePullRequestEvent(payload: Json): ParsedPullRequestEvent | null {
  const pr = payload?.pull_request;
  const repository = payload?.repository;
  const action = str(payload?.action);
  if (!pr || !repository || !action) return null;

  const owner = str(repository?.owner?.login);
  const name = str(repository?.name);
  const number = typeof payload?.number === 'number' ? payload.number : typeof pr?.number === 'number' ? pr.number : null;
  const headSha = str(pr?.head?.sha);
  const baseBranch = str(pr?.base?.ref);
  const headBranch = str(pr?.head?.ref);
  // These five are required to produce coherent downstream rows; bail otherwise.
  if (!owner || !name || number === null || !headSha || !baseBranch || !headBranch) return null;

  const merged = pr?.merged === true;
  const rawState = str(pr?.state) ?? 'open';
  const state: NormalizedPr['state'] = merged ? 'merged' : rawState === 'closed' ? 'closed' : 'open';

  return {
    action,
    repo: {
      owner,
      name,
      fullName: str(repository?.full_name) ?? `${owner}/${name}`,
      externalRepoId: repository?.id != null ? String(repository.id) : null,
      defaultBranch: str(repository?.default_branch) ?? 'main',
      htmlUrl: str(repository?.html_url),
      cloneUrl: str(repository?.clone_url),
    },
    pr: {
      number,
      nodeId: str(pr?.node_id),
      title: scrubbed(pr?.title) ?? `PR #${number}`,
      authorLogin: str(pr?.user?.login),
      state,
      draft: pr?.draft === true,
      merged,
      baseBranch,
      headBranch,
      headSha,
      htmlUrl: str(pr?.html_url),
      openedAt: str(pr?.created_at),
      updatedAt: str(pr?.updated_at),
      closedAt: str(pr?.closed_at),
      mergedAt: str(pr?.merged_at),
    },
    senderLogin: str(payload?.sender?.login),
  };
}

// ---- Bounded / redacted persistence shapes ----------------------------------

/**
 * The bounded, secret-free snapshot stored in `inbound_webhooks.payload_redacted`.
 * Picks exactly the fields the ERD lists for `pull_request` (number, PR
 * title/state/draft/base/head/URLs/timestamps, repo + sender metadata) — never the
 * diff, body, or review text. Free-text fields are scrubbed defensively.
 */
export function boundedPullRequestPayload(payload: Json): Record<string, unknown> {
  const pr = payload?.pull_request ?? {};
  const repo = payload?.repository ?? {};
  return {
    action: str(payload?.action),
    number: typeof payload?.number === 'number' ? payload.number : (typeof pr?.number === 'number' ? pr.number : null),
    pull_request: {
      node_id: str(pr?.node_id),
      title: scrubbed(pr?.title),
      state: str(pr?.state),
      draft: pr?.draft === true,
      merged: pr?.merged === true,
      base: { ref: scrubbed(pr?.base?.ref), sha: str(pr?.base?.sha) },
      head: { ref: scrubbed(pr?.head?.ref), sha: str(pr?.head?.sha) },
      user: { login: str(pr?.user?.login) },
      html_url: str(pr?.html_url),
      created_at: str(pr?.created_at),
      updated_at: str(pr?.updated_at),
      closed_at: str(pr?.closed_at),
      merged_at: str(pr?.merged_at),
    },
    repository: {
      id: repo?.id != null ? String(repo.id) : null,
      full_name: str(repo?.full_name),
      name: str(repo?.name),
      owner: { login: str(repo?.owner?.login) },
      default_branch: str(repo?.default_branch),
      html_url: str(repo?.html_url),
      private: repo?.private === true,
    },
    sender: { login: str(payload?.sender?.login) },
  };
}

const MAX_HEADER_LEN = 200;

/**
 * Bound + scrub a header value before it is persisted. Every header on a webhook
 * request is attacker-controllable on an unverified delivery, so cap the length
 * and run the secret scrubber so no token-shaped string lands in a stored row.
 */
export function boundedHeaderValue(v: string | null | undefined, max = MAX_HEADER_LEN): string | null {
  const s = str(v);
  return s === null ? null : scrubSecrets(s).slice(0, max);
}

/**
 * Redacted webhook headers for `inbound_webhooks.headers_redacted`. Keeps the
 * GitHub delivery/event/hook identifiers (bounded + scrubbed); the signature
 * value is NEVER stored (only a boolean that one was present). `get` is any
 * case-insensitive getter (a Headers object's lowercased keys, or a plain object).
 */
export function redactedHeaders(get: (name: string) => string | null | undefined): Record<string, unknown> {
  return {
    event: boundedHeaderValue(get('x-github-event')),
    delivery: boundedHeaderValue(get('x-github-delivery')),
    hook_id: boundedHeaderValue(get('x-github-hook-id')),
    hook_installation_target_id: boundedHeaderValue(get('x-github-hook-installation-target-id')),
    hook_installation_target_type: boundedHeaderValue(get('x-github-hook-installation-target-type')),
    content_type: boundedHeaderValue(get('content-type')),
    signature_present: !!get('x-hub-signature-256'),
  };
}

// ---- Idempotency keys --------------------------------------------------------

/**
 * Per-revision analysis job key. Collapses every delivery/action for the SAME PR
 * revision (head SHA) onto one durable job — so a replayed delivery or an
 * opened→ready_for_review pair on the same commit does not spawn a second run,
 * while a new push (new head SHA) does. (`pullRequestId` is our internal uuid,
 * known after the PR upsert; the unique jobs index does the atomic dedupe.)
 */
export function prReviewJobKey(pullRequestId: string, headSha: string): string {
  return `pr_review:${pullRequestId}:${headSha}`;
}

/** Stable subject key for a PR delivery — repo full name + number (debug/replay). */
export function prCorrelationKey(repo: NormalizedRepo, number: number): string {
  return `${repo.fullName}#${number}`;
}
