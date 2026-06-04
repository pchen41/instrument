/* Incidents: list, investigation detail */

function rootTitle(inc) {
  // Honest labeling: only call it a "root cause" when confidence is high;
  // otherwise it's still the leading hypothesis.
  return inc.confWord === 'High' ? 'Root cause' : 'Leading hypothesis';
}

function IncidentRow({ inc, inv, onOpen, onInvestigate }) {
  const { Pill, Activity, Confidence, ConfirmDialog, RULE_COLOR } = window;
  const [confirm, setConfirm] = React.useState(false);
  const lead = inc.hypotheses && inc.hypotheses[0];
  const resolved = inc.state === 'resolved';
  const done = inv === 'complete';
  return (
    <article className="inc">
      <span className="rule" style={{ background: RULE_COLOR[inc.alert] }}></span>
      <div className="ibody">
        <div className="itop">
          {resolved ? <Pill alert={inc.alert} /> : <Activity kind={inv} />}
          <span className="itime">{inc.source} · {inc.started}</span>
        </div>
        <h3>{inc.title}</h3>
        <p className="idesc">{inc.desc}</p>
        {done && lead && lead.lead && (
          <div className="finding">
            <window.Icon name="sparkle" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="frow">
                <span className="ft">{rootTitle(inc)}</span>
                <Confidence word={inc.confWord} />
              </div>
              <div className="fx">{lead.t}.</div>
            </div>
          </div>
        )}
        <div className="ifoot">
          {inv === 'new' ? (
            <button className="btn btn-primary btn-sm" onClick={() => setConfirm(true)}>
              <window.Icon name="search" />Investigate
            </button>
          ) : (
            <button className="btn btn-secondary btn-sm" onClick={() => onOpen(inc)}>
              <window.Icon name="eye" />View investigation
            </button>
          )}
        </div>
      </div>
      {confirm && (
        <ConfirmDialog
          icon="search"
          title="Start investigation?"
          confirmLabel="Investigate"
          confirmIcon="search"
          onConfirm={() => { setConfirm(false); onInvestigate(inc); }}
          onCancel={() => setConfirm(false)}
          body={<span>Instrument will pull traces, recent deploys, and error logs for <span className="code">{inc.service}</span> and correlate them to propose a cause. It only reads — nothing in your systems changes.</span>}
        />
      )}
    </article>
  );
}

function IncidentList({ invStates, onOpen, onInvestigate }) {
  const [tab, setTab] = React.useState('active');
  const list = window.INCIDENTS.filter(i => tab === 'active' ? i.state === 'active' : i.state === 'resolved');
  const serviceCount = new Set(window.INCIDENTS.map(i => i.service)).size;
  const sourceCount = window.SOURCES.filter(s => s.connected).length;
  return (
    <div className="content narrow">
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <div className="sub">Instrument is watching {serviceCount} services across {sourceCount} connected sources.</div>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <div className="seg">
            <button className={tab === 'active' ? 'on' : ''} onClick={() => setTab('active')}><window.Icon name="signal" />Active</button>
            <button className={tab === 'resolved' ? 'on' : ''} onClick={() => setTab('resolved')}><window.Icon name="check-circle" />Resolved</button>
          </div>
        </div>
      </div>
      {list.length ? (
        <div className="inc-list">
          {list.map(inc => <IncidentRow key={inc.id} inc={inc} inv={invStates[inc.id]} onOpen={onOpen} onInvestigate={onInvestigate} />)}
        </div>
      ) : (
        <div className="empty">
          <div className="ei"><window.Icon name="check-circle" /></div>
          <h3>All quiet</h3>
          <p>No alerts firing right now. Instrument keeps watching every connected service and surfaces anything worth attention.</p>
        </div>
      )}
    </div>
  );
}

