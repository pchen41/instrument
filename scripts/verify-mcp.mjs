// Task 5C: verify the registered MCP servers through the TrueFoundry MCP Gateway
// and write their NON-SECRET registration into integrations.config.
//
//   probe (dry-run, default):  node scripts/verify-mcp.mjs
//   probe + write config:      node scripts/verify-mcp.mjs --apply
//
// Reads the InsForge admin key from .insforge/project.json (gitignored) and the
// TrueFoundry gateway PAT from env TFY_GATEWAY_PAT (never committed, never
// printed). It records server URLs/FQNs, explicit read/write tool allowlists,
// and live health into integrations.config — and refuses to write if any
// secret-looking value would land in the config.
//
// The read/write classification mirrors server/lib/mcp-config.ts (the unit-tested
// canonical version used by app code); kept compact here for a dependency-free
// ops script.
import { readFileSync } from 'node:fs';
import { createAdminClient } from '@insforge/sdk';

const APPLY = process.argv.includes('--apply');

const proj = JSON.parse(readFileSync(new URL('../.insforge/project.json', import.meta.url), 'utf8'));
const baseUrl = proj.oss_host;
const apiKey = proj.api_key;
const pat = process.env.TFY_GATEWAY_PAT;
if (!baseUrl || !apiKey) {
  console.error('Missing oss_host / api_key in .insforge/project.json');
  process.exit(2);
}
if (!pat) {
  console.error('Set TFY_GATEWAY_PAT (TrueFoundry gateway PAT) in the env. See docs/CONFIG.md. It is never printed.');
  process.exit(2);
}

const GATEWAY = 'https://gateway.truefoundry.ai';
const CONTROL_PLANE = 'https://peterc.truefoundry.cloud';
const OBS_BASE = 'https://instrument-9z6j.onrender.com';
const MODEL_INFERENCE = 'instrument/instrument'; // working short name (the prefixed virtual-model form 403s on inference)
const MODEL_FQN = 'peterc:virtual-model:instrument/instrument';

const SERVERS = [
  { name: 'github', url: `${GATEWAY}/peterc/mcp/github/server`, read_only: false },
  { name: 'datadog', url: `${GATEWAY}/peterc/mcp/datadog/server`, read_only: false },
  { name: 'instrument-investigation', url: `${GATEWAY}/peterc/mcp/instrument-investigation/server`, read_only: true },
];

// --- write-tool classification (mirror of server/lib/mcp-config.ts) -----------
const KNOWN_WRITE_TOOLS = {
  github: ['add_comment_to_pending_review', 'pull_request_review_write', 'create_and_submit_pull_request_review', 'submit_pending_pull_request_review', 'create_pending_pull_request_review', 'create_branch', 'create_or_update_file', 'push_files', 'delete_file', 'create_pull_request', 'update_pull_request', 'merge_pull_request', 'create_issue', 'update_issue', 'add_issue_comment'],
  datadog: ['create_datadog_monitor', 'update_datadog_monitor', 'mute_datadog_monitor'],
  'instrument-investigation': [],
};
const WRITE_PATTERNS = [/^create_/, /^update_/, /^upsert_/, /^delete_/, /^remove_/, /^edit_/, /^set_/, /^add_/, /^merge_/, /^push_/, /^post_/, /^put_/, /^patch_/, /^archive_/, /^mute_/, /^submit_/, /_write$/];
const isWriteTool = (server, tool) => {
  if ((KNOWN_WRITE_TOOLS[server] ?? []).includes(tool)) return true;
  if (server === 'instrument-investigation') return false;
  return WRITE_PATTERNS.some((re) => re.test(tool));
};
const partition = (server, tools) => {
  const read = new Set(), write = new Set();
  for (const t of tools) (isWriteTool(server, t) ? write : read).add(t);
  return { read: [...read].sort(), write: [...write].sort() };
};

// ERD-documented fallback tool names, used when a live tools/list can't be read.
const ERD_TOOLS = {
  github: ['get_file_contents', 'get_pull_request', 'get_pull_request_diff', 'get_pull_request_files', 'list_commits', 'list_pull_requests', 'create_branch', 'create_or_update_file', 'create_pull_request', 'add_comment_to_pending_review', 'pull_request_review_write'],
  datadog: ['get_logs', 'query_metrics', 'list_monitors', 'get_monitor', 'list_incidents', 'get_trace', 'list_services', 'create_datadog_monitor'],
  'instrument-investigation': ['health_check', 'query_truefoundry_model_metrics', 'query_truefoundry_mcp_metrics', 'search_truefoundry_request_logs', 'get_truefoundry_trace_spans', 'get_instrument_evidence_bundle'],
};

