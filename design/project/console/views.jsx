/* Recommendations + Integrations views */

/* Per-step lifecycle: undefined → 'generating' → 'ready' → 'done'.
   - 'pr'     step: Generate PR → generating → PR opened (ready) → Mark merged (done)
   - 'change' step: Generate change → generating → ready → Apply change (done)
   - 'open'   step (alert/panel): a single click marks it done; stays locked until
              the step it depends on is done.
   A recommendation only moves to the Accepted archive once EVERY step is done —
   so opening a PR never archives it; merging the last open step does. */
const ARCH_BADGE = {
  accepted:  { order: 0, icon: 'check-circle', label: 'Accepted' },
  dismissed: { order: 1, icon: 'close',        label: 'Dismissed' },
  outdated:  { order: 2, icon: 'clock',        label: 'Outdated' },
};

/* Card icon is driven by the recommendation's subject so it reads consistently:
   every Alert rec shows the same glyph, every Instrumentation rec another. */
const KIND_ICON = { Alert: 'bell', Instrumentation: 'levels' };
const kindIcon = r => KIND_ICON[r.kind] || r.icon;

function doneLabel(s) {
  if (s.tone === 'pr') return `PR #${s.pr.number} merged`;
  if (s.tone === 'change') return 'Change applied';
  return s.cta.replace(/^Create /, '') + (/^Create/.test(s.cta) ? ' created' : /^Add/.test(s.cta) ? ' added' : ' done');
}

