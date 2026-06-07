// Structured-output schema validation (Task 5C foundation).
//
// Every task-specific model output that gets *displayed* or *posted to a
// provider* (an incident summary, a ranked-hypotheses block, a PR body, a draft
// monitor definition) must be validated against a named, versioned schema first.
// This module ships the mechanism — a registry of versioned zod schemas plus the
// gate helpers — while the concrete schemas are registered by the workflow tasks
// that own them (Tasks 6, 7, 9, 11, 12).
//
// Runtime-agnostic: pure TS + zod, no Deno/SDK/network, so it runs identically
// under Vitest and bundled into an Edge Function.
import { z, type ZodType } from 'zod';

/** Mirrors ai_model_calls.validation_status (docs/ERD.md). */
export type ValidationStatus = 'valid' | 'invalid' | 'not_applicable';

export interface ValidationResult<T = unknown> {
  status: ValidationStatus;
  /** Parsed/coerced value when status === 'valid'. */
  value?: T;
  /** Human-readable reasons; populated for 'invalid' and for an unregistered version. */
  errors: string[];
}

/** Thrown by the display/post gates when output is not safe to release. */
export class SchemaValidationError extends Error {
  readonly status: ValidationStatus;
  readonly errors: string[];
  constructor(message: string, status: ValidationStatus, errors: string[]) {
    super(message);
    this.name = 'SchemaValidationError';
    this.status = status;
    this.errors = errors;
  }
}

/** Flatten a ZodError into short, log-safe messages (`path: message`). */
function zodErrors(err: z.ZodError): string[] {
  return err.issues.map((i) => {
    const path = i.path.length ? i.path.join('.') : '(root)';
    return `${path}: ${i.message}`;
  });
}

/**
 * A registry of named, versioned structured-output schemas. Use the shared
 * `schemaRegistry` for production registration; construct a fresh instance in
 * tests to avoid cross-test global state.
 */
export class SchemaRegistry {
  private schemas = new Map<string, ZodType>();

  /** Register (or replace) the schema for an `output_schema_version` value. */
  register(version: string, schema: ZodType): this {
    if (!version) throw new Error('schema version must be a non-empty string');
    this.schemas.set(version, schema);
    return this;
  }

  has(version: string): boolean {
    return this.schemas.has(version);
  }

  get(version: string): ZodType | undefined {
    return this.schemas.get(version);
  }

  list(): string[] {
    return [...this.schemas.keys()].sort();
  }

  /** Throw if a version that a caller expects to validate is not registered. */
  assertRegistered(version: string): void {
    if (!this.schemas.has(version)) {
      throw new Error(`no structured-output schema registered for version "${version}"`);
    }
  }

  /**
   * Validate a candidate output against the named schema version.
   *  - `version` undefined/empty → `not_applicable` (caller opted out, e.g. freeform text).
   *  - version provided but unregistered → `not_applicable` with an explanatory error
   *    (so it never silently *passes* as valid — the external-post gate rejects it).
   *  - registered + parse ok → `valid` (value is the parsed/coerced object).
   *  - registered + parse fail → `invalid` (errors describe why).
   */
  validate<T = unknown>(version: string | undefined, value: unknown): ValidationResult<T> {
    if (!version) return { status: 'not_applicable', errors: [] };
    const schema = this.schemas.get(version);
    if (!schema) {
      return { status: 'not_applicable', errors: [`schema version "${version}" is not registered; output was not validated`] };
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) return { status: 'valid', value: parsed.data as T, errors: [] };
    return { status: 'invalid', errors: zodErrors(parsed.error) };
  }
}

/** Process-wide registry. Workflow tasks register their schemas onto this. */
export const schemaRegistry = new SchemaRegistry();

/**
 * Gate before rendering structured output in the UI. Freeform output
 * (`not_applicable`) is allowed; only output that *failed* its schema is blocked.
 */
export function assertValidForDisplay(result: Pick<ValidationResult, 'status' | 'errors'>): void {
  if (result.status === 'invalid') {
    throw new SchemaValidationError('structured output failed schema validation; refusing to display', result.status, result.errors);
  }
}

/**
 * Gate before any external write (GitHub PR/comment, Datadog draft monitor).
 * Stricter than display: requires `valid`. Anything posted to a provider must
 * have gone through a registered schema, so `not_applicable` (no/unknown schema)
 * is rejected too — this is the line the ERD draws around provider mutations.
 */
export function assertValidForExternalPosting(result: Pick<ValidationResult, 'status' | 'errors'>): void {
  if (result.status !== 'valid') {
    const why = result.status === 'invalid' ? 'failed schema validation' : 'has no validated schema';
    throw new SchemaValidationError(`structured output ${why}; refusing to post externally`, result.status, result.errors);
  }
}

export { z };
