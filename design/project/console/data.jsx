/* Mock data for the Instrument console kit */

const SOURCES = [
  { id: 'datadog',     name: 'Datadog',     abbr: 'DD', color: '#632CA6', connected: true },
  { id: 'github',      name: 'GitHub',      abbr: 'GH', color: '#1B1F24', connected: true },
  { id: 'truefoundry', name: 'TrueFoundry', abbr: 'TF', color: '#5B3DF5', connected: false },
];

/* `inv0` seeds the investigation lifecycle for the demo so the Active list shows
   every state at once: 'new' (waiting on a human to press Investigate),
   'investigating' (running), 'complete' (finished). `fix0: 'generating'` seeds a
   complete incident whose fix has already been generated. Resolved incidents
   default to 'complete'. */
const INCIDENTS = [
  {
    id: 'INC-482',
    alert: 'firing', state: 'active', inv0: 'complete', fix0: 'generating',
    title: 'Checkout latency is elevated',
    service: 'payments-api',
    desc: 'p99 latency is up 318% and checkout requests are slowing down.',
    started: '24m ago',
    confWord: 'High',
    source: 'Datadog monitor',
    metrics: [
      { k: 'p99 latency', v: '812ms' },
      { k: 'error rate', v: '+318%' },
      { k: 'time to detect', v: '4m 12s' },
      { k: 'affected reqs', v: '~6.2k' },
    ],
    hypotheses: [
      { lead: true, t: 'Connection-pool size reduced in deploy a1c9f', d: 'PR #3120 lowered the pool from 50 to 10. Latency rose within 90s of rollout — the timing and the p99 shape match pool exhaustion.' },
      { lead: false, t: 'Downstream ledger-db slowdown', d: 'ledger-db p95 is up slightly, but it predates the latency spike. Lower confidence.' },
      { lead: false, t: 'Traffic surge', d: 'Request volume is flat vs. last week. Ruled out.' },
    ],
    timeline: [
      { kind: 'crit', time: '14:22:07', title: 'Datadog monitor fired', desc: 'p99 latency on payments-api crossed 500ms threshold.' },
      { kind: 'act', time: '14:22:31', title: 'Instrument began investigating', desc: 'Pulled traces, recent deploys, and error logs for payments-api.' },
      { kind: 'act', time: '14:23:48', title: 'Correlated with deploy a1c9f', desc: 'Found connection-pool change in PR #3120, merged 6 minutes before the spike.' },
      { kind: 'dot', time: '14:24:10', title: 'Root cause proposed', desc: 'High confidence. A fix can be generated for review.' },
    ],
    diff: [
      { t: 'ctx', s: '  // db/pool.ts' },
      { t: 'del', s: '- maxConnections: 50,' },
      { t: 'add', s: '+ maxConnections: 10,' },
      { t: 'ctx', s: '  idleTimeoutMs: 30000,' },
    ],
    fix: { title: 'Revert connection-pool size to 50', branch: 'instrument/fix-inc-482', files: ['db/pool.ts'] },
  },
  {
    id: 'INC-484',
    alert: 'firing', state: 'active', inv0: 'complete',
    title: 'Image uploads timing out',
    service: 'media-api',
    desc: 'Upload p95 doubled to 4.2s and a share of uploads now exceed the 5s gateway timeout.',
    started: '15m ago',
    confWord: 'Likely',
    source: 'Datadog monitor',
    metrics: [
      { k: 'upload p95', v: '4.2s' },
      { k: 'timeout rate', v: '3.8%' },
      { k: 'time to detect', v: '2m 38s' },
      { k: 'region', v: 'eu-west-1' },
    ],
    hypotheses: [
      { lead: true, t: 'Thumbnail worker pool starved', d: 'The resize worker queue is backing up and CPU is pinned. Timing lines up with a 3× upload-volume bump, but no code change is implicated yet.' },
      { lead: false, t: 'Object-store throttling', d: 'A few S3 503s appear in logs, but the rate is too low to explain the p95. Not ruled out.' },
    ],
    timeline: [
      { kind: 'crit', time: '14:11:02', title: 'Datadog monitor fired', desc: 'Upload p95 on media-api crossed 3s threshold.' },
      { kind: 'act', time: '14:11:30', title: 'Instrument began investigating', desc: 'Correlating worker-queue depth, CPU, and object-store responses.' },
      { kind: 'dot', time: '14:14:20', title: 'Leading hypothesis proposed', desc: 'Worker-pool starvation. Confidence is moderate — a fix can be generated for review.' },
    ],
    diff: null,
    fix: null,
  },
  {
    id: 'INC-481',
    alert: 'firing', state: 'active', inv0: 'investigating',
    title: 'Login requests failing intermittently',
    service: 'auth-service',
    desc: '5xx rate is up 6× over baseline in us-east-1 and logins are failing intermittently.',
    started: '11m ago',
    confWord: 'Likely',
    source: 'Datadog monitor',
    metrics: [
      { k: '5xx rate', v: '7.4%' },
      { k: 'failed logins', v: '~1.1k' },
      { k: 'time to detect', v: '1m 02s' },
      { k: 'region', v: 'us-east-1' },
    ],
    hypotheses: [
      { lead: true, t: 'Token-cache eviction under load', d: 'Redis evictions spiked at the same time as the 5xx. Strong correlation, but the cache-config change is unconfirmed.' },
      { lead: false, t: 'Upstream identity-provider timeout', d: 'IdP p95 is slightly elevated. Can\'t rule out yet.' },
    ],
    timeline: [
      { kind: 'crit', time: '14:15:30', title: 'Datadog monitor fired', desc: 'AuthError rate on auth-service crossed baseline by 6×.' },
      { kind: 'act', time: '14:15:52', title: 'Instrument began investigating', desc: 'Correlating Redis metrics, IdP latency, and recent config changes.' },
      { kind: 'act', time: '14:18:40', title: 'Narrowed to 2 hypotheses', desc: 'Token-cache eviction (leading) vs. IdP timeout. Gathering more signal.' },
    ],
    diff: null,
    fix: null,
  },
  {
    id: 'INC-485',
    alert: 'firing', state: 'active', inv0: 'new',
    title: 'Memory climbing on notifications-worker',
    service: 'notifications-worker',
    desc: 'RSS memory is up 40% over 2 hours with flat traffic — a slow leak may be building toward an OOM.',
    started: '3m ago',
    confWord: 'High',
    source: 'Datadog monitor',
    metrics: [
      { k: 'RSS memory', v: '1.7 GB' },
      { k: 'growth', v: '+40% / 2h' },
      { k: 'time to detect', v: '0m 48s' },
      { k: 'restarts', v: '0' },
    ],
    hypotheses: [
      { lead: true, t: 'Unbounded retry buffer in notifications-worker', d: 'A retry queue with no eviction is the prime suspect given the linear growth shape — Instrument will confirm once you start the investigation.' },
    ],
    timeline: [
      { kind: 'crit', time: '14:31:14', title: 'Datadog monitor fired', desc: 'RSS memory on notifications-worker crossed 1.5 GB.' },
    ],
    diff: null,
    fix: null,
  },
  {
    id: 'INC-479',
    alert: 'resolved', state: 'resolved',
    title: 'Elevated 5xx on search results',
    service: 'search-api',
    desc: 'Resolved. A bad cache key shipped in deploy 9f2b; rolled back. Open 18m.',
    started: '2h ago',
    confWord: 'High',
    source: 'Datadog monitor',
    metrics: [
      { k: 'duration', v: '18m' },
      { k: 'peak 5xx', v: '4.1%' },
      { k: 'resolution', v: 'rollback' },
      { k: 'deploy', v: '9f2b' },
    ],
    hypotheses: [
      { lead: true, t: 'Malformed cache key in deploy 9f2b', d: 'Confirmed — the key template dropped the locale segment, causing collisions. Rollback resolved it.' },
    ],
    timeline: [
      { kind: 'crit', time: '12:02:10', title: 'Datadog monitor fired', desc: '5xx on search-api crossed 3%.' },
      { kind: 'act', time: '12:02:40', title: 'Root cause found', desc: 'Cache-key template regression in deploy 9f2b.' },
      { kind: 'dot', time: '12:20:55', title: 'Resolved by rollback', desc: 'The rollback PR was merged. Error rate returned to baseline.' },
    ],
    diff: null,
    fix: null,
  },
  {
    id: 'INC-478',
    alert: 'resolved', state: 'resolved',
    title: 'Webhook deliveries delayed',
    service: 'events-gateway',
    desc: 'Resolved. A misconfigured rate limit throttled outbound webhooks; limit raised. Open 41m.',
    started: '5h ago',
    confWord: 'High',
    source: 'Datadog monitor',
    metrics: [
      { k: 'duration', v: '41m' },
      { k: 'peak delay', v: '6m 20s' },
      { k: 'resolution', v: 'config change' },
      { k: 'backlog', v: '~24k' },
    ],
    hypotheses: [
      { lead: true, t: 'Outbound rate limit set too low in config 7c1d', d: 'Confirmed — the per-tenant cap was 50/s instead of 500/s. Raising it drained the backlog.' },
    ],
    timeline: [
      { kind: 'crit', time: '09:48:02', title: 'Datadog monitor fired', desc: 'Webhook delivery lag on events-gateway crossed 60s.' },
      { kind: 'act', time: '09:48:33', title: 'Root cause found', desc: 'Rate-limit config regression in change 7c1d.' },
      { kind: 'dot', time: '10:29:10', title: 'Resolved by config change', desc: 'The corrected rate-limit config was merged. Backlog cleared.' },
    ],
    diff: null,
    fix: null,
  },
];

