// Datadog HTTP submitter for the Edge Function runtime (Task 5D).
//
// The reliability signals (instrument.job.retry / instrument.job.error) reach
// Datadog over HTTPS — the Metrics v2 intake for the threshold the monitor
// watches, and the Events v1 intake for the human-readable record that lands in
// the validation incident. This is the agent-less, HTTP-based path the task
// requires for Edge Functions (no UDP/dogstatsd agent in this runtime).
//
// Config (Deno env):
//   DATADOG_API_KEY  — submission key (server-only secret). Absent → mock sink.
//   DATADOG_SITE     — e.g. 'us5.datadoghq.com' (default). API host = api.<site>.
//   DD_SERVICE       — service tag (default 'instrument').
//   DD_ENV           — environment tag (default 'production').
//
// When the key is absent every submit is a no-op and `enabled` is false — local
// and credential-free test runs keep working against this documented mock sink.
// The key is never logged; on a non-2xx the response body is dropped in favor of
// a short `datadog_http_<status>` code so no token/payload rides into an error.
import type { DatadogEvent, DatadogSubmitter } from '../../lib/telemetry.ts';

// deno-lint-ignore no-explicit-any
declare const Deno: any;

const DEFAULT_SITE = 'us5.datadoghq.com';
// Bounded so a slow us5 can't blow the worker tick budget: the emitter runs
// inside finishFailure for up to maxJobs failing jobs (metric + event each), so
// keep per-submit short. Datadog intake normally responds in well under a second.
const SUBMIT_TIMEOUT_MS = 5_000;
const METRIC_INTERVAL_S = 60;
const DD_METRIC_TYPE_COUNT = 1; // Datadog intake v2: 1=count, 2=rate, 3=gauge

export interface DatadogClient extends DatadogSubmitter {
  service: string;
  environment: string;
  site: string;
}

class DatadogError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.name = 'DatadogError';
    this.code = code;
  }
}

export function createDatadogClient(): DatadogClient {
  const apiKey = Deno.env.get('DATADOG_API_KEY') ?? '';
  const site = Deno.env.get('DATADOG_SITE') ?? DEFAULT_SITE;
  const service = Deno.env.get('DD_SERVICE') ?? 'instrument';
  const environment = Deno.env.get('DD_ENV') ?? 'production';
  const enabled = apiKey.length > 0;
  const base = `https://api.${site}`;

  async function post(path: string, body: unknown): Promise<void> {
    if (!enabled) return; // mock sink: nothing leaves the process
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SUBMIT_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'DD-API-KEY': apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const aborted = err && typeof err === 'object' && 'name' in err && (err as { name?: string }).name === 'AbortError';
      throw new DatadogError(aborted ? 'datadog_timeout' : 'datadog_unreachable');
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      // Drain the body so the connection is freed, but never surface it.
      await resp.text().catch(() => '');
      throw new DatadogError(`datadog_http_${resp.status}`);
    }
  }

  return {
    enabled,
    service,
    environment,
    site,
    async submitMetric(name, value, tags) {
      await post('/api/v2/series', {
        series: [
          {
            metric: name,
            type: DD_METRIC_TYPE_COUNT,
            interval: METRIC_INTERVAL_S,
            points: [{ timestamp: Math.floor(Date.now() / 1000), value }],
            tags,
          },
        ],
      });
    },
    async submitEvent(event: DatadogEvent) {
      await post('/api/v1/events', {
        title: event.title,
        text: event.text,
        alert_type: event.alertType,
        tags: event.tags,
        aggregation_key: event.aggregationKey,
        source_type_name: 'instrument',
      });
    },
  };
}
