import { EmptyState } from '../../components/EmptyState';

/**
 * Incidents section. Server-backed incident reads, the investigation lifecycle,
 * and the live investigation view arrive in later tasks (4, 10, 11); the
 * scaffold renders an empty container.
 *
 * NOTE: The prototype's incident "Generate fix" PR workflow is intentionally
 * NOT present here. PR generation is future scope (PRD/ERD), so no
 * "Generate fix" action is exposed as an active demo action in Task 1.
 */
export function Incidents() {
  return (
    <div className="content narrow">
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <div className="sub">
            Alerts relayed from your sources, with Instrument's investigation
            attached.
          </div>
        </div>
      </div>
      <EmptyState icon="signal" title="No incidents yet">
        When a connected source relays a firing alert, the incident and
        Instrument's read-only investigation will appear here.
      </EmptyState>
    </div>
  );
}
