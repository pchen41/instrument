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

/** One observability finding the model proposes, tied to a changed file + line. */
export const prFindingSchema = z.object({
  issue_type: z.string().trim().min(1).max(80), // e.g. 'missing_latency_metric'
  file_path: z.string().trim().min(1).max(400),
  line_number: z.number().int().positive(),
  side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
  code_anchor: z.string().trim().max(200).nullish(), // function / route / queue / normalized context
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  body: z.string().trim().min(1).max(1500), // the review comment text
  suggested_code: z.string().max(1500).nullish(),
  fix_summary: z.string().trim().min(1).max(300), // normalized into the semantic fingerprint
});
export type PrFinding = z.infer<typeof prFindingSchema>;

/** The model's structured output: a bounded list of findings (empty = no gap). */
export const prFindingsSchema = z.object({
  findings: z.array(prFindingSchema).max(20).default([]),
});
export type PrFindings = z.infer<typeof prFindingsSchema>;

// Register on the shared registry so runModelCall's gate validates it, and the
// external-post gate (assertValidForExternalPosting) requires status 'valid'.
schemaRegistry.register(PR_FINDINGS_SCHEMA_VERSION, prFindingsSchema);

/** Extract the `{ findings: [...] }` object from a model completion (balanced JSON). */
export function parseFindings(text: string): unknown {
  const obj = extractJsonObject(text);
  return obj ?? { findings: [] };
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
  '`body` is the review comment (1-3 sentences, concrete). `fix_summary` is a short normalized description of the fix (e.g. "add p95 latency histogram around checkout handler"). Keep findings few and high-confidence.';

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

/** Normalize a fix summary so cosmetically-different phrasings of one gap collapse. */
export function normalizeFixSummary(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ') // drop inline code
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize a code anchor (function/route) for stable identity across revisions. */
export function normalizeAnchor(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Stable cross-revision identity of a gap: issue type + file + code anchor +
 * normalized fix. Excludes the raw line and head SHA (ERD), so the same gap that
 * shifts lines on a later push keeps the same semantic fingerprint.
 */
export function semanticFingerprint(repoFullName: string, finding: Pick<PrFinding, 'issue_type' | 'file_path' | 'code_anchor' | 'fix_summary'>): string {
  return sha256Hex(
    JSON.stringify([
      'pr_review',
      repoFullName.toLowerCase(),
      finding.issue_type.toLowerCase().trim(),
      finding.file_path,
      normalizeAnchor(finding.code_anchor),
      normalizeFixSummary(finding.fix_summary),
    ]),
  );
}

/** Per-revision placement identity: semantic + head SHA + file + line + side. */
export function revisionFingerprint(semantic: string, headSha: string, finding: Pick<PrFinding, 'file_path' | 'line_number' | 'side'>): string {
  return sha256Hex(JSON.stringify([semantic, headSha, finding.file_path, finding.line_number, finding.side ?? 'RIGHT']));
}

// ---- Dedupe helpers ----------------------------------------------------------
//
// The authoritative dedupe/serialization happens in the store via the
// pr_review_comments partial-unique (pull_request_id, semantic_fingerprint) WHERE
// status='posted': the worker CLAIMS the posted row by semantic before the GitHub
// write, so a fresh insert means "we own this gap" and a conflict means "already
// posted" (by an earlier revision or a concurrent job). These pure helpers decide,
// on a conflict, whether the already-posted comment should be reposted.

/** The single fact that can differ within one semantic identity: the concrete fix. */
export interface PostedCommentRef {
  suggested_code: string | null;
}

/**
 * Within a single semantic identity (file/anchor/issue/fix are all in the semantic
 * fingerprint, so they're equal on a conflict), the only field that can differ is
 * the concrete suggested fix. A bare line shift is NOT material (PR-6 acceptance),
 * so it folds to `skip_duplicate` (refresh placement, no repost).
 */
export function materiallyChanged(existing: PostedCommentRef, finding: PrFinding): boolean {
  return (existing.suggested_code ?? '').trim() !== (finding.suggested_code ?? '').trim();
}

// ---- Keys + formatting -------------------------------------------------------

/** Idempotency key for the external_write_actions row of a posted comment. */
export function reviewCommentWriteKey(pullRequestId: string, revisionFp: string): string {
  return `github_review_comment:${pullRequestId}:${revisionFp.slice(0, 32)}`;
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
