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

/** Health of a registered MCP server, as recorded in integrations.config. */
export type McpHealth = 'healthy' | 'degraded' | 'unreachable' | 'unregistered' | 'unknown';

export interface McpServerConfig {
  name: string;
  /** TrueFoundry MCP Gateway FQN if known (non-secret). */
  fqn?: string;
  server_url: string;
  /** True for a read-only virtual MCP (e.g. instrument-investigation). */
  read_only: boolean;
  allowed_tools: { read: string[]; write: string[] };
  health: McpHealth;
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
  ],
  datadog: ['create_datadog_monitor', 'update_datadog_monitor', 'mute_datadog_monitor'],
  'instrument-investigation': [],
};

/** Name patterns that almost always indicate a mutating tool. */
const WRITE_NAME_PATTERNS = [
  /^create_/, /^update_/, /^upsert_/, /^delete_/, /^remove_/, /^edit_/, /^set_/, /^add_/, /^merge_/,
  /^push_/, /^post_/, /^put_/, /^patch_/, /^archive_/, /^mute_/, /^submit_/, /_write$/,
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

export interface BuildMcpServerConfigInput {
  name: string;
  serverUrl: string;
  toolNames: string[];
  readOnly?: boolean;
  health: McpHealth;
  checkedAt: string;
  fqn?: string;
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
    last_checked_at: input.checkedAt,
    ...(input.note ? { note: input.note } : {}),
  };
}

/**
 * Guard against secrets leaking into stored MCP config. Returns the offending
 * key paths (empty = clean). Used by tests and the verify script before writing.
 */
export function findSecretLikeValues(obj: unknown, path = ''): string[] {
  const SECRET_KEY = /(token|secret|api[_-]?key|password|authorization|bearer|pat)\b/i;
  const SECRET_VALUE = [
    /^Bearer\s+/i,
    /^gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub PAT/token forms
    /^github_pat_[A-Za-z0-9_]{20,}/,
    /^eyJ[A-Za-z0-9_-]{10,}\./, // JWT (TrueFoundry PAT)
    /^sk-[A-Za-z0-9]{20,}/,
  ];
  const hits: string[] = [];
  const walk = (node: unknown, p: string): void => {
    if (node == null) return;
    if (typeof node === 'string') {
      if (SECRET_VALUE.some((re) => re.test(node))) hits.push(p);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${p}[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const child = p ? `${p}.${k}` : k;
        if (SECRET_KEY.test(k) && typeof v === 'string' && v.length > 0) hits.push(child);
        else walk(v, child);
      }
    }
  };
  walk(obj, path);
  return hits;
}