// --- secret-leak guard (mirror of mcp-config.findSecretLikeValues) ------------
const SECRET_KEY = /(token|secret|api[_-]?key|password|authorization|bearer|pat)\b/i;
const SECRET_VALUE = [/^Bearer\s+/i, /^gh[pousr]_[A-Za-z0-9]{20,}/, /^github_pat_[A-Za-z0-9_]{20,}/, /^eyJ[A-Za-z0-9_-]{10,}\./, /^sk-[A-Za-z0-9]{20,}/];
function findSecretLike(node, p = '', hits = []) {
  if (node == null) return hits;
  if (typeof node === 'string') { if (SECRET_VALUE.some((re) => re.test(node))) hits.push(p); return hits; }
  if (Array.isArray(node)) { node.forEach((v, i) => findSecretLike(v, `${p}[${i}]`, hits)); return hits; }
  if (typeof node === 'object') for (const [k, v] of Object.entries(node)) {
    const c = p ? `${p}.${k}` : k;
    if (SECRET_KEY.test(k) && typeof v === 'string' && v) hits.push(c);
    else findSecretLike(v, c, hits);
  }
  return hits;
}

// --- minimal MCP Streamable-HTTP client: initialize -> tools/list -------------
function parseMcp(bodyText, contentType) {
  // SSE frames ("data: {...}") or a single JSON body.
  if ((contentType || '').includes('text/event-stream')) {
    for (const line of bodyText.split('\n')) {
      const t = line.trim();
      if (t.startsWith('data:')) {
        try { const j = JSON.parse(t.slice(5).trim()); if (j.result || j.error) return j; } catch { /* keep scanning */ }
      }
    }
    return null;
  }
  try { return JSON.parse(bodyText); } catch { return null; }
}