function Recommendations() {
  const { ConfirmDialog } = window;
  const recs = window.RECOMMENDATIONS;

  const [status, setStatus] = React.useState(() => {
    const init = {};
    recs.forEach(r => { if (r.archived) init[r.id] = r.archived; });
    return init;
  });
  const [tab, setTab] = React.useState('active');
  const [step, setStep] = React.useState({});            // 'r.id:i' -> 'generating'|'ready'|'done'
  const [confirm, setConfirm] = React.useState(null);    // { r, i, mode }
  const [drawer, setDrawer] = React.useState(null);      // { r, i, mode, title, payload }

  const stateOf = r => status[r.id] || 'active';
  const stepOf = (r, i) => step[r.id + ':' + i];
  const lockedStep = (r, i, s) => !!s.waitsFor && stepOf(r, i - 1) !== 'done';

  const dismiss = r => setStatus(s => ({ ...s, [r.id]: 'dismissed' }));
  const restore = r => setStatus(s => { const n = { ...s }; delete n[r.id]; return n; });

  const startGen = (r, i) => {
    const key = r.id + ':' + i;
    setStep(s => ({ ...s, [key]: 'generating' }));
    setTimeout(() => setStep(s => (s[key] === 'generating' ? { ...s, [key]: 'ready' } : s)), 2400);
  };

  // Mark a step done; once all steps are done, the rec moves to the Accepted archive.
  const completeStep = (r, i) => {
    const key = r.id + ':' + i;
    setStep(prev => {
      const next = { ...prev, [key]: 'done' };
      const allDone = r.steps.every((_, j) => next[r.id + ':' + j] === 'done');
      if (allDone) Promise.resolve().then(() => setStatus(st => ({ ...st, [r.id]: 'accepted' })));
      return next;
    });
  };

  const openDrawer = (r, i, mode, s) =>
    setDrawer({ r, i, mode, title: s.label, payload: mode === 'pr' ? s.pr : s.change });

  const list = recs.filter(r => stateOf(r) === 'active');

  const TABS = [
    { id: 'active', icon: 'lightbulb', label: 'Open' },
    { id: 'archive', icon: 'archive', label: 'Archive' },
  ];

  const renderAction = (r, i, s) => {
    const st = stepOf(r, i);
    if (lockedStep(r, i, s)) {
      return <span className="rs-locked"><window.Icon name="branch" /><span>{`Unlocks when ${s.waitsFor}`}</span></span>;
    }
    if (st === 'done') {
      return <span className="rs-done"><window.Icon name="check-circle" /><span>{doneLabel(s)}</span></span>;
    }
    if (s.tone === 'pr') {
      if (st === 'generating') return <button className="btn btn-secondary btn-sm" disabled><span className="gen-dot pulse"></span>Generating PR</button>;
      if (st === 'ready') return <button className="btn btn-primary btn-sm" onClick={() => openDrawer(r, i, 'pr', s)}><window.Icon name="pr" />{s.cta}</button>;
      return <button className="btn btn-primary btn-sm" onClick={() => setConfirm({ r, i, mode: 'pr' })}><window.Icon name="pr" />Generate PR</button>;
    }
    if (s.tone === 'change') {
      if (st === 'generating') return <button className="btn btn-secondary btn-sm" disabled><span className="gen-dot pulse"></span>Generating change</button>;
      if (st === 'ready') return <button className="btn btn-primary btn-sm" onClick={() => openDrawer(r, i, 'change', s)}><window.Icon name="sliders" />{s.cta}</button>;
      return <button className="btn btn-primary btn-sm" onClick={() => setConfirm({ r, i, mode: 'change' })}><window.Icon name="sliders" />Generate change</button>;
    }
    return <button className="btn btn-secondary btn-sm" onClick={() => completeStep(r, i)}><window.Icon name={s.icon} />{s.cta}</button>;
  };

  return (
    <div className="content narrow">
      <div className="page-head">
        <div>
          <h1>Recommendations</h1>
          <div className="sub">Preventative fixes Instrument found by reading the codebase and signals.</div>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <div className="seg">
            {TABS.map(t => (
              <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                <window.Icon name={t.icon} />{t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tab === 'active' ? (
        list.length ? (
          <div className="rec-grid">
            {list.map(r => (
              <div key={r.id} className="card rec">
                <div className="rec-ic"><window.Icon name={kindIcon(r)} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="rhead">
                    <span className="tag tag-kind">{r.kind}</span>
                  </div>
                  <h3>{r.title}</h3>
                  <p className="rdesc">{r.desc}</p>
                  <ol className="rec-steps">
                    {r.steps.map((s, i) => (
                      <li key={i} className={'rec-step' + (lockedStep(r, i, s) ? ' locked' : '') + (r.steps.length === 1 ? ' single' : '')}>
                        {r.steps.length > 1 && <span className="rs-num">{i + 1}</span>}
                        <window.Icon name={s.icon} className="rs-ic" />
                        <span className="rs-label">{s.label}</span>
                        <span className="rs-action">{renderAction(r, i, s)}</span>
                      </li>
                    ))}
                  </ol>
                  <div className="rec-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => dismiss(r)}>Dismiss</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">
            <div className="ei"><window.Icon name="check-circle" /></div>
            <h3>All caught up</h3>
            <p>No open recommendations right now. Instrument keeps reading the codebase and signals for gaps worth hardening.</p>
          </div>
        )
      ) : (
        recs.some(r => stateOf(r) !== 'active') ? (
          <div className="rec-grid">
            {recs
              .filter(r => stateOf(r) !== 'active')
              .sort((a, b) => ARCH_BADGE[stateOf(a)].order - ARCH_BADGE[stateOf(b)].order)
              .map(r => {
                const st = stateOf(r);
                const badge = ARCH_BADGE[st];
                return (
                  <div key={r.id} className={'card rec rec-closed ' + st}>
                    <div className="rec-ic"><window.Icon name={kindIcon(r)} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="rhead">
                        <span className="tag tag-kind">{r.kind}</span>
                        <span className={'arch-badge ' + st}><window.Icon name={badge.icon} />{badge.label}</span>
                        {st === 'dismissed' && (
                          <button className="btn btn-ghost btn-sm arch-restore" style={{ marginLeft: 'auto' }} onClick={() => restore(r)}>
                            <window.Icon name="undo" />Restore
                          </button>
                        )}
                      </div>
                      <h3>{r.title}</h3>
                      <p className="rdesc" style={{ marginBottom: 0 }}>{r.desc}</p>
                    </div>
                  </div>
                );
              })}
          </div>
        ) : (
          <div className="empty">
            <div className="ei"><window.Icon name="archive" /></div>
            <h3>Nothing archived yet</h3>
            <p>Recommendations you complete, dismiss, or that go stale are kept here.</p>
          </div>
        )
      )}

      {confirm && (
        <ConfirmDialog
          icon={confirm.mode === 'pr' ? 'pr' : 'sliders'}
          title={confirm.mode === 'pr' ? 'Generate a pull request?' : 'Generate this change?'}
          confirmLabel={confirm.mode === 'pr' ? 'Generate PR' : 'Generate change'}
          confirmIcon={confirm.mode === 'pr' ? 'pr' : 'sliders'}
          onConfirm={() => { const { r, i } = confirm; setConfirm(null); startGen(r, i); }}
          onCancel={() => setConfirm(null)}
          body={<span>{confirm.mode === 'pr'
            ? 'Instrument will draft this change as a branch and open a pull request for review. It only proposes — nothing merges without your approval.'
            : 'Instrument will draft this configuration change for you to review before it’s applied. Nothing changes until you apply it.'}</span>}
        />
      )}

      {drawer && (
        <ActionDrawer
          mode={drawer.mode}
          title={drawer.title}
          payload={drawer.payload}
          onComplete={() => { completeStep(drawer.r, drawer.i); setDrawer(null); }}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}

/* One drawer, two modes. 'pr' shows the opened PR + a link to GitHub, and only
   advances the recommendation when the PR is marked merged. 'change' shows a
   config diff that is applied in place. */
function ActionDrawer({ mode, title, payload, onComplete, onClose }) {
  if (mode === 'change') {
    return (
      <React.Fragment>
        <div className="scrim" onClick={onClose}></div>
        <div className="drawer">
          <div className="drawer-head">
            <window.Icon name="sliders" style={{ fontSize: '20px', color: 'var(--brand-600)' }} />
            <h3>Configuration change</h3>
            <button className="icon-btn" style={{ marginLeft: 'auto', border: 'none', background: 'transparent' }} onClick={onClose}><window.Icon name="close" /></button>
          </div>
          <div className="drawer-body">
            <h2 style={{ font: 'var(--h3)', margin: '0 0 6px' }}>{title}</h2>
            <p style={{ fontSize: '14px', color: 'var(--ink-2)', lineHeight: 1.55, margin: '0 0 18px' }}>{payload.desc}</p>
            <div className="section-label">Applies to {payload.platform}</div>
            <div className="chg">
              {payload.rows.map((row, i) => (
                <div key={i} className="chg-row">
                  <span className="chg-k">{row.k}</span>
                  {row.from ? (
                    <span className="chg-v"><span className="chg-from">{row.from}</span><window.Icon name="arrow-right" /><span className="chg-to">{row.to}</span></span>
                  ) : (
                    <span className="chg-v">{row.v}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="drawer-foot">
            <button className="btn btn-ghost" style={{ marginRight: 'auto' }} onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={onComplete}><window.Icon name="check" />Apply change</button>
          </div>
        </div>
      </React.Fragment>
    );
  }
  return (
    <React.Fragment>
      <div className="scrim" onClick={onClose}></div>
      <div className="drawer">
        <div className="drawer-head">
          <window.Icon name="pr" style={{ fontSize: '20px', color: 'var(--brand-600)' }} />
          <h3>Pull request opened</h3>
          <button className="icon-btn" style={{ marginLeft: 'auto', border: 'none', background: 'transparent' }} onClick={onClose}><window.Icon name="close" /></button>
        </div>
        <div className="drawer-body">
          <h2 style={{ font: 'var(--h3)', margin: '0 0 6px' }}>{title}</h2>
          <p style={{ fontSize: '14px', color: 'var(--ink-2)', lineHeight: 1.55, margin: '0 0 18px' }}>{payload.desc}</p>

          <div className="section-label">Branch</div>
          <div className="pr-file" style={{ marginBottom: '18px' }}><window.Icon name="branch" />{payload.branch}</div>

          <div className="pr-opened">
            <window.Icon name="check-circle" />
            <span>PR #{payload.number} opened against <span className="code">main</span> — ready for review.</span>
          </div>
          <p className="pr-note">Review and merge it on GitHub. Instrument moves this recommendation to the archive once the PR is merged.</p>
        </div>
        <div className="drawer-foot">
          <button className="btn btn-ghost" style={{ marginRight: 'auto' }} onClick={onClose}>Close</button>
          <a className="btn btn-secondary" href="#" onClick={e => e.preventDefault()}><window.Icon name="external" />Open on GitHub</a>
          <button className="btn btn-primary" onClick={onComplete}><window.Icon name="branch" />Mark as merged</button>
        </div>
      </div>
    </React.Fragment>
  );
}

function Integrations() {
  const [sources, setSources] = React.useState(window.SOURCES);
  const toggle = id => setSources(s => s.map(x => x.id === id ? { ...x, connected: !x.connected } : x));
  return (
    <div className="content narrow">
      <div className="page-head">
        <div>
          <h1>Integrations</h1>
          <div className="sub">Connect the platforms Instrument should work across.</div>
        </div>
      </div>
      <div className="intg-grid">
        {sources.map(s => (
          <div key={s.id} className="card intg">
            <span className="ic" style={{ background: s.color }}>{s.abbr}</span>
            <div>
              <div className="iname">{s.name}</div>
              <div className="idesc">{s.connected ? 'Reading alerts & signals' : 'Not connected'}</div>
            </div>
            <div className="iact">
              {s.connected
                ? <button className="btn btn-secondary btn-sm" onClick={() => toggle(s.id)}><window.Icon name="check-circle" style={{ color: 'var(--ok)' }} />Connected</button>
                : <button className="btn btn-primary btn-sm" onClick={() => toggle(s.id)}><window.Icon name="plug" />Connect</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { Recommendations, Integrations });
