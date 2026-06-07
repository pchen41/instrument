import { describe, expect, it } from 'vitest';
import {
  type DatadogAlert,
  alertTransitionKey,
  buildAlertPayloadSummary,
  buildSignals,
  buildTimelineEntry,
  decideInvestigationStart,
  externalDeliveryId,
  incidentCorrelationKey,
  mapAlertState,
  parseDatadogAlert,
  parseTags,
  smartShouldStart,
  toIso,
  verifyWebhookSecret,
} from './datadog-webhook';

// The ERD minimum JSON contract (docs/ERD.md "Datadog" section), as Datadog renders it.
const contract = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  alert_id: '20351331',
  alert_cycle_key: 'cycle-abc',
  alert_transition: 'Triggered',
  event_id: 'evt-1',
  event_url: 'https://us5.datadoghq.com/event/jump_to?event_id=evt-1',
  event_title: 'instrument-worker retry rate is elevated',
  event_msg: 'retries climbing on the worker',
  event_type: 'metric_alert',
  date: 1780000000000,
  last_updated: 1780000005000,
  tags: 'service:instrument-worker, env:production, trace_id:abc123, request_id:req-9',
  service: 'instrument-worker',
  env: 'production',
  instrument_reliability: '',
  trace_id: 'abc123',
  request_id: 'req-9',
  ...over,
});

const NOW = '2026-06-07T00:00:00.000Z';
const alertOf = (over: Record<string, unknown> = {}): DatadogAlert => parseDatadogAlert(contract(over), NOW);

describe('verifyWebhookSecret', () => {
  it('accepts the exact configured secret and rejects anything else', () => {
    expect(verifyWebhookSecret('s3cret', 's3cret')).toBe(true);
    expect(verifyWebhookSecret('s3cret', 'nope')).toBe(false);
  });
  it('fails closed on a missing secret or missing header', () => {
    expect(verifyWebhookSecret(null, 's3cret')).toBe(false);
    expect(verifyWebhookSecret('s3cret', null)).toBe(false);
    expect(verifyWebhookSecret('', '')).toBe(false);
  });
});

describe('parseTags', () => {
  it('parses comma/space separated key:value tags; bare tags → true', () => {
    expect(parseTags('service:web, env:prod team:sre')).toEqual({ service: 'web', env: 'prod', team: 'sre' });
    expect(parseTags('reliability')).toEqual({ reliability: 'true' });
  });
});

describe('toIso', () => {
  it('coerces epoch ms, epoch s, and ISO to ISO', () => {
    expect(toIso(1780000000000, NOW)).toBe(new Date(1780000000000).toISOString());
    expect(toIso('1780000000', NOW)).toBe(new Date(1780000000000).toISOString());
    expect(toIso('2026-01-02T03:04:05Z', NOW)).toBe('2026-01-02T03:04:05.000Z');
    expect(toIso('garbage', NOW)).toBe(NOW);
  });
});

describe('parseDatadogAlert (ERD minimum contract)', () => {
  it('maps every contract field, preferring explicit fields then tag fallback', () => {
    const a = alertOf();
    expect(a).toMatchObject({ alertId: '20351331', alertCycleKey: 'cycle-abc', transition: 'Triggered', service: 'instrument-worker', environment: 'production', traceId: 'abc123', requestId: 'req-9' });
    expect(a.title).toBe('instrument-worker retry rate is elevated');
  });
  it('falls back to the tags map when explicit fields are absent', () => {
    const a = parseDatadogAlert(contract({ service: undefined, trace_id: undefined, tags: 'service:billing, trace_id:t-77' }), NOW);
    expect(a.service).toBe('billing');
    expect(a.traceId).toBe('t-77');
  });
  it('treats an UNRENDERED template variable as absent', () => {
    const a = parseDatadogAlert(contract({ trace_id: '$TAGS[trace_id]', service: '$TAGS[service]', tags: '' }), NOW);
    expect(a.traceId).toBeNull();
    expect(a.service).toBeNull();
  });
});

describe('mapAlertState', () => {
  it('Recovered → resolved (case-insensitive); everything else → firing', () => {
    expect(mapAlertState('Recovered')).toBe('resolved');
    expect(mapAlertState('recovered')).toBe('resolved');
    expect(mapAlertState('Triggered')).toBe('firing');
    expect(mapAlertState('Warn')).toBe('firing');
    expect(mapAlertState('No Data')).toBe('firing');
    expect(mapAlertState(null)).toBe('firing');
  });
});

