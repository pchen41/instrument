import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAuth } from './auth/RequireAuth';
import { SignIn } from './routes/SignIn';
import { ConsoleLayout } from './routes/console/ConsoleLayout';
import { Incidents } from './routes/console/Incidents';
import { Recommendations } from './routes/console/Recommendations';
import { Integrations } from './routes/console/Integrations';
import { telemetry } from './lib/telemetry';

/** Reports client-side route changes to the telemetry wrapper (no-op if RUM off). */
function RouteTelemetry() {
  const location = useLocation();
  useEffect(() => {
    telemetry.recordRouteChange(location.pathname);
  }, [location.pathname]);
  return null;
}

export function App() {
  return (
    <AuthProvider>
      <RouteTelemetry />
      <Routes>
        <Route path="/sign-in" element={<SignIn />} />
        <Route
          element={
            <RequireAuth>
              <ConsoleLayout />
            </RequireAuth>
          }
        >
          <Route path="/incidents" element={<Incidents />} />
          <Route path="/recommendations" element={<Recommendations />} />
          <Route path="/integrations" element={<Integrations />} />
        </Route>
        {/* Default + unknown routes land on the primary console section; the
            guard sends unauthenticated users to sign-in. */}
        <Route path="/" element={<Navigate to="/incidents" replace />} />
        <Route path="*" element={<Navigate to="/incidents" replace />} />
      </Routes>
    </AuthProvider>
  );
}
