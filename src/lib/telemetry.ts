/**
 * Frontend telemetry wrapper (Datadog RUM / error tracking).
 *
 * Task 1 owns the optional frontend RUM wrapper and the browser-safe config
 * shape. It initializes Datadog RUM only when browser-safe RUM config is
 * present, and is a no-op otherwise — so the app runs cleanly with RUM absent
 * (the default for the demo). Later views call the small `record*` helpers to
 * report route changes, console load failures, failed user actions, and API/
 * read failures; those calls are safe no-ops until RUM is configured.
 *
 * SECURITY: only browser-safe RUM client values are read here
 * (applicationId + clientToken). Never reference a Datadog API key or
 * application key in frontend code.
 */

export interface RumConfig {
  applicationId: string;
  clientToken: string;
  site: string;
  service: string;
  env: string;
}

/** Minimal surface of the Datadog RUM client this wrapper depends on. */
export interface RumClient {
  init(config: Record<string, unknown>): void;
  startView(options: { name?: string } | string): void;
  addError(error: unknown, context?: Record<string, unknown>): void;
  addAction(name: string, context?: Record<string, unknown>): void;
}

/** Loader that resolves the RUM client. Injectable for tests. */
export type RumLoader = () => Promise<RumClient> | RumClient;

export interface Telemetry {
  /** True only when browser-safe RUM config was present. */
  readonly enabled: boolean;
  /** Initialize the RUM client. No-op (and never throws) when disabled. */
  init(): Promise<void>;
  /** Record a client-side route change. */
  recordRouteChange(path: string): void;
  /** Record a failure to load a console view / its data. */
  recordConsoleLoadFailure(view: string, error: unknown): void;
  /** Record a user action that failed (e.g. sign-in, mutation). */
  recordUserActionFailure(action: string, error: unknown): void;
  /** Record an API / read failure surfaced to the user. */
  recordApiFailure(operation: string, error: unknown): void;
}

type EnvLike = Record<string, string | undefined>;

/**
 * Read browser-safe RUM config from an env-like object. Returns null unless the
 * two required client values are both present, which is what keeps the wrapper
 * a no-op by default.
 */
export function readRumConfig(env: EnvLike): RumConfig | null {
  const applicationId = env.VITE_DD_RUM_APPLICATION_ID?.trim();
  const clientToken = env.VITE_DD_RUM_CLIENT_TOKEN?.trim();
  if (!applicationId || !clientToken) return null;
  return {
    applicationId,
    clientToken,
    site: env.VITE_DD_RUM_SITE?.trim() || 'datadoghq.com',
    service: env.VITE_DD_RUM_SERVICE?.trim() || 'instrument-console',
    env: env.VITE_DD_RUM_ENV?.trim() || 'demo',
  };
}

/** Default loader: lazily import the real Datadog RUM browser SDK. */
const defaultLoader: RumLoader = async () => {
  const mod = await import('@datadog/browser-rum');
  return mod.datadogRum as unknown as RumClient;
};

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Build a telemetry instance. With a null config every method is a safe no-op
 * and the RUM SDK is never loaded. With a config, `init()` loads the client and
 * the `record*` helpers forward to it.
 */
export function createTelemetry(
  config: RumConfig | null,
  loader: RumLoader = defaultLoader,
): Telemetry {
  if (!config) {
    return {
      enabled: false,
      init: async () => {},
      recordRouteChange: () => {},
      recordConsoleLoadFailure: () => {},
      recordUserActionFailure: () => {},
      recordApiFailure: () => {},
    };
  }

  let client: RumClient | null = null;
  let initStarted = false;

  // Forward to RUM only once the client has loaded. Calls before init resolves
  // are dropped rather than queued — telemetry must never block or throw.
  const withClient = (fn: (c: RumClient) => void) => {
    if (client) {
      try {
        fn(client);
      } catch {
        /* never let telemetry break the app */
      }
    }
  };

  return {
    enabled: true,
    async init() {
      if (initStarted) return;
      initStarted = true;
      try {
        const loaded = await loader();
        loaded.init({
          applicationId: config.applicationId,
          clientToken: config.clientToken,
          site: config.site,
          service: config.service,
          env: config.env,
          sessionSampleRate: 100,
          sessionReplaySampleRate: 0,
          trackUserInteractions: true,
          trackResources: true,
          trackLongTasks: true,
          defaultPrivacyLevel: 'mask-user-input',
        });
        client = loaded;
      } catch {
        // If RUM fails to load/init, stay a no-op rather than crashing the app.
        client = null;
      }
    },
    recordRouteChange(path) {
      withClient((c) => c.startView({ name: path }));
    },
    recordConsoleLoadFailure(view, error) {
      withClient((c) =>
        c.addError(toError(error), { source: 'console_load', view }),
      );
    },
    recordUserActionFailure(action, error) {
      withClient((c) =>
        c.addError(toError(error), { source: 'user_action', action }),
      );
    },
    recordApiFailure(operation, error) {
      withClient((c) =>
        c.addError(toError(error), { source: 'api', operation }),
      );
    },
  };
}

// App-wide singleton, configured from browser-safe env. Absent config → no-op.
export const telemetry: Telemetry = createTelemetry(
  readRumConfig(import.meta.env as unknown as EnvLike),
);
