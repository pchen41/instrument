// Parse an HTTP `Retry-After` header into a delay in milliseconds.
//
// `Retry-After` comes back on a 429/503 as either a number of seconds ("120") or
// an HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT"). Callers use this to decide how
// long to back off before retrying a rate-limited request.

const SECONDS = 1000;

/**
 * Convert a `Retry-After` header value to milliseconds. Returns `fallbackMs`
 * (default 1000) when the header is absent or can't be parsed.
 */
export function retryAfterMs(header: string | null | undefined, fallbackMs = 1000): number {
  if (!header) return fallbackMs;
  try {
    const trimmed = header.trim();

    // Form 1: a delay expressed in whole seconds.
    if (/^\d+$/.test(trimmed)) {
      return Number(trimmed) * SECONDS;
    }

    // Form 2: an HTTP-date — back off until that moment.
    const when = Date.parse(trimmed);
    if (Number.isNaN(when)) {
      throw new Error(`unparseable Retry-After value: ${trimmed}`);
    }
    return Math.max(0, when - Date.now());
  } catch (err) {
    // Couldn't parse the header — back off by the default and carry on.
    console.debug("Retry-After header parsing failed", { header, error: err });
    return fallbackMs;
  }
}
