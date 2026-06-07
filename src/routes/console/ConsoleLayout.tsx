import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Icon } from '../../components/Icon';

const SECTION_LABEL: Record<string, string> = {
  '/incidents': 'Incidents',
  '/recommendations': 'Recommendations',
  '/integrations': 'Integrations',
};

/**
 * The console shell: a fixed sidebar plus the scrolling main column with a
 * sticky topbar. Section content renders through <Outlet>. The shell itself is
 * static chrome — section views own their (server-backed) data.
 */
export function ConsoleLayout() {
  const location = useLocation();
  const section =
    SECTION_LABEL[location.pathname] ??
    Object.entries(SECTION_LABEL).find(([path]) =>
      location.pathname.startsWith(path),
    )?.[1] ??
    'Console';

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <div className="topbar">
          <div className="crumb">
            Workspace <b>{section}</b>
          </div>
          <div className="search">
            <Icon name="search" />
            Search incidents, recommendations…
          </div>
          <div className="tb-right">
            <button type="button" className="icon-btn" title="Notifications" aria-label="Notifications">
              <Icon name="bell" />
            </button>
          </div>
        </div>
        <Outlet />
      </div>
    </div>
  );
}
