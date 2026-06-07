// Runtime-agnostic primary-branch scan core (Task 7, slice B). Pure TS: the
// instrumentation-findings schema, the analysis prompt, and the stable
// dedupe_fingerprint that folds a recurring finding onto one recommendation
// across scans. Mirrors the PR-review core (server/lib/pr-review.ts) but the
// output is a `recommendations` row (category `instrumentation`), not a posted
// GitHub comment. Reuses issueKind/normalizeAnchor/parseFindings so the model's
// reworded free text doesn't defeat dedupe (the live lesson from Task 6).
import { sha256Hex } from './hash';
import { scrubSecrets } from './redaction';
import { issueKind, normalizeAnchor, parseFindings } from './pr-review';
import { schemaRegistry, z } from './schema-validation';

export const SCAN_FINDINGS_SCHEMA_VERSION = 'instrumentation_findings.v1';

/** One instrumentation gap the scan proposes, tied to a file + (optionally) a symbol. */
export const scanFindingSchema = z.object({
  issue_type: z.string().trim().min(1).max(80), // bucketed into a canonical kind for the fingerprint
  file_path: z.string().trim().min(1).max(400),
  code_anchor: z.string().trim().max(200).nullish(),
  title: z.string().trim().min(1).max(200),
  rationale: z.string().trim().min(1).max(1200),
  proposed_next_step: z.string().trim().min(1).max(600),
  severity: z.enum(['low', 'medium', 'high']).catch('medium'),
});
export type ScanFinding = z.infer<typeof scanFindingSchema>;

export const scanFindingsSchema = z.object({
  // Required root array (non-array → 'invalid'); leniency is per-item (drop only
  // the malformed finding, keep the batch).
  findings: z
    .array(z.unknown())
    .transform((arr) =>
      arr
        .slice(0, 50)
        .map((x) => scanFindingSchema.safeParse(x))
        .flatMap((r) => (r.success ? [r.data] : []))
        .slice(0, 20),
    ),
});
export type ScanFindings = z.infer<typeof scanFindingsSchema>;

schemaRegistry.register(SCAN_FINDINGS_SCHEMA_VERSION, scanFindingsSchema);

export { parseFindings as parseScanFindings };

/**
 * Stable recommendation dedupe_fingerprint for an instrumentation gap: file +
 * canonical issue kind + code anchor. Same robustness as the PR-review semantic
 * fingerprint — a recurring gap folds onto one recommendation across scans even
 * as the model rewords its title/issue_type.
 */
export function scanDedupeFingerprint(repoFullName: string, finding: Pick<ScanFinding, 'issue_type' | 'file_path' | 'code_anchor'>): string {
  const anchor = normalizeAnchor(finding.code_anchor);
  const identity = `${issueKind(finding.issue_type)}:${anchor || 'noanchor'}`;
  return `instr:${sha256Hex(JSON.stringify(['scan', repoFullName.toLowerCase(), finding.file_path, identity])).slice(0, 32)}`;
}

export interface ScanAnalysisContext {
  repoFullName: string;
  branch: string;
  headSha: string;
  /** Bounded changed-code text (the push's commit patches) read from the github MCP. */
  changedCode: string;
}

const SYSTEM_PROMPT =
  'You are Instrument, an observability-focused code reviewer scanning a push to a repository primary branch. From the CHANGED code, propose only specific, actionable OBSERVABILITY/instrumentation improvements: new endpoints/jobs/external-calls that lack metrics, timers, trace spans, or error logging. ' +
  'Each finding ties to a changed file and a code symbol. Do NOT propose style, security, or general refactors. If the change introduces no meaningful instrumentation gap, return an empty findings array. ' +
  'Respond with ONLY a JSON object: {"findings":[{"issue_type","file_path","code_anchor","title","rationale","proposed_next_step","severity"}]}. ' +
  '`issue_type` MUST be one of: "missing_metric", "missing_log", "missing_trace_span", "missing_error_handling". ' +
  '`code_anchor` MUST be the exact changed symbol/statement (ALWAYS provide it — it is the stable identity across scans). ' +
  '`title` is a short recommendation title; `rationale` 1-3 sentences; `proposed_next_step` the concrete instrumentation to add. Keep findings few and high-confidence.';

export function buildScanMessages(ctx: ScanAnalysisContext): { role: 'system' | 'user'; content: string }[] {
  const user =
    `Repository: ${ctx.repoFullName}\nPrimary branch: ${ctx.branch} @ ${ctx.headSha.slice(0, 7)}\n\n` +
    `Changed code (commit patches):\n\n${ctx.changedCode}\n\n` +
    'Report instrumentation gaps in the changed code as the specified JSON. Empty findings if none.';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Scrubbed, bounded recommendation fields derived from a finding. */
export function recommendationFields(finding: ScanFinding): { title: string; rationale: string; proposedNextStep: string; affectedCodePath: string } {
  return {
    title: scrubSecrets(finding.title).slice(0, 200),
    rationale: scrubSecrets(finding.rationale).slice(0, 1200),
    proposedNextStep: scrubSecrets(finding.proposed_next_step).slice(0, 600),
    affectedCodePath: finding.file_path + (finding.code_anchor ? `:${finding.code_anchor}`.slice(0, 80) : ''),
  };
}
