import { NavLink } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { SOURCES } from '../../data/sources';
import { useAuth } from '../../auth/AuthProvider';

interface NavEntry {
  to: string;
  icon: string;
  label: string;
}

// The three console sections. Counts (active incidents / open recommendations)
// are server-backed in later tasks; the scaffold renders the navigation only.
const NAV: NavEntry[] = [
  { to: '/incidents', icon: 'signal', label: 'Incidents' },
  { to: '/recommendations', icon: 'lightbulb', label: 'Recommendations' },
  { to: '/integrations', icon: 'plug', label: 'Integrations' },
];

function initialsFor(user: { name?: string; email?: string; profile?: { name?: string } | null } | null): string {
  const name = user?.profile?.name || user?.name;
  if (name) {
    const parts = name.trim().split(/\s+/);
    return (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '');
  }
  const email = user?.email ?? '';
  return (email[0] ?? 'U').toUpperCase();
}

export function Sidebar() {
  const { user, signOut } = useAuth();
  const displayName = user?.profile?.name || user?.name || user?.email?.split('@')[0] || 'Signed in';
  const email = user?.email ?? '';

  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/assets/logo-mark.svg" alt="" />
        <span className="wm">Instrument</span>
      </div>

      <nav className="nav">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            className={({ isActive }) => 'nav-item' + (isActive ? ' on' : '')}
          >
            <Icon name={n.icon} />
            {n.label}
          </NavLink>
        ))}
      </nav>

      <div className="nav-sec">Connected sources</div>
      <div className="sources">
        {SOURCES.filter((s) => s.connected).map((s) => (
          <div key={s.id} className="source">
            <span className="ic" style={{ background: s.color }}>
              {s.abbr}
            </span>
            {s.name}
            <Icon name="check-circle" className="ok" />
          </div>
        ))}
      </div>

      <div className="sb-spacer" />

      <button
        type="button"
        className="profile"
        onClick={() => void signOut()}
        title="Sign out"
        style={{
          border: 'none',
          background: 'transparent',
          textAlign: 'left',
          width: '100%',
          cursor: 'pointer',
        }}
      >
        <div className="avatar">{initialsFor(user)}</div>
        <div className="who">
          <div className="who-name">{displayName}</div>
          <div className="who-role">{email}</div>
        </div>
        <Icon name="arrow-right" className="signout-ic" />
      </button>
    </aside>
  );
}
