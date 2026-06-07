import { Icon } from '../../components/Icon';
import { ErrorState, LoadingState } from '../../components/console/feedback';
import { useIntegrations } from '../../data/hooks';
import type { IntegrationHealth, IntegrationProvider, IntegrationStatus } from '../../data/reads';

/**
 * Integrations section. Server-backed health for the workspace's preconfigured
 * providers. The first slice ships no self-serve connect / OAuth flow (PRD
 * SEC-3, "Out of scope"); each card shows the durable status with a clear visual
 * treatment for connected / degraded / disconnected / rate-limited /
 * missing-credentials, plus the last error when the source is unhealthy.
 */

const PROVIDER_VISUAL: Record<IntegrationProvider, { abbr: string; color: string }> = {
  datadog: { abbr: 'DD', color: '#632CA6' },
  github: { abbr: 'GH', color: '#1B1F24' },
  truefoundry: { abbr: 'TF', color: '#5B3DF5' },
};

const STATUS_VISUAL: Record<IntegrationStatus, { tone: 'ok' | 'warn' | 'crit' | 'idle'; label: string; desc: string }> = {
  connected: { tone: 'ok', label: 'Connected', desc: 'Reading alerts & signals' },
  degraded: { tone: 'warn', label: 'Degraded', desc: 'Connected, but responses are slow or partial' },
  rate_limited: { tone: 'warn', label: 'Rate limited', desc: 'Throttled by the provider — Instrument is backing off' },
  missing_credentials: { tone: 'crit', label: 'Missing credentials', desc: 'Credentials need to be refreshed' },
  disconnected: { tone: 'idle', label: 'Disconnected', desc: 'Not connected' },
};

export function Integrations() {
  const view = useIntegrations();
  const integrations = view.data ?? [];

  return (
    <div className="content narrow">
      <div className="page-head">
        <div>
          <h1>Integrations</h1>
          <div className="sub">The platforms Instrument works across. Preconfigured for this workspace.</div>
        </div>
      </div>

      {view.loading ? (
        <LoadingState label="Loading integrations…" />
      ) : view.error ? (
        <ErrorState message="Integration health could not be loaded." onRetry={view.refetch} />
      ) : (
        <div className="intg-grid">
          {integrations.map((integration) => (
            <IntegrationCard key={integration.id} integration={integration} />
          ))}
        </div>
      )}
    </div>
  );
}

function IntegrationCard({ integration }: { integration: IntegrationHealth }) {
  const visual = PROVIDER_VISUAL[integration.provider] ?? { abbr: '?', color: 'var(--ink-3)' };
  const status = STATUS_VISUAL[integration.status] ?? STATUS_VISUAL.disconnected;
  const unhealthy = status.tone === 'warn' || status.tone === 'crit';
  return (
    <div className="card intg">
      <span className="ic" style={{ background: visual.color }}>
        {visual.abbr}
      </span>
      <div>
        <div className="iname">{integration.display_name}</div>
        <div className="idesc">{status.desc}</div>
      </div>
      <div className="iact">
        {/* Preconfigured: status is shown, not an active connect/disconnect flow. */}
        <span className={'istatus ' + status.tone}>
          <span className="dot" />
          {status.label}
        </span>
      </div>
      {unhealthy && integration.last_error_summary && (
        <div className="ierror">
          <Icon name="warning" />
          <span>
            {integration.last_error_code && <span className="mono">{integration.last_error_code} · </span>}
            {integration.last_error_summary}
          </span>
        </div>
      )}
    </div>
  );
}