async function listTools(server) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${pat}` };
  const rpc = async (body, extra = {}) => {
    const res = await fetch(server.url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const text = await res.text();
    return { res, text };
  };
  try {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'instrument-verify', version: '0.1.0' } } });
    if (!init.res.ok) return { health: init.res.status === 401 || init.res.status === 403 ? 'degraded' : 'unreachable', tools: null, note: `initialize HTTP ${init.res.status}` };
    const session = init.res.headers.get('mcp-session-id') || init.res.headers.get('Mcp-Session-Id');
    const sh = session ? { 'mcp-session-id': session } : {};
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, sh).catch(() => {});
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sh);
    const parsed = parseMcp(list.text, list.res.headers.get('content-type'));
    const tools = parsed?.result?.tools?.map((t) => t.name).filter(Boolean);
    if (Array.isArray(tools) && tools.length) return { health: 'healthy', tools, note: null };
    return { health: 'degraded', tools: null, note: `tools/list returned no tools (HTTP ${list.res.status})` };
  } catch (e) {
    return { health: 'unreachable', tools: null, note: `connect error: ${e?.name ?? 'error'}` };
  }
}

async function probeHealthz() {
  try {
    const res = await fetch(`${OBS_BASE}/healthz`, { method: 'GET' });
    const text = await res.text();
    let status = null;
    try { status = JSON.parse(text)?.status; } catch { /* ignore */ }
    return { ok: res.ok, http: res.status, status };
  } catch (e) {
    return { ok: false, http: 0, status: null, error: e?.name ?? 'error' };
  }
}

// ------------------------------------------------------------------------------
const checkedAt = new Date().toISOString();
console.log(`MCP verification ${APPLY ? '(APPLY)' : '(dry-run)'} @ ${checkedAt}\n`);

const healthz = await probeHealthz();
console.log(`Render observability MCP /healthz: HTTP ${healthz.http} status=${healthz.status ?? healthz.error ?? '?'}`);

const registry = [];
for (const s of SERVERS) {
  const probe = await listTools(s);
  const live = !!probe.tools;
  const tools = probe.tools ?? ERD_TOOLS[s.name];
  const { read, write } = partition(s.name, s.read_only ? [...tools] : tools);
  const entry = {
    name: s.name,
    server_url: s.url,
    read_only: s.read_only,
    allowed_tools: s.read_only ? { read: [...new Set([...read, ...write])].sort(), write: [] } : { read, write },
    health: probe.health,
    tool_source: live ? 'gateway_tools_list' : 'erd_documented',
    last_checked_at: checkedAt,
    ...(probe.note ? { note: probe.note } : {}),
  };
  registry.push(entry);
  console.log(`  ${s.name}: health=${probe.health} tools=${tools.length} (${entry.tool_source}) read=${read.length} write=${write.length}${probe.note ? ` [${probe.note}]` : ''}`);
}

const obsHealth = healthz.ok && healthz.status === 'ok' ? 'healthy' : healthz.http ? 'degraded' : 'unreachable';

const admin = createAdminClient({ baseUrl, apiKey });
const db = admin.database;

// Resolve the workspace integrations.
const { data: integ, error: integErr } = await db.from('integrations').select('id, provider, config').in('provider', ['truefoundry', 'github', 'datadog']);
if (integErr) { console.error('Failed to read integrations:', integErr.message ?? integErr); process.exit(1); }
const byProvider = Object.fromEntries((integ ?? []).map((r) => [r.provider, r]));

function tfyConfig(prev) {
  return {
    ...prev,
    model: MODEL_INFERENCE,
    model_fqn: MODEL_FQN,
    gateway_base_url: GATEWAY,
    control_plane_url: CONTROL_PLANE,
    api_endpoints: { chat_completions: '/api/inference/openai/chat/completions', metrics_query: '/api/svc/v1/llm-gateway/metrics/query', spans_query: '/api/svc/v1/spans/query' },
    mcp_servers: registry,
    observability_mcp: { name: 'instrument-investigation', base_url: OBS_BASE, mcp_url: `${OBS_BASE}/mcp`, health_url: `${OBS_BASE}/healthz`, health: obsHealth, last_checked_at: checkedAt },
    last_checked_at: checkedAt,
  };
}
function providerMcp(name) {
  const e = registry.find((r) => r.name === name);
  return { server_url: e.server_url, read_only: e.read_only, allowed_tools: e.allowed_tools, health: e.health, tool_source: e.tool_source, last_checked_at: checkedAt };
}

const writes = [];
if (byProvider.truefoundry) {
  const config = tfyConfig(byProvider.truefoundry.config ?? {});
  const allHealthy = registry.every((r) => r.health === 'healthy') && obsHealth === 'healthy';
  writes.push({ id: byProvider.truefoundry.id, provider: 'truefoundry', config, status: allHealthy ? 'connected' : 'degraded' });
}
if (byProvider.github) writes.push({ id: byProvider.github.id, provider: 'github', config: { ...(byProvider.github.config ?? {}), mcp: providerMcp('github') } });
if (byProvider.datadog) writes.push({ id: byProvider.datadog.id, provider: 'datadog', config: { ...(byProvider.datadog.config ?? {}), mcp: providerMcp('datadog') } });

// Secret-leak guard across everything we'd persist.
const leaks = writes.flatMap((w) => findSecretLike(w.config, `${w.provider}.config`));
if (leaks.length) { console.error('\n✗ ABORT: secret-looking values would be written:', leaks); process.exit(1); }
console.log('\n✓ secret-leak guard clean (no token/PAT/bearer values in config)');

console.log('\nPlanned integrations.config writes:');
for (const w of writes) console.log(`  ${w.provider}${w.status ? ` [status=${w.status}]` : ''}:\n${JSON.stringify(w.config, null, 2).split('\n').map((l) => '    ' + l).join('\n')}`);

if (!APPLY) { console.log('\n(dry-run) re-run with --apply to write. Nothing changed.'); process.exit(0); }

for (const w of writes) {
  const patch = { config: w.config, last_checked_at: checkedAt, ...(w.status ? { status: w.status } : {}) };
  const { error } = await db.from('integrations').update(patch).eq('id', w.id);
  if (error) { console.error(`✗ write failed for ${w.provider}:`, error.message ?? error); process.exit(1); }
  console.log(`✓ wrote ${w.provider} config`);
}
console.log('\n✓ integrations.config updated.');
