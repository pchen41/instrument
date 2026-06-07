// Live read-helper + RLS test for the Task 3 workflow seed, using a real member
// JWT through @insforge/sdk (db query cannot switch roles). Mirrors the query
// shapes in src/data/reads.ts. Reads URL + anon key from .env.local; the demo
// password is NOT committed -- pass it at run time:
//   INSTRUMENT_DEMO_PASSWORD=... npm run verify:reads
import { readFileSync } from 'node:fs';
import { createClient } from '@insforge/sdk';

const envLocal = (() => {
  try {
    return readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    return '';
  }
})();
const fromEnv = (k) =>
  process.env[k] || envLocal.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();

const baseUrl = fromEnv('VITE_INSFORGE_URL');
const anonKey = fromEnv('VITE_INSFORGE_ANON_KEY');
const email = process.env.INSTRUMENT_DEMO_EMAIL || 'test@test.com';
const password = process.env.INSTRUMENT_DEMO_PASSWORD;

if (!baseUrl || !anonKey) {
  console.error('Missing VITE_INSFORGE_URL / VITE_INSFORGE_ANON_KEY (.env.local).');
  process.exit(2);
}
if (!password) {
  console.error('Skipping read test: set INSTRUMENT_DEMO_PASSWORD (see docs/CONFIG.md).');
  process.exit(0);
}

const failures = [];
const check = (name, ok) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failures.push(name);
};
const db = (c) => c.database;

const member = createClient({ baseUrl, anonKey });
const signIn = await member.auth.signInWithPassword({ email, password });
if (signIn.error) {
  console.error('Sign-in failed:', signIn.error.message ?? signIn.error);
  process.exit(1);
}

// active incidents -> all four display states present
const activeInc = await db(member)
  .from('incidents')
  .select('id, title, investigation_job_id')
  .eq('incident_state', 'active')
  .order('started_at', { ascending: false });
check('active incidents >= 5', (activeInc.data?.length ?? 0) >= 5);
check('reliability incident present', !!activeInc.data?.some((i) => i.title.includes('TrueFoundry rate limits')));

const states = new Set();
for (const inc of activeInc.data ?? []) {
  if (!inc.investigation_job_id) {
    states.add('new');
    continue;
  }
  const job = await db(member).from('jobs').select('state').eq('id', inc.investigation_job_id).maybeSingle();
  const s = job.data?.state;
  states.add(s === 'succeeded' ? 'complete' : s === 'failed' ? 'failed' : 'investigating');
}
check('active incidents cover new/investigating/complete/failed',
  ['new', 'investigating', 'complete', 'failed'].every((s) => states.has(s)));

const resolvedInc = await db(member)
  .from('incidents').select('id').eq('incident_state', 'resolved').order('resolved_at', { ascending: false });
check('resolved incidents >= 2', (resolvedInc.data?.length ?? 0) >= 2);

// incident detail: investigation job + evidence
const reliability = activeInc.data.find((i) => i.title.includes('TrueFoundry rate limits'));
const relJob = await db(member).from('jobs').select('state, attempts').eq('id', reliability.investigation_job_id).maybeSingle();
check('reliability investigation job succeeded', relJob.data?.state === 'succeeded');
check('reliability job recorded 3 retry attempts', (relJob.data?.attempts?.length ?? 0) === 3);
const relEvidence = await db(member)
  .from('evidence_items').select('id').eq('subject_type', 'incident').eq('subject_id', reliability.id);
check('reliability incident has >= 2 evidence items', (relEvidence.data?.length ?? 0) >= 2);

// active recommendations across categories
const activeRecs = await db(member)
  .from('recommendations').select('id, title, category, steps').eq('state', 'active');
const cats = new Set((activeRecs.data ?? []).map((r) => r.category));
check('active recs cover instrumentation/alert/pr_review',
  ['instrumentation', 'alert', 'pr_review'].every((c) => cats.has(c)));

// archived recommendations cover all three states
const archived = await db(member)
  .from('recommendations').select('state').in('state', ['accepted', 'dismissed', 'outdated']);
const arch = new Set((archived.data ?? []).map((r) => r.state));
check('archived recs cover accepted/dismissed/outdated',
  ['accepted', 'dismissed', 'outdated'].every((s) => arch.has(s)));

// multi-step rec with a locked dependent step + generated PR
const multi = (activeRecs.data ?? []).find((r) => r.title.includes('no alert on its retry rate'));
const mSteps = multi?.steps ?? [];
check('multi-step rec has 2 steps', mSteps.length === 2);
check('multi-step rec has a locked dependent step', mSteps.some((s) => s.state === 'locked' && s.prerequisite_step_key));
check('multi-step rec step carries generated PR #12', mSteps.some((s) => s.generated_pr?.number === 12));

// generated draft monitor in a step
const monitorRec = (activeRecs.data ?? []).find((r) => r.title.includes('instrument-mcp'));
check('a rec step carries a generated draft monitor',
  (monitorRec?.steps ?? []).some((s) => s.generated_monitor?.draft === true));

// PR review record: PR metadata + posted comments
const prRec = (activeRecs.data ?? []).find((r) => r.category === 'pr_review');
const comments = await db(member)
  .from('pr_review_comments')
  .select('status, pull_request_id, line_number')
  .eq('recommendation_id', prRec.id)
  .order('line_number', { ascending: true });
check('PR review record has 3 posted comments',
  (comments.data?.length ?? 0) === 3 && comments.data.every((c) => c.status === 'posted'));
const pr = await db(member)
  .from('github_pull_requests').select('external_pr_number').eq('id', comments.data?.[0]?.pull_request_id).maybeSingle();
check('PR review record links PR #14', pr.data?.external_pr_number === 14);

// RLS: an anonymous (non-member) client sees no workflow rows across the
// directly-readable child tables (a permission error would also yield 0 rows;
// the member reads above prove the rows do exist and are reachable with a JWT).
const anon = createClient({ baseUrl, anonKey });
for (const table of [
  'incidents',
  'recommendations',
  'jobs',
  'pr_review_comments',
  'evidence_items',
  'external_write_actions',
  'ai_model_calls',
]) {
  const res = await anon.database.from(table).select('id');
  check(`anon/non-member reads NO ${table}`, (res.data?.length ?? 0) === 0);
}

await member.auth.signOut();

if (failures.length) {
  console.error(`\n✗ Read/RLS test failed: ${failures.length} check(s)`);
  process.exit(1);
}
console.log('\n✓ Read helpers + RLS test passed');
