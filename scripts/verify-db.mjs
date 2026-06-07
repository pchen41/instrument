// Runs db/verify.sql against the linked InsForge project and reports pass/fail.
// The SQL is one DO block that asserts the Task 2 schema/constraints and ends by
// raising the sentinel 'INSTRUMENT_DB_VERIFY_OK' (so every test insert rolls back).
// A failed assertion raises a 'FAIL: ...' message instead. Requires the InsForge
// CLI to be authenticated and a project linked (.insforge/project.json).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, '..', 'db', 'verify.sql'), 'utf8');

// The script starts with a `--` SQL comment; the CLI's arg parser would treat an
// argument beginning with `-` as an option. A leading newline (invisible to
// Postgres) keeps it a positional <sql> value.
const arg = '\n' + sql;

let out = '';
try {
  // execFile (no shell) so the multi-KB $$ block is passed as one argv element.
  out = execFileSync('npx', ['@insforge/cli', 'db', 'query', arg], { encoding: 'utf8' });
} catch (err) {
  out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
}

// The CLI echoes the SQL (which literally contains the sentinel + 'FAIL:'
// strings), then prints the *raised* message as 'Error: <message>'. Match on
// that 'Error: ' prefix so the echoed SQL body doesn't create false signals.
const passed = /Error:\s*INSTRUMENT_DB_VERIFY_OK/.test(out) && !/Error:\s*FAIL:/.test(out);
if (passed) {
  console.log('✓ DB schema + constraint verification passed (db/verify.sql)');
  process.exit(0);
}
const errLine =
  out.split('\n').find((l) => /Error:/.test(l) && !/raise exception/.test(l)) ?? out.trim();
console.error('✗ DB verification failed:\n' + errLine.trim());
process.exit(1);
