import { z } from 'zod';

// Shared primitives for the jsonb shapes. Timestamps are stored as ISO strings
// inside jsonb (the typed timestamptz columns are separate).
export const isoTimestamp = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime());

export const uuid = z.string().uuid();

// Validate an array of jsonb documents against a schema, returning typed data or
// throwing a readable error. Used by seed/verification and later edge functions.
export function validateArray<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T>[] {
  return z.array(schema).parse(value);
}