function Investigation({ inc, inv, fixState, onBack, onGenerateFix }) {
  const { Pill, Activity, Confidence, ConfirmDialog } = window;
  const [confirm, setConfirm] = React.useState(false);
  const resolved = inc.state === 'resolved';
  const done = inv === 'complete';
  const generating = fixState === 'generating';
  return (
    <div className="content">
      <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: '14px', marginLeft: '-6px' }}>
        <window.Icon name="arrow-left" />All incidents
      </button>

      <div className="inv">
        <div className="inv-main">
          <div className="card rca">
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '12px' }}>
              {resolved ? <Pill alert={inc.alert} /> : <Activity kind={inv} />}
              <span className="mono" style={{ fontSize: '12px', color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>{inc.source}</span>
            </div>
            <h2>{inc.title}</h2>
            <p className="lead">{inc.desc}</p>

            {done ? (
              inc.hypotheses[0].lead && (
                <div className="callout">
                  <window.Icon name="sparkle" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="crow">
                      <div className="ctitle">{rootTitle(inc)}</div>
                      <Confidence word={inc.confWord} />
                    </div>
                    <div className="ctext">{inc.hypotheses[0].t}. {inc.hypotheses[0].d}</div>
                  </div>
                </div>
              )
            ) : (
              <div className="callout callout-live">
                <window.Icon name="search" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ctitle">Investigating</div>
                  <div className="ctext">Instrument is correlating traces, recent deploys, and error logs for {inc.service}. A cause will appear here when the investigation completes.</div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '16px', flexWrap: 'wrap' }}>
              {!done && (
                <span className="gen-hint">
                  <window.Icon name="info" />
                  A fix can be generated once the investigation completes.
                </span>
              )}
              <button
                className={'btn ' + (generating ? 'btn-secondary' : 'btn-primary')}
                style={{ marginLeft: 'auto' }}
                disabled={!done || generating}
                onClick={() => setConfirm(true)}
              >
                {generating
                  ? <React.Fragment><span className="gen-dot pulse"></span>Generating fix</React.Fragment>
                  : <React.Fragment><window.Icon name="pr" />Generate fix</React.Fragment>}
              </button>
            </div>
          </div>

          {done && inc.diff && (
            <div className="card rca">
              <div className="section-label">Correlated code change · PR #3120</div>
              <div className="diff">
                {inc.diff.map((l, i) => <span key={i} className={l.t}>{l.s}</span>)}
              </div>
            </div>
          )}

          {done && (
            <div className="card rca">
              <div className="section-label">Hypotheses considered</div>
              <div className="hyp">
                {inc.hypotheses.map((h, i) => (
                  <div key={i} className={'hyp-item' + (h.lead ? ' lead-h' : '')}>
                    <span className="hyp-rank">{i + 1}</span>
                    <div className="hyp-body">
                      <div className="ht">{h.t}{h.lead && <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--brand-700)', fontWeight: 700 }}>LEADING</span>}</div>
                      <div className="hd">{h.d}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="rail">
          <div className="card rail-card">
            <h4>Signals</h4>
            {inc.metrics.map((m, i) => (
              <div key={i} className="meta-row"><span className="k">{m.k}</span><span className="v">{m.v}</span></div>
            ))}
          </div>
          <div className="card rail-card">
            <h4>Investigation timeline</h4>
            <div className="tl">
              {inc.timeline.map((t, i) => (
                <div key={i} className="tl-item">
                  <span className={'tl-dot ' + t.kind}></span>
                  <div className="tl-time">{t.time} UTC</div>
                  <div className="tl-title">{t.title}</div>
                  <div className="tl-desc">{t.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          icon="pr"
          title="Generate a fix?"
          confirmLabel="Generate fix"
          confirmIcon="pr"
          onConfirm={() => { setConfirm(false); onGenerateFix(inc); }}
          onCancel={() => setConfirm(false)}
          body={<span>Instrument will draft a fix from this analysis and open it as a pull request for review.</span>}
        />
      )}
    </div>
  );
}

Object.assign(window, { IncidentList, Investigation });
