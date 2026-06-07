// Behavioral RLS test using real JWTs through @insforge/sdk. db query cannot
// switch roles, so this is the faithful check that a signed-in member can read
// their workspace but cannot write service-only tables, and that a non-member
// (here: an anonymous client) sees nothing.
//
// Reads the browser-safe URL + anon key from .env.local (or env). The demo
// password is NOT committed -- pass it at run time:
//   INSTRUMENT_DEMO_PASSWORD=... npm run verify:rls
import { readFileSync } from 'node:fs';
import { createClient } from '@insforge/sdk';

function fromEnvLocal(key) {
  try {
    const txt = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    const m = txt.match(new RegExp('^' + key + '=(.*)$', 'm'));
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

const baseUrl = process.env.VITE_INSFORGE_URL || fromEnvLocal('VITE_INSFORGE_URL');
const anonKey = process.env.VITE_INSFORGE_ANON_KEY || fromEnvLocal('VITE_INSFORGE_ANON_KEY');
const email = process.env.INSTRUMENT_DEMO_EMAIL || 'test@test.com';
const password = process.env.INSTRUMENT_DEMO_PASSWORD;

if (!baseUrl || !anonKey) {
  console.error('Missing VITE_INSFORGE_URL / VITE_INSFORGE_ANON_KEY (.env.local).');
  process.exit(2);
}
if (!password) {
  console.error('Skipping RLS test: set INSTRUMENT_DEMO_PASSWORD (see docs/CONFIG.md).');
  process.exit(0); // skip, do not fail CI without creds
}

const failures = [];
const check = (name, ok) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failures.push(name);
};

const member = createClient({ baseUrl, anonKey });
const { data: signIn, error: signInErr } = await member.auth.signInWithPassword({ email, password });
if (signInErr) {
  console.error('Sign-in failed:', signInErr.message ?? signInErr);
  process.exit(1);
}
const uid = signIn?.user?.id;

// 1. member reads their workspace + integrations
const ws = await member.database.from('workspaces').select('id, slug, investigation_start_mode');
check('member reads their workspace', !ws.error && ws.data?.some((r) => r.slug === 'instrument'));
const wid = ws.data?.find((r) => r.slug === 'instrument')?.id;

const ints = await member.database.from('integrations').select('provider, status');
check('member reads integrations (>=3)', !ints.error && (ints.data?.length ?? 0) >= 3);

// 2. member self-reads workspace_members: exactly their own row, no one else's
const mem = await member.database.from('workspace_members').select('user_id');
check(
  'member self-reads only their membership row',
  !mem.error && mem.data?.length === 1 && mem.data[0].user_id === uid,
);

// 3. member CANNOT directly insert a job (service-only)
const jobIns = await member.database.from('jobs').insert([
  {
    workspace_id: wid,
    job_type: 'proactive_scan',
    target_type: 'repository',
    target_id: uid,
    idempotency_key: 'rls-test-' + Date.now(),
  },
]);
check('member CANNOT insert a job', !!jobIns.error);

// 4. member CANNOT directly insert an external write action (service-only)
const ewaIns = await member.database.from('external_write_actions').insert([
  {
    workspace_id: wid,
    provider: 'github',
    action_kind: 'github_create_pr',
    idempotency_key: 'rls-test-' + Date.now(),
    target_summary: 't',
    request_hash: 'h',
  },
]);
check('member CANNOT insert an external write action', !!ewaIns.error);

// 5. member CAN update workspace settings, but NOT slug
const before = ws.data?.find((r) => r.slug === 'instrument')?.investigation_start_mode;
const next = before === 'manual' ? 'smart' : 'manual';
const setOk = await member.database
  .from('workspaces')
  .update({ investigation_start_mode: next })
  .eq('id', wid);
check('member CAN update workspaces.investigation_start_mode', !setOk.error);
// revert
await member.database.from('workspaces').update({ investigation_start_mode: before }).eq('id', wid);

const slugUpd = await member.database.from('workspaces').update({ slug: 'hacked' }).eq('id', wid);
check('member CANNOT update workspaces.slug', !!slugUpd.error);

// 6. non-member (anonymous client) sees no workspace-owned data
const anon = createClient({ baseUrl, anonKey });
const anonRead = await anon.database.from('integrations').select('provider');
check('non-member/anon reads NO integrations', (anonRead.data?.length ?? 0) === 0);

await member.auth.signOut();

if (failures.length) {
  console.error(`\n✗ RLS behavioral test failed: ${failures.length} check(s)`);
  process.exit(1);
}
console.log('\n✓ RLS behavioral test passed');
