// Runtime-agnostic recommendation-PR-generation core (Task 8). Pure TS: the
// generated-patch schema + prompt, deterministic branch naming, the PR body, and
// the external_write_actions idempotency keys for the branch/file/PR provider
// writes. Generation is approval-gated: every write carries the approval's
// approved_payload_hash as its request_hash, and the executor verifies the
// approval is approved + unrevoked before each write (ERD external-write governance).
import { sha256Hex } from './hash';
import { scrubSecrets } from './redaction';
import { schemaRegistry, z } from './schema-validation';

export const PR_GEN_SCHEMA_VERSION = 'pr_gen_patch.v1';

/** The model's generated change: full modified content for each touched file + PR copy. */
export const prGenPatchSchema = z.object({
  files: z
    .array(z.object({ path: z.string().trim().min(1).max(400), content: z.string().min(1).max(40_000) }))
    .min(1)
    .max(5),
  pr_title: z.string().trim().min(1).max(160),
  pr_summary: z.string().trim().min(1).max(2000),
});
export type PrGenPatch = z.infer<typeof prGenPatchSchema>;

schemaRegistry.register(PR_GEN_SCHEMA_VERSION, prGenPatchSchema);

/** Extract the `{ files, pr_title, pr_summary }` object from a model completion. */
export function parsePatch(text: string): unknown {
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
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export interface PrGenContext {
  repoFullName: string;
  recommendationTitle: string;
  recommendationRationale: string;
  proposedNextStep: string;
  /** The target file path + its current content, read from the github MCP. */
  filePath: string;
  currentContent: string;
}

const SYSTEM_PROMPT =
  'You are Instrument, generating a SMALL, focused pull request that adds the observability instrumentation described by a recommendation. You are given the current content of ONE file and must return its FULL modified content with the instrumentation added (a metric/timer, a log on the error branch, or a trace span — exactly what the recommendation asks). ' +
  'Make the minimal change that satisfies the recommendation; preserve all existing behavior and formatting; do NOT refactor unrelated code. ' +
  'Respond with ONLY a JSON object: {"files":[{"path","content"}],"pr_title","pr_summary"}. `content` is the COMPLETE new file content. `pr_title` is concise; `pr_summary` is 1-3 sentences describing the instrumentation added.';

export function buildPatchMessages(ctx: PrGenContext): { role: 'system' | 'user'; content: string }[] {
  const user =
    `Repository: ${ctx.repoFullName}\nRecommendation: ${ctx.recommendationTitle}\nRationale: ${ctx.recommendationRationale}\nProposed next step: ${ctx.proposedNextStep}\n\n` +
    `File to modify: ${ctx.filePath}\n--- current content ---\n${ctx.currentContent}\n--- end ---\n\n` +
    'Return the full modified file content plus the PR title/summary as the specified JSON.';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Deterministic branch name for a recommendation step — stable so a retry reuses it. */
export function prGenBranchName(recommendationId: string, stepKey: string | null): string {
  const slug = sha256Hex(`${recommendationId}:${stepKey ?? ''}`).slice(0, 10);
  return `instrument/instr-${slug}`;
}

const PR_MARKER = '<!-- instrument:generated-pr -->';

/** The generated PR body — scrubbed, with the recommendation rationale + a marker. */
export function buildPrBody(ctx: { summary: string; recommendationTitle: string; rationale: string }): string {
  return [
    PR_MARKER,
    `**Instrument generated this PR** for the recommendation: _${scrubSecrets(ctx.recommendationTitle).slice(0, 200)}_`,
    '',
    scrubSecrets(ctx.summary).slice(0, 1800),
    '',
    `> ${scrubSecrets(ctx.rationale).slice(0, 600)}`,
  ].join('\n');
}

// ---- external_write_actions idempotency keys (one operation, several writes) ----

export function branchWriteKey(recommendationId: string, stepKey: string | null): string {
  return `github_create_branch:${recommendationId}:${stepKey ?? ''}`;
}
export function fileWriteKey(recommendationId: string, stepKey: string | null, path: string): string {
  return `github_update_file:${recommendationId}:${stepKey ?? ''}:${sha256Hex(path).slice(0, 12)}`;
}
export function prWriteKey(recommendationId: string, stepKey: string | null): string {
  return `github_create_pr:${recommendationId}:${stepKey ?? ''}`;
}
