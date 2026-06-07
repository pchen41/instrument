import { ErrorState, LoadingState } from '../../components/console/feedback';
import { useIntegrations } from '../../data/hooks';
import type { IntegrationHealth, IntegrationProvider } from '../../data/reads';

/**
 * Integrations section. Lists the workspace's preconfigured providers and shows
 * that they are set up — this page is about whether an integration is connected
 * to the workspace, not its live connection health (which surfaces through
 * incidents/recommendations instead). The first slice ships no self-serve
 * connect / OAuth flow (PRD SEC-3, "Out of scope").
 */

const PROVIDER_VISUAL: Record<IntegrationProvider, { abbr: string; color: string }> = {
  datadog: { abbr: 'DD', color: '#632CA6' },
  github: { abbr: 'GH', color: '#1B1F24' },
  truefoundry: { abbr: 'TF', color: '#5B3DF5' },
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
        <ErrorState message="Integrations could not be loaded." onRetry={view.refetch} />
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
  return (
    <div className="card intg">
      <span className="ic" style={{ background: visual.color }}>
        {visual.abbr}
      </span>
      <div>
        <div className="iname">{integration.display_name}</div>
        <div className="idesc">Connected to this workspace</div>
      </div>
      <div className="iact">
        {/* Preconfigured: shows that the integration is set up, not a connect flow. */}
        <span className="istatus ok">
          <span className="dot" />
          Connected
        </span>
      </div>
    </div>
  );
}
