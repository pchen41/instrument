// Runtime-agnostic PR-review analysis core (Task 6, slice 2). Pure TS: the
// findings schema, the analysis prompt, fingerprint computation, and the
// fold/dedupe decision that turns model findings into post / skip / update
// actions against the existing pr_review_comments. No Deno, no network — the IO
// edge (agent-pr.ts orchestration + _shared/mcp-client + _shared/pr-review-store)
// drives these and persists results, so every decision here is unit-tested.
//
// The model is a PURE analyzer here (a plain gateway completion over the diff, no
// autonomous tool loop): MCP is used only for the deterministic read (the diff)
// and the single governed write (the comment). That is what makes "exactly one
// scoped comment per gap" + deterministic cross-revision dedupe achievable.
import { sha256Hex } from './hash';
import { scrubSecrets } from './redaction';
import { schemaRegistry, z } from './schema-validation';

export const PR_FINDINGS_SCHEMA_VERSION = 'pr_review_findings.v1';

/**
 * One observability finding the model proposes, tied to a changed file + line.
 * Tolerant of model-output variation: line_number is coerced from a string, and
 * side/severity fall back via `.catch` so an out-of-enum value (e.g. severity
 * "major") normalizes instead of discarding the finding. issue_type/file_path/
 * line_number/body/fix_summary remain required for a usable, anchorable comment.
 */
export const prFindingSchema = z.object({
  issue_type: z.string().trim().min(1).max(80), // bucketed into a canonical kind for the fingerprint
  file_path: z.string().trim().min(1).max(400),
  // Accept a number or a digit string only (NOT booleans), and bound to int4 so an
  // oversized value is DROPPED here, not raised as a Postgres 22003 on insert.
  line_number: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().positive().max(2_000_000_000)),
  side: z.enum(['LEFT', 'RIGHT']).catch('RIGHT'),
  code_anchor: z.string().trim().max(200).nullish(), // function / route / queue / normalized context
  severity: z.enum(['low', 'medium', 'high']).catch('medium'),
  body: z.string().trim().min(1).max(1500), // the review comment text
  suggested_code: z.string().max(1500).nullish(),
  fix_summary: z.string().trim().min(1).max(300), // normalized into the semantic fingerprint
});
export type PrFinding = z.infer<typeof prFindingSchema>;

/**
 * The model's structured output: a bounded list of findings (empty = no gap).
 * Lenient at the array level — each finding is parsed independently and only the
 * valid ones are kept (a single malformed finding must not discard the whole
 * batch), capped at 20. The object therefore always parses; the per-finding
 * `required` fields are still what gate a comment from being posted.
 */
export const prFindingsSchema = z.object({
  // `findings` is a REQUIRED array (a non-array root → validation 'invalid', so a
  // truncated/garbage completion stays visible instead of masquerading as a clean
  // zero-gap run). Leniency is per-ITEM: each finding is parsed independently and
  // only valid ones are kept (one malformed finding must not discard the batch).
  findings: z
    .array(z.unknown())
    .transform((arr) =>
      arr
        .slice(0, 50)
        .map((x) => prFindingSchema.safeParse(x))
        .flatMap((r) => (r.success ? [r.data] : []))
        .slice(0, 20),
    ),
});
export type PrFindings = z.infer<typeof prFindingsSchema>;

// Register on the shared registry so runModelCall's gate validates it, and the
// external-post gate (assertValidForExternalPosting) requires status 'valid'.
schemaRegistry.register(PR_FINDINGS_SCHEMA_VERSION, prFindingsSchema);

/**
 * Extract the `{ findings: [...] }` object from a model completion (balanced JSON).
 * Returns `null` when no JSON object can be parsed — the schema then validates that
 * as `invalid` (a truncated/garbage completion), distinct from a real `{findings:[]}`.
 */
