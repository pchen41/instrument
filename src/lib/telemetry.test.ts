import { describe, expect, it, vi } from 'vitest';
import {
  createTelemetry,
  readRumConfig,
  type RumClient,
  type RumConfig,
} from './telemetry';

const fullConfig: RumConfig = {
  applicationId: 'app-123',
  clientToken: 'pubABC',
  site: 'datadoghq.com',
  service: 'instrument-console',
  env: 'test',
};

function mockClient() {
  return {
    init: vi.fn(),
    startView: vi.fn(),
    addError: vi.fn(),
    addAction: vi.fn(),
  } satisfies RumClient;
}

describe('readRumConfig', () => {
  it('returns null when RUM config is absent', () => {
    expect(readRumConfig({})).toBeNull();
  });

  it('returns null when only one of the required values is present', () => {
    expect(readRumConfig({ VITE_DD_RUM_APPLICATION_ID: 'app-123' })).toBeNull();
    expect(readRumConfig({ VITE_DD_RUM_CLIENT_TOKEN: 'pubABC' })).toBeNull();
  });

  it('builds config with defaults when both required values are present', () => {
    const cfg = readRumConfig({
      VITE_DD_RUM_APPLICATION_ID: 'app-123',
      VITE_DD_RUM_CLIENT_TOKEN: 'pubABC',
    });
    expect(cfg).toEqual({
      applicationId: 'app-123',
      clientToken: 'pubABC',
      site: 'datadoghq.com',
      service: 'instrument-console',
      env: 'demo',
    });
  });
});

describe('createTelemetry — no config (no-op)', () => {
  it('is disabled, never loads the RUM SDK, and methods never throw', async () => {
    const loader = vi.fn();
    const t = createTelemetry(null, loader);

    expect(t.enabled).toBe(false);
    await t.init();
    t.recordRouteChange('/incidents');
    t.recordConsoleLoadFailure('incidents', new Error('boom'));
    t.recordUserActionFailure('sign_in', new Error('boom'));
    t.recordApiFailure('read', new Error('boom'));

    expect(loader).not.toHaveBeenCalled();
  });
});

describe('createTelemetry — with config', () => {
  it('initializes the RUM client with the browser-safe config', async () => {
    const client = mockClient();
    const loader = vi.fn(async () => client);
    const t = createTelemetry(fullConfig, loader);

    expect(t.enabled).toBe(true);
    await t.init();

    expect(loader).toHaveBeenCalledTimes(1);
    expect(client.init).toHaveBeenCalledTimes(1);
    expect(client.init).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: 'app-123',
        clientToken: 'pubABC',
        site: 'datadoghq.com',
        service: 'instrument-console',
        env: 'test',
      }),
    );
  });

  it('only initializes once', async () => {
    const client = mockClient();
    const loader = vi.fn(async () => client);
    const t = createTelemetry(fullConfig, loader);

    await t.init();
    await t.init();

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('forwards record* calls to the client after init', async () => {
    const client = mockClient();
    const t = createTelemetry(fullConfig, async () => client);
    await t.init();

    t.recordRouteChange('/recommendations');
    t.recordApiFailure('read_incidents', new Error('timeout'));

    expect(client.startView).toHaveBeenCalledWith({ name: '/recommendations' });
    expect(client.addError).toHaveBeenCalledTimes(1);
    const [err, ctx] = client.addError.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(ctx).toMatchObject({ source: 'api', operation: 'read_incidents' });
  });

  it('drops record* calls (without throwing) before init resolves', () => {
    const client = mockClient();
    const t = createTelemetry(fullConfig, async () => client);

    // No init() yet — calls must be safe and forward nothing.
    expect(() => t.recordRouteChange('/incidents')).not.toThrow();
    expect(client.startView).not.toHaveBeenCalled();
  });

  it('stays a no-op when the RUM loader fails', async () => {
    const loader = vi.fn(async () => {
      throw new Error('load failed');
    });
    const t = createTelemetry(fullConfig, loader);

    await expect(t.init()).resolves.toBeUndefined();
    expect(() => t.recordRouteChange('/incidents')).not.toThrow();
  });
});
