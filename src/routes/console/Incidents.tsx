import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Activity, AutoBadge, Pill, RULE_COLOR } from '../../components/console/indicators';
import { Segmented } from '../../components/console/Segmented';
import { ConfirmDialog } from '../../components/console/overlays';
import { ErrorState, LoadingState, Toast, useTransientNotice } from '../../components/console/feedback';
import { useIncidentsView, useWorkspaceSettings } from '../../data/hooks';
import type { IncidentWithState, InvestigationStartMode } from '../../data/reads';
import { setInvestigationMode, startInvestigation } from '../../data/actions';
import { formatWhen } from '../../lib/format';
import { AutoInvestigateMenu } from './AutoInvestigateMenu';

/**
 * Incidents section. Server-backed: each row's lifecycle marker is derived from
 * durable investigation-job state (no job → New, queued/running/retrying →
 * Investigating, succeeded → Investigation complete, failed → Investigation
 * failed), so a refresh resumes the same state without re-running anything. The
 * list polls while any investigation is in flight.
 *
 * The prototype's incident "Generate fix" PR workflow is intentionally absent —
 * PR generation from an incident is future scope (PRD/ERD); investigations only
 * read and propose a cause.
 */
export function Incidents() {
  const [scope, setScope] = useState<'active' | 'resolved'>('active');
  const view = useIncidentsView(scope);
  const notice = useTransientNotice();

  const rows = view.data ?? [];

  const investigate = useCallback(
    async (incidentId: string) => {
      const res = await startInvestigation(incidentId);
      if (res.ok) await view.refetch();
      else notice.show(res.error ?? 'The investigation could not be started.');
    },
    [view, notice],
  );

  return (
    <div className="content narrow">
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <div className="sub">
            Alerts relayed from your sources, with Instrument's read-only investigation attached.
          </div>
        </div>
        <div className="head-controls">
          <StartModeControl notify={notice.show} />
          <Segmented
            ariaLabel="Incident filter"
            value={scope}
            onChange={setScope}
            options={[
              { id: 'active', label: 'Active', icon: 'signal' },
              { id: 'resolved', label: 'Resolved', icon: 'check-circle' },
            ]}
          />
        </div>
      </div>

      {view.loading ? (
        <LoadingState label="Loading incidents…" />
      ) : view.error ? (
        <ErrorState message="The incident feed could not be loaded." onRetry={view.refetch} />
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="ei">
            <Icon name="check-circle" />
          </div>
          <h3>{scope === 'active' ? 'All quiet' : 'No resolved incidents'}</h3>
          <p>
            {scope === 'active'
              ? 'No alerts firing right now. Instrument keeps watching every connected service and surfaces anything worth attention.'
              : 'Resolved incidents will be kept here once an alert clears.'}
          </p>
        </div>
      ) : (
        <div className="inc-list">
          {rows.map((row) => (
            <IncidentRow
              key={row.incident.id}
              row={row}
              onInvestigate={() => investigate(row.incident.id)}
            />
          ))}
        </div>
      )}

      {notice.notice && (
        <Toast key={notice.key} message={notice.notice} onDone={notice.clear} />
      )}
    </div>
  );
}

/** Reads the workspace setting and persists changes optimistically. */
function StartModeControl({ notify }: { notify: (message: string) => void }) {
  const settings = useWorkspaceSettings();
  const [override, setOverride] = useState<InvestigationStartMode | null>(null);
  const [saving, setSaving] = useState(false);

  const mode = override ?? settings.data?.investigation_start_mode ?? 'manual';
  const workspaceId = settings.data?.id;

  const onChange = useCallback(
    async (next: InvestigationStartMode) => {
      if (!workspaceId || next === mode) return;
      setOverride(next); // optimistic — investigations in flight are untouched
      setSaving(true);
      const res = await setInvestigationMode(workspaceId, next);
      setSaving(false);
      if (!res.ok) {
        setOverride(null); // revert on failure
        notify(res.error ?? 'The investigation-start setting could not be changed.');
      } else {
        // Re-read, then drop the optimistic override so the server value is the
        // source of truth again (no stale shadow on later changes).
        await settings.refetch();
        setOverride(null);
      }
    },
    [workspaceId, mode, settings, notify],
  );

  if (!settings.data) return null;
  return <AutoInvestigateMenu value={mode} onChange={onChange} saving={saving} />;
}

function IncidentRow({ row, onInvestigate }: { row: IncidentWithState; onInvestigate: () => Promise<void> }) {
  const { incident, display } = row;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const resolved = incident.incident_state === 'resolved';
  const auto = incident.started_automatically && display !== 'new';

  const run = async () => {
    setConfirm(false);
    setBusy(true);
    try {
      await onInvestigate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="inc">
      <span className="rule" style={{ background: RULE_COLOR[incident.alert_state] }} />
      <div className="ibody">
        <div className="itop">
          {resolved ? <Pill alert={incident.alert_state} /> : <Activity kind={display} />}
          {auto && <AutoBadge />}
          <span className="itime">
            <span className="mono">{incident.service_name ?? 'service'}</span>
            {' · '}
            {formatWhen(resolved ? incident.resolved_at : incident.started_at)}
          </span>
        </div>
        <h3>{incident.title}</h3>
        {display === 'failed' && (
          <p className="idesc" style={{ color: 'var(--crit-ink)' }}>
            <Icon name="warning" style={{ verticalAlign: '-2px', marginRight: '6px' }} />
            The investigation failed. Open it to see the preserved progress and retry.
          </p>
        )}
        <div className="ifoot">
          {display === 'new' ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirm(true)} disabled={busy}>
              {busy ? (
                <>
                  <span className="btn-spin" />
                  Starting…
                </>
              ) : (
                <>
                  <Icon name="search" />
                  Investigate
                </>
              )}
            </button>
          ) : (
            <Link className="btn btn-secondary btn-sm" to={`/incidents/${incident.id}`}>
              <Icon name="eye" />
              View investigation
            </Link>
          )}
        </div>
      </div>
      {confirm && (
        <ConfirmDialog
          icon="search"
          title="Start investigation?"
          confirmLabel="Investigate"
          confirmIcon="search"
          onConfirm={run}
          onCancel={() => setConfirm(false)}
          body={
            <span>
              Instrument will pull traces, recent deploys, and logs for{' '}
              <span className="code">{incident.service_name ?? 'this service'}</span> and correlate
              them to propose a cause. It only reads — nothing in your systems changes.
            </span>
          }
        />
      )}
    </article>
  );
}