export function parseFindings(text: string): unknown {
  return extractJsonObject(text);
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---- Prompt ------------------------------------------------------------------

export interface PrAnalysisContext {
  repoFullName: string;
  prNumber: number;
  title: string;
  baseBranch: string;
  headBranch: string;
  /** Bounded unified diff or changed-file summary read from the github MCP. */
  diffText: string;
}

const SYSTEM_PROMPT =
  'You are Instrument, an observability-focused code reviewer. You review a pull request diff and report ONLY specific, actionable OBSERVABILITY gaps that are introduced or worsened by the changed lines: missing metrics/timers on new endpoints or jobs, unlogged error branches, missing trace spans/attributes around new I/O, swallowed exceptions, or new external calls with no latency/error instrumentation. ' +
  'Each finding MUST tie to a changed file and a specific line in that file. Do NOT report style, naming, security, or general bugs. If the diff introduces no meaningful observability gap, return an empty findings array. ' +
  'Respond with ONLY a JSON object: {"findings":[{"issue_type","file_path","line_number","side","code_anchor","severity","body","suggested_code","fix_summary"}]}. ' +
  '`issue_type` MUST be one of: "missing_metric" (no latency/throughput/error-rate metric), "missing_log" (an error branch or important event is not logged), "missing_trace_span" (no span/trace attributes around new I/O), "missing_error_handling" (a swallowed or unhandled error). ' +
  '`code_anchor` MUST be the exact changed code symbol or line the finding is about (e.g. the function name or the specific statement) — ALWAYS provide it, it is the stable identity of the gap across revisions. ' +
  '`body` is the review comment (1-3 sentences, concrete). `fix_summary` is a short description of the fix (e.g. "add p95 latency histogram around checkout handler"). Keep findings few and high-confidence.';

/** Build the gateway request messages for the analyze phase (a pure chat completion, no tools). */
export function buildFindingsMessages(ctx: PrAnalysisContext): { role: 'system' | 'user'; content: string }[] {
  const user =
    `Repository: ${ctx.repoFullName}\nPR #${ctx.prNumber}: ${ctx.title}\nBase: ${ctx.baseBranch} ← Head: ${ctx.headBranch}\n\n` +
    `Changed code (unified diff / file excerpts):\n\n${ctx.diffText}\n\n` +
    'Report observability gaps in the changed lines as the specified JSON. Empty findings if none.';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

// ---- Fingerprints ------------------------------------------------------------

/**
 * Normalize a code anchor (function/route/statement) for a stable identity across
 * revisions. Aggressive: lowercase + collapse every non-alphanumeric run to a
 * single space, so `processOrder()`, `processOrder` and `the processOrder call`
 * fold together rather than hashing differently.
 */
export function normalizeAnchor(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Bucket the model's free-text issue_type into a small CANONICAL kind. This is the
 * key to robust dedupe: the model rewords the same gap between runs
 * ("missing_telemetry" vs "uninstrumented_external_call"), but both bucket to
 * `metric`, so the fingerprint stays stable across revisions — while a genuinely
 * different kind (a missing LOG vs a missing METRIC on the same anchor) stays
 * distinct, so two real gaps on one symbol don't collapse.
 */
export function issueKind(issueType: string | null | undefined): string {
  const t = (issueType ?? '').toLowerCase();
  if (/span|trace|tracing|telemetr|instrument/.test(t)) return 'trace';
  if (/metric|latency|timing|duration|throughput|histogram|counter/.test(t)) return 'metric';
  if (/error|exception|catch|swallow|fail|reject|retry/.test(t)) return 'error_handling';
  if (/log|logging|audit/.test(t)) return 'log';
  return 'other';
}

/**
 * Stable cross-revision identity of a gap: file + canonical issue kind + code
 * anchor. Excludes the raw line, head SHA, and the model's free-text fix wording
 * (ERD intent: stable across line shifts + rewordings). The code anchor is the
 * literal changed symbol (stable); the issue kind both distinguishes two different
 * gaps on the same anchor AND is reword-invariant via `issueKind` bucketing.
 */
export function semanticFingerprint(repoFullName: string, finding: Pick<PrFinding, 'issue_type' | 'file_path' | 'code_anchor'>): string {
  const anchor = normalizeAnchor(finding.code_anchor);
  const identity = `${issueKind(finding.issue_type)}:${anchor || 'noanchor'}`;
  return sha256Hex(JSON.stringify(['pr_review', repoFullName.toLowerCase(), finding.file_path, identity]));
}

/** Per-revision placement identity: semantic + head SHA + file + line + side. */
export function revisionFingerprint(semantic: string, headSha: string, finding: Pick<PrFinding, 'file_path' | 'line_number' | 'side'>): string {
  return sha256Hex(JSON.stringify([semantic, headSha, finding.file_path, finding.line_number, finding.side ?? 'RIGHT']));
}

// ---- Dedupe model ------------------------------------------------------------
//
// Dedupe/serialization happens in the store via the pr_review_comments
// partial-unique (pull_request_id, semantic_fingerprint) WHERE status='posted':
// the worker CLAIMS the posted row by semantic before the GitHub write, so a fresh
// insert means "we own this gap" and a conflict means "already posted" (by an
// earlier revision or a concurrent job). On a conflict the worker NEVER reposts —
// it refreshes the row's placement and audits a skipped write — because the only
// fields that vary within one semantic identity (the model's suggested-fix /
// issue_type wording) are not a real material change, so a repost would just
// duplicate the comment for the same gap.

// ---- Keys + formatting -------------------------------------------------------

/** Idempotency key for the external_write_actions row of a posted comment. */
export function reviewCommentWriteKey(pullRequestId: string, revisionFp: string): string {
  return `github_review_comment:${pullRequestId}:${revisionFp.slice(0, 32)}`;
}

/**
 * dedupe_fingerprint for the PR's category-`pr_review` recommendation — ONE per
 * PR. Shared by the analyzer (which writes/updates it) and the webhook merged/
 * closed handler (which outdates it), so the two can never drift.
 */
export function prReviewDedupeFingerprint(repoFullName: string, prNumber: number): string {
  return `pr_review:${repoFullName.toLowerCase()}#${prNumber}`;
}

/** Marker embedded in every posted comment so a crashed post can be reconciled by reading it back. */
export const COMMENT_MARKER = '<!-- instrument:pr-review -->';

/** The posted comment body — scrubbed, bounded, with a marker + optional suggestion block. */
export function formatCommentBody(finding: PrFinding): string {
  const lines = [`${COMMENT_MARKER}`, `**Observability:** ${scrubSecrets(finding.body).slice(0, 1400)}`];
  if (finding.suggested_code && finding.suggested_code.trim()) {
    lines.push('', '```suggestion', scrubSecrets(finding.suggested_code).slice(0, 1400), '```');
  }
  return lines.join('\n');
}
