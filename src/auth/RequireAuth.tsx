import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';
import { protectedRouteDecision } from './guard';
import { AuthLoading } from '../components/AuthLoading';

/**
 * Route guard for authenticated-only routes. Unauthenticated users are sent to
 * the sign-in page (preserving where they were headed); while auth is still
 * resolving a calm loading state is shown so a refresh on a console route does
 * not flash the sign-in page before the session rehydrates.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const decision = protectedRouteDecision({ user, loading });

  if (decision === 'loading') {
    return <AuthLoading />;
  }
  if (decision === 'redirect') {
    return <Navigate to="/sign-in" replace state={{ from: location }} />;
  }
  return <>{children}</>;
}
