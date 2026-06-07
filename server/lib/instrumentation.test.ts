import { describe, expect, it } from 'vitest';
import { createInstrumentation, createMemorySink, redactAttributes } from './instrumentation';

const CONFIG = { service: 'instrument', environment: 'production' };
let clock = 0;
const now = () => clock;

describe('createInstrumentation — disabled / no sink', () => {
  it('is a callable no-op with no sink (local/test default never breaks)', () => {
    const ins = createInstrumentation(CONFIG); // no sink
    expect(() => {
      ins.log('info', 'server.request', { route: '/jobs' });
      ins.metric('instrument.read.latency', 12);
      const end = ins.span('worker.tick');
      end({ claimed: 2 });
    }).not.toThrow();
  });

  it('emits nothing when explicitly disabled even with a sink', () => {
    const sink = createMemorySink();
    const ins = createInstrumentation({ ...CONFIG, enabled: false }, sink);
    ins.log('info', 'x');
    expect(sink.entries).toEqual([]);
  });
});

describe('createInstrumentation — enabled', () => {
  it('emits logs/metrics/spans with stable bound attributes', () => {
    clock = 1000;
    const sink = createMemorySink();
    const ins = createInstrumentation(CONFIG, sink, now);

    ins.log('info', 'server.request', { route: '/incidents' });
    ins.metric('instrument.read.latency_ms', 42, { route: '/incidents' });
    clock = 1000;
    const end = ins.span('worker.tick');
    clock = 1075;
    end({ claimed: 3 });

    expect(sink.entries).toHaveLength(3);
    const [log, metric, span] = sink.entries;
    expect(log).toMatchObject({ kind: 'log', name: 'server.request', level: 'info', attributes: { service: 'instrument', env: 'production', route: '/incidents' } });
    expect(metric).toMatchObject({ kind: 'metric', name: 'instrument.read.latency_ms', value: 42 });
    expect(span).toMatchObject({ kind: 'span', name: 'worker.tick', durationMs: 75, attributes: { claimed: 3 } });
  });

  it('child() binds stable attributes for representative paths (server/worker/provider/model)', () => {
    const sink = createMemorySink();
    const ins = createInstrumentation(CONFIG, sink, now);

    ins.child({ path: 'server', route: '/jobs' }).log('info', 'request.start');
    ins.child({ path: 'worker', workflow: 'incident_investigation', job_type: 'incident_investigation' }).metric('instrument.worker.claimed', 1);
    ins.child({ path: 'provider', integration: 'github' }).log('warn', 'provider.retry');
    ins.child({ path: 'model', integration: 'truefoundry' }).span('model.call')();

    expect(sink.entries.map((e) => [e.attributes.path, e.name])).toEqual([
      ['server', 'request.start'],
      ['worker', 'instrument.worker.claimed'],
      ['provider', 'provider.retry'],
      ['model', 'model.call'],
    ]);
    expect(sink.entries[1].attributes).toMatchObject({ workflow: 'incident_investigation', job_type: 'incident_investigation' });
    expect(sink.entries[1].attributes.integration).toBeUndefined();
    expect(sink.entries[2].attributes).toMatchObject({ integration: 'github', service: 'instrument' });
  });

  it('redacts secret-named and secret-shaped attribute values', () => {
    const sink = createMemorySink();
    const ins = createInstrumentation(CONFIG, sink, now);
    ins.log('error', 'provider.error', {
      authorization: 'Bearer abc123def456ghi789',
      message: 'failed: token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      status: 500,
    });
    const attrs = sink.entries[0].attributes;
    expect(attrs.authorization).toBe('‹redacted›');
    expect(String(attrs.message)).not.toMatch(/ghp_/);
    expect(String(attrs.message)).toContain('‹redacted›');
    expect(attrs.status).toBe(500); // numbers pass through
  });
});

describe('redactAttributes', () => {
  it('drops nulls, keeps primitives, recurses into nested objects', () => {
    const out = redactAttributes({ a: null, n: 7, b: true, nested: { x: 'ok', secret: 'eyJaa.bbcc.ddee' } });
    expect(out).not.toHaveProperty('a');
    expect(out.n).toBe(7);
    expect(out.b).toBe(true);
    expect(typeof out.nested).toBe('object');
    expect((out.nested as Record<string, unknown>).x).toBe('ok');
    expect((out.nested as Record<string, unknown>).secret).toBe('‹redacted›'); // secret-named, nested
  });

  it('masks secret-NAMED keys regardless of value type or depth (the review holes)', () => {
    const out = redactAttributes({
      authorization: 1234567890, // numeric secret-named value (was bypassed)
      api_key: true, // boolean secret-named value (was bypassed)
      config: { datadog_api_key: '0123456789abcdef0123456789abcdef' }, // nested unstructured 32-hex (was bypassed)
    });
    expect(out.authorization).toBe('‹redacted›');
    expect(out.api_key).toBe('‹redacted›');
    expect((out.config as Record<string, unknown>).datadog_api_key).toBe('‹redacted›');
  });

  it('scrubs secret-shaped values inside nested arrays/objects', () => {
    const out = redactAttributes({ items: [{ note: 'ok' }, { note: 'tok ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' }] });
    const items = out.items as Record<string, unknown>[];
    expect(items[0].note).toBe('ok');
    expect(String(items[1].note)).toContain('‹redacted›');
  });
});