describe('synthesized keys', () => {
  it('uses the alert_cycle_key for correlation, else monitor+scope', () => {
    expect(incidentCorrelationKey(alertOf())).toBe('dd:cycle-abc');
    expect(incidentCorrelationKey(alertOf({ alert_cycle_key: undefined }))).toBe('dd:20351331:instrument-worker:production');
  });
  it('a replay (same transition+time) yields identical delivery + transition keys; a new transition differs', () => {
    const triggered = alertOf();
    const replay = alertOf();
    expect(externalDeliveryId(triggered)).toBe(externalDeliveryId(replay));
    expect(alertTransitionKey(triggered)).toBe(alertTransitionKey(replay));
    const recovered = alertOf({ alert_transition: 'Recovered', last_updated: 1780000099000 });
    expect(externalDeliveryId(recovered)).not.toBe(externalDeliveryId(triggered));
  });
  it('keys are STABLE across replays even when the payload omits timestamps (sentinel, not server-now)', () => {
    // Two parses at DIFFERENT server clocks but the same (timestamp-less) payload.
    const a = parseDatadogAlert(contract({ date: undefined, last_updated: undefined }), '2026-06-07T00:00:00.000Z');
    const b = parseDatadogAlert(contract({ date: undefined, last_updated: undefined }), '2026-06-07T09:09:09.000Z');
    expect(a.keyStamp).toBe('');
    expect(externalDeliveryId(a)).toBe(externalDeliveryId(b));
  });
});

describe('smartShouldStart', () => {
  it('starts on a truthy instrument_reliability tag (default rule)', () => {
    expect(smartShouldStart(alertOf({ instrument_reliability: 'true' }))).toBe(true);
    expect(smartShouldStart(alertOf({ instrument_reliability: '', tags: 'instrument_reliability:1' }))).toBe(true);
    expect(smartShouldStart(alertOf())).toBe(false); // reliability empty, no rule match
  });
  it('starts on a configured monitor id or title keyword', () => {
    expect(smartShouldStart(alertOf(), { monitor_ids: ['20351331'] })).toBe(true);
    expect(smartShouldStart(alertOf(), { title_keywords: ['retry rate'] })).toBe(true);
    expect(smartShouldStart(alertOf(), { monitor_ids: ['999'], title_keywords: ['database'] })).toBe(false);
  });
  it('never throws on a malformed smart_start_rules (would otherwise block all incident creation)', () => {
    // monitor_ids/title_keywords as non-arrays, numeric ids — must not throw.
    const bad = { monitor_ids: '20351331', title_keywords: 42, reliability_tag: 7 } as unknown as Parameters<typeof smartShouldStart>[1];
    expect(() => smartShouldStart(alertOf(), bad)).not.toThrow();
    expect(smartShouldStart(alertOf({ alert_id: 555 }), { monitor_ids: [555] as unknown as string[] })).toBe(true);
  });
  it('honours a custom reliability_tag even when instrument_reliability is present-but-false', () => {
    const a = alertOf({ instrument_reliability: 'false', tags: 'service:web, sev1:true' });
    expect(smartShouldStart(a, { reliability_tag: 'sev1' })).toBe(true);
  });
});

describe('decideInvestigationStart', () => {
  const reliability = alertOf({ instrument_reliability: 'true' });
  const ambiguous = alertOf();
  it('manual never auto-starts', () => {
    expect(decideInvestigationStart('manual', 'firing', reliability)).toMatchObject({ start: false, automatic: false });
  });
  it('auto starts every firing alert', () => {
    expect(decideInvestigationStart('auto', 'firing', ambiguous)).toMatchObject({ start: true, automatic: true });
  });
  it('smart starts a reliability alert, leaves an ambiguous one waiting', () => {
    expect(decideInvestigationStart('smart', 'firing', reliability)).toMatchObject({ start: true, automatic: true });
    expect(decideInvestigationStart('smart', 'firing', ambiguous)).toMatchObject({ start: false });
  });
  it('never starts on a resolved alert, whatever the mode', () => {
    expect(decideInvestigationStart('auto', 'resolved', reliability)).toMatchObject({ start: false });
  });
});

describe('snapshots preserve trace/request ids for investigation', () => {
  it('alert_payload_summary carries trace_id + request_id', () => {
    const s = buildAlertPayloadSummary(alertOf());
    expect(s).toMatchObject({ monitor_id: '20351331', trace_id: 'abc123', request_id: 'req-9', service: 'instrument-worker' });
  });
  it('signals surface trace + request ids as first-class signals', () => {
    const sig = buildSignals(alertOf());
    expect(sig.map((s) => s.key)).toEqual(expect.arrayContaining(['trace_id', 'request_id', 'service', 'monitor']));
  });
  it('timeline entry reflects firing vs recovery', () => {
    expect(buildTimelineEntry(alertOf(), 'firing', NOW).kind).toBe('alert');
    expect(buildTimelineEntry(alertOf(), 'resolved', NOW).kind).toBe('recovery');
  });
});
