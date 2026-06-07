import { createHash, createHmac } from 'node:crypto';

// `node:crypto` is available in both Node (Vitest) and Deno (function runtime via
// node-compat), so the same canonicalisation + digest runs in tests and in prod.

/**
 * Deterministic JSON: object keys sorted recursively so the same logical payload
 * always serialises identically. This is what the approved-payload hash is taken
 * over, so a re-ordered-but-equal payload still matches and a changed payload
 * does not (stale-approval rejection in the action layer).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortDeep(obj[key]);
    return out;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * HMAC-SHA256 hex of `input` keyed by `secret` — GitHub's X-Hub-Signature-256
 * body. Accepts the raw request bytes (Uint8Array) so the digest is taken over
 * exactly what GitHub signed, not a re-encoded string.
 */
export function hmacSha256Hex(secret: string, input: string | Uint8Array): string {
  return createHmac('sha256', secret).update(input).digest('hex');
}

/** SHA-256 of the canonical form of a payload — the approval payload hash. */
export function hashPayload(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}
