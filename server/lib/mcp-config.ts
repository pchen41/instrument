// MCP registry config helpers (Task 5C foundation).
//
// Turns a TrueFoundry MCP Gateway server's advertised tool list into the
// *non-secret* shape we store in `integrations.config` for the demo: the server
// name/FQN/URL, an explicit read-vs-write tool allowlist, and health/last-checked
// state. No bearer tokens, PATs, or provider keys ever pass through here — those
// live only in server-side secrets, referenced by `integrations.secret_ref`.
//
// Runtime-agnostic pure TS so the partitioning logic is unit-tested; the live
// gateway calls + integrations write happen in scripts/verify-mcp.mjs.
//
// The secret-leak guard lives in ./redaction (shared with model-call); re-exported
// here for callers that already import from mcp-config.
export { findSecretLikeValues } from './redaction';

/** Health of a registered MCP server, as recorded in integrations.config. */
export type McpHealth = 'healthy' | 'degraded' | 'unreachable' | 'unregistered' | 'unknown';

/** Where a server's tool list came from (live gateway vs ERD-documented fallback). */
export type ToolSource = 'gateway_tools_list' | 'erd_documented';

export interface McpServerConfig {
  name: string;
  /** TrueFoundry MCP Gateway FQN if known (non-secret). */
  fqn?: string;
  server_url: string;
  /** True for a read-only virtual MCP (e.g. instrument-investigation). */
  read_only: boolean;
  allowed_tools: { read: string[]; write: string[] };
  health: McpHealth;
  tool_source?: ToolSource;
  last_checked_at: string;
  /** Optional non-secret note (e.g. why degraded). */
  note?: string;
}

/**
 * Tools that MUTATE provider state, by MCP server. A tool not listed here (and
 * not matching `WRITE_NAME_PATTERNS`) is treated as read-only. Sourced from
 * docs/ERD.md's GitHub/Datadog MCP tool notes; extend as toolsets grow.
 */
export const KNOWN_WRITE_TOOLS: Record<string, string[]> = {
  github: [
    'add_comment_to_pending_review',
    'pull_request_review_write',
    'create_and_submit_pull_request_review',
    'submit_pending_pull_request_review',
    'create_pending_pull_request_review',
    'create_branch',
    'create_or_update_file',
    'push_files',
    'delete_file',
    'create_pull_request',
    'update_pull_request',
    'merge_pull_request',
    'create_issue',
    'update_issue',
    'add_issue_comment',
    'fork_repository',
    'request_copilot_review',
  ],
  datadog: ['create_datadog_monitor', 'update_datadog_monitor', 'mute_datadog_monitor', 'unmute_datadog_monitor'],
  'instrument-investigation': [],
};

/**
 * Name prefixes/suffixes that indicate a mutating tool. Deliberately broad: a
 * false "write" only over-restricts (puts a read behind the approval gate); a
 * missed write is a governance hole. A tool matching none of these on a
 * non-read-only server still defaults to read, so keep this list current.
 */
const WRITE_NAME_PATTERNS = [
  /^create_/, /^update_/, /^upsert_/, /^delete_/, /^remove_/, /^edit_/, /^set_/, /^add_/, /^merge_/,
  /^push_/, /^post_/, /^put_/, /^patch_/, /^archive_/, /^mute_/, /^unmute_/, /^submit_/, /^fork_/,
  /^request_/, /^run_/, /^rerun_/, /^trigger_/, /^cancel_/, /^enable_/, /^disable_/, /^dismiss_/,
  /^assign_/, /^lock_/, /^unlock_/, /^close_/, /^reopen_/, /^approve_/, /^revoke_/, /^write_/, /_write$/,
];

/** Decide whether a single tool name mutates provider state. */
export function isWriteTool(server: string, tool: string): boolean {
  const known = KNOWN_WRITE_TOOLS[server];
  if (known && known.includes(tool)) return true;
  // A virtual read-only server is read-only regardless of tool names.
  if (server === 'instrument-investigation') return false;
  return WRITE_NAME_PATTERNS.some((re) => re.test(tool));
}

/** Split an advertised tool list into explicit read/write allowlists (sorted, deduped). */
export function partitionTools(server: string, toolNames: string[]): { read: string[]; write: string[] } {
  const read = new Set<string>();
  const write = new Set<string>();
  for (const name of toolNames) {
    if (!name) continue;
    (isWriteTool(server, name) ? write : read).add(name);
  }
  return { read: [...read].sort(), write: [...write].sort() };
}

// (secret-leak guard moved to ./redaction and re-exported above)

export interface BuildMcpServerConfigInput {
  name: string;
  serverUrl: string;
  toolNames: string[];
  readOnly?: boolean;
  health: McpHealth;
  checkedAt: string;
  fqn?: string;
  toolSource?: ToolSource;
  note?: string;
}

/** Build the non-secret `integrations.config` entry for one MCP server. */
export function buildMcpServerConfig(input: BuildMcpServerConfigInput): McpServerConfig {
  const readOnly = input.readOnly ?? input.name === 'instrument-investigation';
  const { read, write } = partitionTools(input.name, input.toolNames);
  return {
    name: input.name,
    ...(input.fqn ? { fqn: input.fqn } : {}),
    server_url: input.serverUrl,
    read_only: readOnly,
    // A read-only server never exposes write tools, even if the gateway lists some.
    allowed_tools: { read: readOnly ? [...read, ...write].sort() : read, write: readOnly ? [] : write },
    health: input.health,
    ...(input.toolSource ? { tool_source: input.toolSource } : {}),
    last_checked_at: input.checkedAt,
    ...(input.note ? { note: input.note } : {}),
  };
}
