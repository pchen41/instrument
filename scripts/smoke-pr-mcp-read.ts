// Read-only live smoke for the github MCP client (Task 6 slice 2). Proves
// initialize + tools/call against the real TrueFoundry gateway with the read
// tools the PR-review worker uses. NO writes — safe to run anytime.
// Run: node_modules/.bin/vite-node scripts/smoke-pr-mcp-read.ts
import { readFileSync } from 'node:fs';
import { createMcpClient } from '../server/functions/_shared/mcp-client.ts';

const cfg = readFileSync('docs/CONFIG.md', 'utf8');
const pat = /truefoundry personal access token[^:]*:\s*(\S+)/i.exec(cfg)?.[1];
const url = 'https://gateway.truefoundry.ai/peterc/mcp/github/server';
if (!pat) { console.error('no PAT'); process.exit(1); }

const client = createMcpClient(url, pat, 'github');
let ok = true;
const check = (label: string, cond: boolean, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`); if (!cond) ok = false; };

const me = await client.call('get_me', {});
check('get_me (initialize + tools/call works)', !me.isError && me.text.length > 0);

const prs = await client.call('list_pull_requests', { owner: 'pchen41', repo: 'instrument', state: 'open', perPage: 5 });
check('list_pull_requests', !prs.isError);
let prNumber: number | null = null;
try {
  const arr = JSON.parse(prs.text);
  const list = Array.isArray(arr) ? arr : arr?.pull_requests ?? arr?.items ?? [];
  prNumber = list[0]?.number ?? null;
  console.log(`  open PRs: ${list.length}${prNumber ? ` (will read diff of #${prNumber})` : ''}`);
} catch { console.log('  (could not parse PR list shape — printing first 200 chars)\n  ', prs.text.slice(0, 200)); }

if (prNumber) {
  const diff = await client.call('pull_request_read', { method: 'get_diff', owner: 'pchen41', repo: 'instrument', pullNumber: prNumber });
  check('pull_request_read get_diff', !diff.isError && diff.text.length > 0, `${diff.text.length} chars`);
  const files = await client.call('pull_request_read', { method: 'get_files', owner: 'pchen41', repo: 'instrument', pullNumber: prNumber });
  check('pull_request_read get_files', !files.isError);
} else {
  console.log('  (no open PR to read a diff from — client transport already proven by get_me/list)');
}

console.log(ok ? '\nMCP READ PATH OK' : '\nFAILURES PRESENT');
process.exit(ok ? 0 : 1);
