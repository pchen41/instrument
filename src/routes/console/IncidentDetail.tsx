import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Activity, AutoBadge, Confidence, Pill } from '../../components/console/indicators';
import { GenProgress } from '../../components/console/GenProgress';
import { ConfirmDialog } from '../../components/console/overlays';
import { ErrorState, LoadingState, Toast, useTransientNotice } from '../../components/console/feedback';
import { useIncidentDetail, type IncidentDetailData } from '../../data/hooks';
import { incidentDisplayState } from '../../data/reads';
import { runDeferredAction, type DeferredAction } from '../../data/deferred';
import { formatClockUTC } from '../../lib/format';
import type { ConfidenceLevel } from '../../lib/schemas';

const CHANGE_ICON: Record<string, string> = { commit: 'commit', pr: 'pr', deploy: 'cube', config: 'sliders' };

function rootTitle(level: ConfidenceLevel | null | undefined): string {
  return level === 'high' ? 'Root cause' : 'Leading hypothesis';
}

export function IncidentDetail() {
  const { incidentId = '' } = useParams();
  const view = useIncidentDetail(incidentId);
  const notice = useTransientNotice();
  const fire = useCallback((a: DeferredAction) => notice.show(runDeferredAction(a).message), [notice]);

  return (
    <div className="content">
      <Link className="btn btn-ghost btn-sm" to="/incidents" style={{ marginBottom: '14px', marginLeft: '-6px' }}>
        <Icon name="arrow-left" />
        All incidents
      </Link>

      {view.loading ? (
        <LoadingState label="Loading investigation…" />
      ) : view.error ? (
        <ErrorState message="This investigation could not be loaded." onRetry={view.refetch} />
      ) : !view.data ? (
        <div className="empty">
          <div className="ei">
            <Icon name="search" />
          </div>
          <h3>Incident not found</h3>
          <p>It may have been resolved or is outside this workspace.</p>
        </div>
      ) : (
        <Investigation data={view.data} fire={fire} />
      )}

      {notice.notice && <Toast key={notice.key} message={notice.notice} onDone={notice.clear} />}
    </div>
  );
}