/* A recommendation is one or more steps. Some are single actions. Combos are an
   ordered, DEPENDENT sequence: a later step can't run until an earlier one is
   merged by a human — you can't alert on a metric that isn't collected yet. So
   each step carries its OWN action; a dependent step stays locked (with what it
   waits on) until its prerequisite merges. There is no single "do it all" button,
   because each PR needs human review and merge before the next can begin. */
const RECOMMENDATIONS = [
  { id: 'r1', icon: 'bell', kind: 'Alert', title: 'payments-api queue depth is flying blind',
    desc: 'payments-api enqueues onto a work queue with no depth metric and nothing watching it, so a backlog would build with no signal. The alert can only exist once the metric does, so this is two reviewed changes, in order.',
    steps: [
      { icon: 'tree', label: 'Add a queue-depth metric to payments-api', cta: 'Open metric PR', tone: 'pr',
        pr: { number: 3128, branch: 'instrument/payments-api-queue-depth-metric',
          desc: 'Adds a queue-depth gauge to payments-api and records it on each enqueue and dequeue, so the backlog is observable before it builds up.',
          diff: [
            { t: 'ctx', s: '  // payments-api/queue.ts' },
            { t: 'add', s: "+ import { Gauge } from '@otel/metrics';" },
            { t: 'add', s: "+ const queueDepth = new Gauge('payments_queue_depth');" },
            { t: 'add', s: '+ queueDepth.record(queue.size());' },
            { t: 'ctx', s: '  return queue.enqueue(job);' },
          ] } },
      { icon: 'bell', label: 'Alert when depth > 1,000 sustained for 2 min', cta: 'Create alert', tone: 'open', waitsFor: 'the metric PR is merged' },
    ] },
  { id: 'r2', icon: 'tree', kind: 'Instrumentation', title: 'Add a trace span around the checkout call',
    desc: 'The checkout path has a 600ms gap with no spans. A PR can add an OpenTelemetry span so future RCAs are faster.',
    steps: [
      { icon: 'tree', label: 'Add an OpenTelemetry span around the checkout call', cta: 'Open instrumentation PR', tone: 'pr',
        pr: { number: 3129, branch: 'instrument/checkout-trace-span',
          desc: 'Wraps the checkout charge call in an OpenTelemetry span so the 600ms gap shows up in traces and future investigations are faster.',
          diff: [
            { t: 'ctx', s: '  // checkout/service.ts' },
            { t: 'add', s: "+ const span = tracer.startSpan('checkout.charge');" },
            { t: 'ctx', s: '  await chargeCustomer(order);' },
            { t: 'add', s: '+ span.end();' },
          ] } },
    ] },
  { id: 'r3', icon: 'gauge', kind: 'Alert', title: 'p99 threshold on search-api is too sensitive',
    desc: 'It fired 9 times last week with no user impact. Raising it from 300ms to 450ms would cut alert fatigue.',
    steps: [
      { icon: 'gauge', label: 'Raise the p99 alert threshold from 300ms to 450ms', cta: 'Review change', tone: 'change',
        change: { platform: 'Datadog', monitor: 'search-api · p99 latency',
          desc: 'Updates the p99 latency monitor in Datadog so transient sub-450ms blips stop paging, while real regressions still fire.',
          rows: [
            { k: 'Monitor', v: 'search-api · p99 latency' },
            { k: 'Threshold', from: '300ms', to: '450ms' },
            { k: 'Sustained for', v: '5 min' },
            { k: 'Notifies', v: '#search-oncall' },
          ] } },
    ] },
  { id: 'r4', icon: 'logs', kind: 'Instrumentation', title: 'auth-service can\'t explain its own login failures',
    desc: 'auth-service logs login failures as unstructured strings with no machine-readable reason, so failures can\'t be grouped by cause. The dashboard panel reads from those logs, so the logs ship first.',
    steps: [
      { icon: 'logs', label: 'Add structured login-error logs to auth-service', cta: 'Open instrumentation PR', tone: 'pr',
        pr: { number: 3130, branch: 'instrument/auth-structured-login-logs',
          desc: 'Adds structured login-failure logs to auth-service with a machine-readable reason, so failures can be grouped by cause during an investigation.',
          diff: [
            { t: 'ctx', s: '  // auth-service/login.ts' },
            { t: 'add', s: "+ logger.warn('login_failed', {" },
            { t: 'add', s: '+   reason: err.code, userId, region,' },
            { t: 'add', s: '+ });' },
          ] } },
      { icon: 'chart', label: 'Add a failure-by-reason panel to the auth dashboard', cta: 'Add panel', tone: 'open', waitsFor: 'the logs PR is merged' },
    ] },

  /* Seeded archive examples — one per archived state. Accepted = the change was
     merged or applied. Outdated = the code moved on, so the suggestion no longer
     applies (not restorable). Dismissed = a human waved it off (restorable). */
  { id: 'r5', icon: 'tree', kind: 'Instrumentation', archived: 'accepted',
    title: 'events-gateway had no retry-budget metric',
    desc: 'Outbound webhook retries had no metric, so a rising retry rate stayed invisible. A gauge now tracks the retry budget so throttling is caught before the backlog builds.' },
  { id: 'r6', icon: 'tree', kind: 'Instrumentation', archived: 'outdated',
    title: 'Add a trace span to the legacy image-resize path',
    desc: 'Suggested before media-api moved resizing to the new worker. That code path was removed in deploy c4e1, so the change no longer applies.' },
  { id: 'r7', icon: 'gauge', kind: 'Instrumentation', archived: 'dismissed',
    title: 'Lower log verbosity on debug-logger in production',
    desc: 'Flagged as noisy, but the team is keeping debug logs on intentionally through the current migration.' },
];

Object.assign(window, { SOURCES, INCIDENTS, RECOMMENDATIONS });
