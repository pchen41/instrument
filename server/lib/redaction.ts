// Centralized secret detection + scrubbing (Task 5C review hardening).
//
// One source of truth for "what a leaked secret looks like", used by:
//  - mcp-config.findSecretLikeValues (guard before writing integrations.config),
//  - model-call (scrub tool_calls_redacted + stored output of any token/PII),
//  - scripts/verify-mcp.mjs (mirrors these patterns, dependency-free).
//
// Value patterns are \b-anchored (NOT ^-anchored) so a secret embedded mid-string
// — e.g. inside a URL or an "Authorization: Bearer …" line — is still caught, and
// \b avoids false positives like "task-…" matching an sk- key. Unstructured keys
// with no recognizable shape (e.g. a bare 32-hex Datadog API key) are caught by
// the KEY-NAME guard instead; never store such a value under a non-secret field.
//
// Runtime-agnostic pure TS.

/** Field NAMES that must never hold a plaintext secret value. */
export const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|credential|api[_-]?key|access[_-]?key|private[_-]?key|(^|[_-])key$|authorization|bearer|(^|[_-])pat$)/i;

/** VALUE shapes of common provider secrets. */
export const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/i, // Authorization: Bearer <token>
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub ghp_/gho_/ghu_/ghs_/ghr_
  /\bgithub_pat_[A-Za-z0-9_]{20,}/, // GitHub fine-grained PAT
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/, // JWT (TrueFoundry PAT)
  /\bsk-[A-Za-z0-9-]{20,}/, // OpenAI incl. sk-proj-
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bglpat-[A-Za-z0-9_-]{20,}/, // GitLab PAT
];

/** True if the string contains a value shaped like a known provider secret. */
export function isSecretValue(s: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(s));
}

/** Mask secret-shaped substrings (for tool_calls_redacted / stored output). */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_VALUE_PATTERNS) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    out = out.replace(new RegExp(re.source, flags), '‹redacted›');
  }
  return out;
}

/**
 * Walk an object and return the key-paths whose VALUE looks like a secret, or
 * whose KEY name implies a secret holding a non-empty string. Empty = clean.
 * Used as a pre-write guard against secrets leaking into stored config.
 */
export function findSecretLikeValues(obj: unknown, path = ''): string[] {
  const hits: string[] = [];
  const walk = (node: unknown, p: string): void => {
    if (node == null) return;
    if (typeof node === 'string') {
      if (isSecretValue(node)) hits.push(p);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${p}[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const child = p ? `${p}.${k}` : k;
        if (SECRET_KEY_PATTERN.test(k) && typeof v === 'string' && v.length > 0) hits.push(child);
        else walk(v, child);
      }
    }
  };
  walk(obj, path);
  return hits;
}
