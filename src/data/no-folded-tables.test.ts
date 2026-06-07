import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Tables that were folded out of the expanded ERD into the 15-table first slice
// (docs/ERD.md "Folded Tables and Where Their Data Lives"). No application query
// or seed fixture may reference them.
const FOLDED_TABLES = [
  'mcp_servers',
  'mcp_tool_invocations',
  'workspace_settings',
  'app_events',
  'scans',
  'datadog_monitors',
  'generated_pull_requests',
  'services',
  'repository_service_paths',
  'github_push_events',
  'pr_review_runs',
  'pr_review_findings',
  'job_audit_events',
  'recommendation_events',
  'generated_datadog_monitors',
  'datadog_alert_events',
];

function walk(dir: string, match: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match(full)) out.push(full);
  }
  return out;
}

describe('no folded/retired table references', () => {
  const root = process.cwd();

  it('application code (src/) never queries a folded table via .from()', () => {
    const files = walk(join(root, 'src'), (f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'));
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const t of FOLDED_TABLES) {
        if (new RegExp(`\\.from\\(\\s*['"\`]${t}['"\`]`).test(text)) {
          violations.push(`${file} -> .from('${t}')`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('seed fixtures (migrations/*seed*.sql) never reference a folded table', () => {
    const files = walk(join(root, 'migrations'), (f) => /seed.*\.sql$/.test(f));
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const t of FOLDED_TABLES) {
        if (new RegExp(`(insert\\s+into|from|update|delete\\s+from|join)\\s+(public\\.)?${t}\\b`, 'i').test(text)) {
          violations.push(`${file} -> ${t}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
