/* App shell: Sidebar */

function Sidebar({ view, setView, activeCount, recCount }) {
  const nav = [
    { id: 'incidents', icon: 'signal', label: 'Incidents', count: activeCount, tone: 'crit' },
    { id: 'recommendations', icon: 'lightbulb', label: 'Recommendations', count: recCount, tone: 'brand' },
    { id: 'integrations', icon: 'plug', label: 'Integrations' },
  ];
  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="assets/logo-mark.svg" alt="" />
        <span className="wm">Instrument</span>
      </div>
      <nav className="nav">
        {nav.map(n => (
          <button key={n.id} className={'nav-item' + (view === n.id ? ' on' : '')} onClick={() => setView(n.id)}>
            <window.Icon name={n.icon} />{n.label}
            {n.count ? <span className={'count' + (n.tone === 'brand' ? ' count-brand' : '')}>{n.count}</span> : null}
          </button>
        ))}
      </nav>

      <div className="nav-sec">Connected sources</div>
      <div className="sources">
        {window.SOURCES.filter(s => s.connected).map(s => (
          <div key={s.id} className="source">
            <span className="ic" style={{ background: s.color }}>{s.abbr}</span>
            {s.name}
            <window.Icon name="check-circle" className="ok" />
          </div>
        ))}
      </div>

      <div className="sb-spacer"></div>

      <a className="profile" href="Auth Page.html" title="Sign out" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="avatar">RA</div>
        <div className="who">
          <div className="who-name">Rae Alvarez</div>
          <div className="who-role">rae@acme.io</div>
        </div>
        <window.Icon name="arrow-right" className="signout-ic" />
      </a>
    </aside>
  );
}

Object.assign(window, { Sidebar });
