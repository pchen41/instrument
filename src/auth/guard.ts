// Pure route-guard decision logic, separated from the React components so it can
// be unit-tested directly.

export interface AuthState {
  user: unknown | null;
  loading: boolean;
}

export type GuardDecision = 'loading' | 'redirect' | 'allow';

/**
 * Decide what a protected (authenticated-only) route should do:
 * - while auth is still resolving → 'loading'
 * - no user once resolved → 'redirect' (to sign-in)
 * - user present → 'allow'
 */
export function protectedRouteDecision({ user, loading }: AuthState): GuardDecision {
  if (loading) return 'loading';
  return user ? 'allow' : 'redirect';
}

/**
 * Decide what the sign-in route should do for an already-signed-in user:
 * - while auth is still resolving → 'loading'
 * - user present → 'redirect' (into the console)
 * - no user → 'allow' (show the sign-in form)
 */
export function signInRouteDecision({ user, loading }: AuthState): GuardDecision {
  if (loading) return 'loading';
  return user ? 'redirect' : 'allow';
}
