import { Icon } from '../../components/Icon';
import { SOURCES } from '../../data/sources';

/**
 * Integrations section. The first slice ships preconfigured integrations for a
 * single workspace and one repository, with no self-serve connect / OAuth flow
 * (PRD SEC-3, "Out of scope"). The scaffold renders the preconfigured sources
 * from static config; server-backed integration health arrives in Task 5D.
 */
export function Integrations() {
  return (
    <div className="content narrow">
      <div className="page-head">
        <div>
          <h1>Integrations</h1>
          <div className="sub">
            The platforms Instrument works across. Preconfigured for this
            workspace.
          </div>
        </div>
      </div>
      <div className="intg-grid">
        {SOURCES.map((s) => (
          <div key={s.id} className="card intg">
            <span className="ic" style={{ background: s.color }}>
              {s.abbr}
            </span>
            <div>
              <div className="iname">{s.name}</div>
              <div className="idesc">
                {s.connected ? 'Reading alerts & signals' : 'Not connected'}
              </div>
            </div>
            <div className="iact">
              {/* Self-serve connect/disconnect is out of scope for the first
                  slice; integrations are preconfigured. The control is shown as
                  a non-interactive status, not an active connect flow. */}
              {s.connected ? (
                <span className="btn btn-secondary btn-sm" aria-disabled="true">
                  <Icon name="check-circle" style={{ color: 'var(--ok)' }} />
                  Connected
                </span>
              ) : (
                <span className="tag tag-kind">Not connected</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
