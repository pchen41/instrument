// Minimal MCP Streamable-HTTP JSON-RPC client for the Edge Function runtime
// (Task 6). Talks to a TrueFoundry MCP Gateway server (e.g. the github MCP):
// initialize → notifications/initialized → tools/call, handling either an SSE
// (text/event-stream) or a single-JSON response, with a bounded timeout so a slow
// gateway can't outlive the worker lease. This is the governed-tool transport
// used for the PR-review deterministic read + the single scoped write.
//
// The bearer is the TrueFoundry PAT (server-only secret) — the gateway brokers
// the provider credential, so no GitHub token is ever handled here. Failures map
// to JobError so the worker's retry/terminal machinery applies: network/timeout/
// 429/5xx are retryable; 401/403/other 4xx are terminal.
import { JobError } from '../../lib/retry.ts';
import { scrubSecrets } from '../../lib/redaction.ts';

// deno-lint-ignore no-explicit-any
declare const Deno: any;

const PROTOCOL_VERSION = '2025-03-26';
// Per-CALL budget. A phase makes several sequential calls (readDiff ~2-3,
// postReviewComment ~3-4) and the worker lease (LEASE_SECONDS=60) is renewed only
// BETWEEN phases — so the per-call timeout must keep the cumulative worst-case
// phase well under the lease, or an over-running phase gets reclaimed + re-run
// concurrently. At 12s a 4-call phase is ~48s < 60s.
const CALL_TIMEOUT_MS = 12_000;
const MAX_RESULT_CHARS = 60_000;

/** JobError.source — which provider a failure is attributed to. */
type FailureSource = 'github' | 'datadog' | 'truefoundry' | 'worker';

export interface McpCallResult {
  /** Concatenated text content from the tool result, bounded. */
  text: string;
  /** Whether the MCP server flagged the result as an error. */
  isError: boolean;
  /** The raw parsed JSON-RPC `result` (bounded by the server). */
  raw: unknown;
}

export interface McpClient {
  call(tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

export function createMcpClient(serverUrl: string, bearer: string, label = 'mcp', source: FailureSource = 'github'): McpClient {
  let sessionId: string | null = null;
  let initialized = false;

  const headers = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${bearer}`,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  });

  async function rpc(body: unknown): Promise<{ res: Response; text: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
    try {
      const res = await fetch(serverUrl, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: ctrl.signal });
      const text = await res.text();
      return { res, text };
    } catch (err) {
      const aborted = err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
      throw new JobError({
        retryable: true,
        code: aborted ? `${label}_timeout` : `${label}_unreachable`,
        summary: aborted ? `MCP call to ${label} exceeded ${CALL_TIMEOUT_MS / 1000}s.` : `MCP connection to ${label} failed.`,
        source,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function parse(text: string, contentType: string | null): any {
    if ((contentType ?? '').includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t.startsWith('data:')) {
          try {
            const j = JSON.parse(t.slice(5).trim());
            if (j.result || j.error) return j;
          } catch {
            /* keep scanning frames */
          }
        }
      }
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'instrument', version: '0.1.0' } } });
    if (!init.res.ok) {
      const retryable = init.res.status === 429 || init.res.status >= 500;
      throw new JobError({ retryable, code: `${label}_init_http_${init.res.status}`, summary: `MCP ${label} initialize returned HTTP ${init.res.status}.`, source });
    }
    sessionId = init.res.headers.get('mcp-session-id') ?? init.res.headers.get('Mcp-Session-Id');
    // best-effort notification; failure here is non-fatal
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }).catch(() => {});
    initialized = true;
  }

  return {
    async call(tool, args) {
      await ensureInitialized();
      const { res, text } = await rpc({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: args } });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new JobError({ retryable, code: `${label}_http_${res.status}`, summary: `MCP ${label} tools/call returned HTTP ${res.status}.`, source });
      }
      const parsed = parse(text, res.headers.get('content-type'));
      if (!parsed || parsed.error) {
        // Scrub the provider message — it lands in persisted job error fields.
        const msg = parsed?.error?.message ? scrubSecrets(String(parsed.error.message)).slice(0, 200) : 'no result';
        throw new JobError({ retryable: false, code: `${label}_tool_error`, summary: `MCP ${label} tool "${tool}" failed: ${msg}.`, source });
      }
      const result = parsed.result ?? {};
      const content = Array.isArray(result.content) ? result.content : [];
      const textOut = content
        .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('\n')
        .slice(0, MAX_RESULT_CHARS);
      return { text: textOut, isError: result.isError === true, raw: result };
    },
  };
}
