// Time helpers shared by the engine + endpoints.

/**
 * ISO timestamp with the milliseconds stripped. PostgREST `.or(...)` filter
 * strings are parsed on `.`, so a millisecond fraction (`...:00.123Z`) would
 * corrupt a timestamp embedded in a filter. We never embed timestamps in `.or()`
 * here, but normalising everything the engine writes/compares to second
 * precision keeps lease/next_run_at math unambiguous and filter-safe.
 */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// A timestamp far in the past: a job carrying this as its lease is "free" to
// claim. Using a sentinel instead of NULL means "claimable" is a single uniform
// predicate (`lease_expires_at < now`) for every state, and the seeded demo jobs
// (which carry NULL leases + NULL next_run_at) are never accidentally claimed.
export const LEASE_FREE = '1970-01-01T00:00:00Z';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function addSeconds(d: Date, seconds: number): Date {
  return new Date(d.getTime() + seconds * 1000);
}

/** Bounded, runtime-agnostic sleep (no-op when ms <= 0). */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