function Investigation({ data, fire }: { data: IncidentDetailData; fire: (a: DeferredAction) => void }) {
  const { incident, job, evidence } = data;
  const display = incidentDisplayState(incident, job);
  const resolved = incident.incident_state === 'resolved';
  const auto = incident.started_automatically && display !== 'new';

  // Guard the jsonb array columns (schema defaults them to [], but never crash a
  // detail page on a partial read).
  const hypotheses = incident.hypotheses ?? [];
  const signals = incident.signals ?? [];
  const timeline = incident.timeline ?? [];
  const correlatedChanges = incident.correlated_changes ?? [];
  const phases = job?.phases ?? [];
  const leading = hypotheses.find((h) => h.leading) ?? hypotheses[0] ?? null;
  const retryingPhase = phases.find((p) => p.state === 'retrying');

  return (
    <div className="inv">
      <div className="inv-main">
        <div className="card rca">
          <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '12px' }}>
            {resolved ? <Pill alert={incident.alert_state} /> : <Activity kind={display} />}
            {auto && <AutoBadge />}
            <span className="mono" style={{ fontSize: '12px', color: 'var(--ink-3)' }}>
              {incident.service_name ?? 'service'}
            </span>
          </div>
          <h2>{incident.title}</h2>
          <p className="lead">{incident.description}</p>

          {display === 'complete' && leading && (
            <div className="callout">
              <Icon name="sparkle" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="crow">
                  <div className="ctitle">{rootTitle(leading.confidence)}</div>
                  <Confidence level={leading.confidence} />
                </div>
                <div className="ctext">
                  {leading.summary}. {leading.detail}
                </div>
              </div>
            </div>
          )}

          {display === 'investigating' && (
            <div className="callout callout-live">
              <Icon name="search" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ctitle">Investigating</div>
                <div className="ctext">
                  Instrument is correlating traces, recent deploys, and logs for{' '}
                  {incident.service_name ?? 'this service'}. A cause will appear here when the
                  investigation completes.
                </div>
                {job && (
                  <div style={{ marginTop: '14px' }}>
                    <GenProgress phases={phases} note={retryingPhase?.detail ?? null} />
                  </div>
                )}
              </div>
            </div>
          )}

          {display === 'failed' && job && <FailedInvestigation incident={incident} job={job} fire={fire} />}

          {display === 'new' && <NotStarted serviceName={incident.service_name} fire={fire} />}
        </div>

        {hypotheses.length > 0 && (
          <div className="card rca">
            <div className="section-label">Hypotheses considered</div>
            <div className="hyp">
              {hypotheses.map((h) => (
                <div key={h.rank} className={'hyp-item' + (h.leading ? ' lead-h' : '')}>
                  <span className="hyp-rank">{h.rank}</span>
                  <div className="hyp-body">
                    <div className="ht">
                      {h.summary}
                      {h.leading && (
                        <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--brand-700)', fontWeight: 700 }}>
                          LEADING
                        </span>
                      )}
                    </div>
                    <div className="hd">{h.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {correlatedChanges.length > 0 && (
          <div className="card rca">
            <div className="section-label">Correlated changes</div>
            <div className="hyp">
              {correlatedChanges.map((c, i) => (
                <div key={i} className="hyp-item">
                  <span className="hyp-rank">
                    <Icon name={CHANGE_ICON[c.kind] ?? 'commit'} />
                  </span>
                  <div className="hyp-body">
                    <div className="ht">
                      {c.url ? (
                        <a href={c.url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                          <span className="mono">{c.ref}</span>
                          <Icon name="external" style={{ fontSize: '12px', marginLeft: '5px', verticalAlign: '-1px' }} />
                        </a>
                      ) : (
                        <span className="mono">{c.ref}</span>
                      )}
                    </div>
                    <div className="hd">{c.summary}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="rail">
        {signals.length > 0 && (
          <div className="card rail-card">
            <h4>Signals</h4>
            {signals.map((s) => (
              <div key={s.key} className="meta-row">
                <span className="k">{s.label}</span>
                <span className="v">{s.value}</span>
              </div>
            ))}
          </div>
        )}

        <div className="card rail-card">
          <h4>Investigation timeline</h4>
          <div className="tl">
            {timeline.map((t, i) => (
              <div key={i} className="tl-item">
                <span className={'tl-dot ' + (t.kind === 'alert' ? 'crit' : 'act')} />
                <div className="tl-time">{formatClockUTC(t.at)} UTC</div>
                <div className="tl-title">{t.title}</div>
                {t.detail && <div className="tl-desc">{t.detail}</div>}
              </div>
            ))}
          </div>
        </div>

        {evidence.length > 0 && (
          <div className="card rail-card">
            <h4>Evidence</h4>
            <div className="ev-list">
              {evidence.map((e) => (
                <div key={e.id} className="ev-item">
                  <Icon name="file-code" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="ev-title">
                      {e.uri ? (
                        <a href={e.uri} target="_blank" rel="noreferrer">
                          {e.title}
                        </a>
                      ) : (
                        e.title
                      )}
                    </div>
                    <div className="ev-summary">{e.summary}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Failed investigation: the PRD's required failed state. Preserves the progress
 * reached, names the affected integration/source and the error, and offers a
 * retry when the job is safe to retry — never an endless spinner, never a fix.
 */
function FailedInvestigation({
  incident,
  job,
  fire,
}: {
  incident: IncidentDetailData['incident'];
  job: NonNullable<IncidentDetailData['job']>;
  fire: (a: DeferredAction) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const phases = job.phases ?? [];
  return (
    <div className="job-failed">
      <div className="jf-head">
        <Icon name="warning" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="jf-title">Investigation failed</div>
          <p className="jf-reason">
            {job.error_summary ?? 'The investigation could not complete.'} The progress Instrument
            reached is preserved below.
          </p>
        </div>
      </div>

      <div className="jf-meta">
        {job.failure_source && (
          <span className="jf-chip">
            <Icon name="plug" />
            Source: <span className="mono">{job.failure_source}</span>
          </span>
        )}
        {incident.service_name && (
          <span className="jf-chip">
            <Icon name="cube" />
            Service: <span className="mono">{incident.service_name}</span>
          </span>
        )}
        {job.error_code && (
          <span className="jf-chip">
            <Icon name="critical" />
            <span className="mono">{job.error_code}</span>
          </span>
        )}
        <span className="jf-chip">
          <Icon name="undo" />
          {job.attempt_count} of {job.max_attempts} attempts
        </span>
      </div>

      {phases.length > 0 && (
        <div className="jf-progress">
          <GenProgress phases={phases} />
        </div>
      )}

      <div className="jf-actions">
        {job.safe_to_retry ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirm(true)}>
            <Icon name="undo" />
            Retry investigation
          </button>
        ) : (
          <span className="jf-noretry">
            <Icon name="info" style={{ verticalAlign: '-2px', marginRight: '5px' }} />
            Not safe to retry automatically — needs a closer look.
          </span>
        )}
      </div>

      {confirm && (
        <ConfirmDialog
          icon="undo"
          title="Retry this investigation?"
          confirmLabel="Retry"
          confirmIcon="undo"
          onConfirm={() => {
            setConfirm(false);
            fire('retry_investigation');
          }}
          onCancel={() => setConfirm(false)}
          body={
            <span>
              Instrument will run the investigation again from the preserved progress. It only reads
              — nothing in your systems changes.
            </span>
          }
        />
      )}
    </div>
  );
}

function NotStarted({ serviceName, fire }: { serviceName: string | null; fire: (a: DeferredAction) => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div style={{ marginTop: '16px' }}>
      <div className="callout">
        <Icon name="search" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ctitle">Not started yet</div>
          <div className="ctext">
            Investigation start is manual for this workspace, so this alert is waiting for you. Start
            an investigation and Instrument will pull traces, deploys, and logs and propose a cause —
            read-only.
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '14px' }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirm(true)}>
          <Icon name="search" />
          Investigate
        </button>
      </div>
      {confirm && (
        <ConfirmDialog
          icon="search"
          title="Start investigation?"
          confirmLabel="Investigate"
          confirmIcon="search"
          onConfirm={() => {
            setConfirm(false);
            fire('start_investigation');
          }}
          onCancel={() => setConfirm(false)}
          body={
            <span>
              Instrument will pull traces, recent deploys, and logs for{' '}
              <span className="code">{serviceName ?? 'this service'}</span> and correlate them to
              propose a cause. It only reads — nothing in your systems changes.
            </span>
          }
        />
      )}
    </div>
  );
}
