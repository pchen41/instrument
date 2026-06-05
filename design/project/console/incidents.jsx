/* Incidents: list, investigation detail */

/* Investigation-start policy options. Copy is honest about the boundary:
   investigations only ever read; a fix is never generated automatically. */
const AUTO_MODES = [
  { id: 'manual', short: 'Manual', label: 'Manual',
    desc: 'Every investigation waits for you to press Investigate.' },
  { id: 'auto', short: 'Automatic', label: 'Automatic',
    desc: 'Instrument starts investigating every firing alert the moment it arrives.' },
  { id: 'smart', short: 'Instrument decides', label: 'Let Instrument decide', spark: true,
    desc: 'Instrument starts on its own for clear-cut alerts, and waits for you when the cause looks ambiguous.' },
];

function AutoInvestigateMenu({ mode, onSet }) {
  const [open, setOpen] = React.useState(false);
  const cur = AUTO_MODES.find(m => m.id === mode) || AUTO_MODES[0];
  return (
    <div className="ai-menu-wrap">
      <button className={'btn btn-secondary btn-sm ai-trigger' + (open ? ' on' : '')} onClick={() => setOpen(o => !o)} title="Investigation start">
        <window.Icon name="search" />
        <span className="ai-trigger-label">{cur.short}</span>
        <window.Icon name="chevron-down" className="ai-caret" />
      </button>
      {open && (
        <React.Fragment>
          <div className="menu-catch" onClick={() => setOpen(false)}></div>
          <div className="ai-pop" role="menu">
            <div className="ai-pop-head">Investigation start</div>
            <p className="ai-pop-sub">When an alert fires, decide whether Instrument waits for you or starts looking on its own. Investigations only read your systems — a fix is never generated automatically.</p>
            <div className="ai-opts">
              {AUTO_MODES.map(m => {
                const on = m.id === mode;
                return (
                  <button key={m.id} className={'ai-opt' + (on ? ' on' : '')} onClick={() => { onSet(m.id); setOpen(false); }} role="menuitemradio" aria-checked={on}>
                    <span className={'ai-radio' + (on ? ' on' : '')}></span>
                    <span className="ai-opt-body">
                      <span className="ai-opt-label">{m.label}{m.spark && <window.Icon name="sparkle" className="ai-opt-spark" />}</span>
                      <span className="ai-opt-desc">{m.desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </React.Fragment>
      )}
    </div>
  );
}

/* Marks an investigation that began without a human, per the start policy.
   Sparkle = Instrument authored the action, paired with words (never an emoji). */
function AutoBadge() {
  return <span className="auto-chip"><window.Icon name="sparkle" />Started automatically</span>;
}

function rootTitle(inc) {
  // Honest labeling: only call it a "root cause" when confidence is high;
  // otherwise it's still the leading hypothesis.
  return inc.confWord === 'High' ? 'Root cause' : 'Leading hypothesis';
}

function IncidentRow({ inc, inv, auto, onOpen, onInvestigate }) {
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
          {auto && inv !== 'new' && <AutoBadge />}
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
              {inc.fixable === false && (
                <div className="nf-chip"><window.Icon name="shield" />Upstream cause — no code fix to generate</div>
              )}
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

function IncidentList({ invStates, autoStarted, autoMode, onSetAutoMode, onOpen, onInvestigate }) {
  const [tab, setTab] = React.useState('active');
  const list = window.INCIDENTS.filter(i => tab === 'active' ? i.state === 'active' : i.state === 'resolved');
  const sourceCount = window.SOURCES.filter(s => s.connected).length;
  return (
    <div className="content narrow">
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <div className="sub">Instrument is watching every connected service across {sourceCount} sources.</div>
        </div>
        <div className="head-controls">
          <AutoInvestigateMenu mode={autoMode} onSet={onSetAutoMode} />
          <div className="seg">
            <button className={tab === 'active' ? 'on' : ''} onClick={() => setTab('active')}><window.Icon name="signal" />Active</button>
            <button className={tab === 'resolved' ? 'on' : ''} onClick={() => setTab('resolved')}><window.Icon name="check-circle" />Resolved</button>
          </div>
        </div>
      </div>
      {list.length ? (
        <div className="inc-list">
          {list.map(inc => <IncidentRow key={inc.id} inc={inc} inv={invStates[inc.id]} auto={autoStarted[inc.id]} onOpen={onOpen} onInvestigate={onInvestigate} />)}
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

function Investigation({ inc, inv, invProg, auto, fixState, onBack, onGenerateFix, onOpenFixProgress, onOpenFixResult }) {
  const { Pill, Activity, Confidence, ConfirmDialog } = window;
  const [confirm, setConfirm] = React.useState(false);
  const resolved = inc.state === 'resolved';
  const done = inv === 'complete';
  const noFix = inc.fixable === false;
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
              {auto && inv !== 'new' && <AutoBadge />}
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
                  {invProg && (
                    <div style={{ marginTop: '14px' }}>
                      <window.GenProgress phases={invProg.phases} note={invProg.note} />
                    </div>
                  )}
                </div>
              </div>
            )}

            {done && noFix ? (
              <div className="no-fix">
                <window.Icon name="shield" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="nf-title">No code fix to generate</div>
                  <p className="nf-reason">{inc.noFix.reason}</p>
                  <p className="nf-next"><span className="nf-next-label">Suggested next step</span>{inc.noFix.nextStep}</p>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '16px', flexWrap: 'wrap' }}>
                {!done && (
                  <span className="gen-hint">
                    <window.Icon name="info" />
                    A fix can be generated once the investigation completes.
                  </span>
                )}
                {(() => {
                  const base = { marginLeft: 'auto' };
                  if (!done) return <button className="btn btn-primary" style={base} disabled><window.Icon name="pr" />Generate fix</button>;
                  if (fixState === 'generating') return <button className="btn btn-secondary gen-live" style={base} onClick={() => onOpenFixProgress(inc)}><span className="gen-dot pulse"></span>Generating fix<window.Icon name="arrow-right" className="affordance" /></button>;
                  if (fixState === 'ready') return <button className="btn btn-primary" style={base} onClick={() => onOpenFixResult(inc)}><window.Icon name="pr" />View fix PR</button>;
                  if (fixState === 'merged') return <span className="rs-done" style={base}><window.Icon name="check-circle" /><span>Fix PR #{inc.fix.number} merged</span></span>;
                  return <button className="btn btn-primary" style={base} onClick={() => setConfirm(true)}><window.Icon name="pr" />Generate fix</button>;
                })()}
              </div>
            )}
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
