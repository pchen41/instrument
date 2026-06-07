// Shared server-side instrumentation (Task 5D).
//
// The broad app-telemetry surface: structured logs, metrics, and trace spans
// usable by every backend path — server functions, the worker, webhook handlers,
// provider clients, the model/MCP call path, UI read endpoints, and external
// write executors. This is distinct from telemetry.ts (the two *reliability*
// signals persisted to telemetry_emissions); here we emit broad observability
// directly to the configured sink. Per the ERD, general logs/metrics/traces go
// to Datadog (or the platform log stream the observability MCP reads) and are NOT
// written to telemetry_emissions.
//
// Two hard requirements shape the design:
//   - It must keep working with NO Datadog config — a no-op/console sink — so
//     local/test runs never break for lack of telemetry.
//   - It must never emit raw secrets. Every string attribute is scrubbed, and
//     stable redacted attributes (service/env/workflow/job_type/integration/
//     request_id/trace_id) are bound once via `child()` and merged into each emit.
//
// Runtime-agnostic pure TS; the concrete sink (console / Datadog) is injected.
import { isSecretValue, SECRET_KEY_PATTERN, scrubSecrets } from './redaction';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type EntryKind = 'log' | 'metric' | 'span';

/** A single instrumentation record handed to the sink. */
export interface InstrumentationEntry {
  kind: EntryKind;
  name: string;
  level: LogLevel;
  /** Epoch ms; stamped by the helper so the sink stays trivial. */
  ts: number;
  /** Stable redacted attributes (service/env/workflow/... ) merged with per-call. */
  attributes: Record<string, unknown>;
  /** For kind === 'metric'. */
  value?: number;
  /** For kind === 'span': duration once finished. */
  durationMs?: number;
}

export interface InstrumentationSink {
  emit(entry: InstrumentationEntry): void;
}

/** Discards everything. Used implicitly when no sink is configured. */
export const noopSink: InstrumentationSink = { emit() {} };

/**
 * Default sink: one structured JSON line to console per entry. InsForge captures
 * function stdout into its log stream, which the observability MCP can read — so
 * "mock" mode is still useful telemetry, not a black hole.
 */
export function createConsoleSink(write: (line: string) => void = (l) => console.log(l)): InstrumentationSink {
  return {
    emit(entry) {
      write(JSON.stringify({ source: 'instrument', ...entry }));
    },
  };
}

/** Collects entries in memory. For tests / the documented local Datadog sink. */
export interface MemorySink extends InstrumentationSink {
  entries: InstrumentationEntry[];
}
export function createMemorySink(): MemorySink {
  const entries: InstrumentationEntry[] = [];
  return { entries, emit: (e) => entries.push(e) };
}

export interface InstrumentationConfig {
  service: string;
  environment: string;
  /** Master switch; false → no-op regardless of the sink (local/test default). */
  enabled?: boolean;
}

export interface Instrumentation {
  log(level: LogLevel, name: string, attributes?: Record<string, unknown>): void;
  metric(name: string, value: number, attributes?: Record<string, unknown>): void;
  /** Start a span; call the returned finisher to emit it with a duration. */
  span(name: string, attributes?: Record<string, unknown>): (extra?: Record<string, unknown>) => void;
  /** Bind extra stable attributes (e.g. {workflow, job_type, integration}). */
  child(attributes: Record<string, unknown>): Instrumentation;
}

/**
 * Redact an attribute bag: drop/​mask values that look like secrets and mask
 * secret-shaped substrings inside ordinary strings. Keeps numbers/booleans as-is.
 * Applied to every emitted entry so no provider token or admin key can leak via
 * a stray attribute (e.g. an error string carrying an Authorization header).
 */
export function redactAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (typeof v === 'string') {
      if (SECRET_KEY_PATTERN.test(k) || isSecretValue(v)) out[k] = '‹redacted›';
      else out[k] = scrubSecrets(v);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else {
      // Nested objects/arrays: stringify + scrub so we never emit an unbounded or
      // secret-bearing blob, and keep the line a flat structured record.
      out[k] = scrubSecrets(safeStringify(v)).slice(0, 1000);
    }
  }
  return out;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Build an instrumentation facade over a sink. When disabled (default, e.g. no
 * Datadog config in local/test) every method is a cheap no-op but still callable,
 * so call sites are unconditional. `now` is injectable for deterministic tests.
 */
export function createInstrumentation(
  config: InstrumentationConfig,
  sink: InstrumentationSink = noopSink,
  now: () => number = () => Date.now(),
): Instrumentation {
  const enabled = config.enabled !== false && sink !== noopSink;
  const base: Record<string, unknown> = { service: config.service, env: config.environment };

  function make(bound: Record<string, unknown>): Instrumentation {
    const emit = (kind: EntryKind, level: LogLevel, name: string, attributes: Record<string, unknown>, extra: Partial<InstrumentationEntry>) => {
      if (!enabled) return;
      sink.emit({
        kind,
        name,
        level,
        ts: now(),
        attributes: redactAttributes({ ...bound, ...attributes }),
        ...extra,
      });
    };
    return {
      log(level, name, attributes = {}) {
        emit('log', level, name, attributes, {});
      },
      metric(name, value, attributes = {}) {
        emit('metric', 'info', name, attributes, { value });
      },
      span(name, attributes = {}) {
        const start = now();
        return (extra = {}) => emit('span', 'info', name, { ...attributes, ...extra }, { durationMs: now() - start });
      },
      child(attributes) {
        return make({ ...bound, ...attributes });
      },
    };
  }

  return make(base);
}
