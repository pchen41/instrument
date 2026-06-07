import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

/**
 * The console shell: a fixed sidebar plus the scrolling main column. Section
 * content renders directly through <Outlet>, matching the design's sidebar-only
 * chrome. The shell itself is static — section views own their (server-backed)
 * data.
 */
export function ConsoleLayout() {
  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <Outlet />
      </div>
    </div>
  );
}
