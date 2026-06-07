import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { insforge, insforgeAnonKey, insforgeUrl } from '../lib/insforge';
import { telemetry } from '../lib/telemetry';

// The SDK keeps the session in memory + an httpOnly refresh cookie. Our SPA is
// served from a different domain than the API (…insforge.site vs …insforge.app),
// so that cookie is third-party and a page reload can't refresh through it. We
// instead persist the refresh token and re-mint the session on load via the
// token-based ("mobile") refresh endpoint, which needs no cookie. This is the
// standard token-in-storage tradeoff for a cross-domain SPA: it's a user session
// token (not an admin/provider secret), browser-scoped, and never committed.
const REFRESH_TOKEN_KEY = 'instrument.insforge.refresh_token';

function storeRefreshToken(token: string | null | undefined): void {
  try {
    if (token) localStorage.setItem(REFRESH_TOKEN_KEY, token);
  } catch {
    /* storage unavailable (private mode); session just won't persist */
  }
}
function clearStoredRefreshToken(): void {
  try {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Re-mint an SDK session from the persisted refresh token. Returns the user or null. */
async function restoreSession(): Promise<AuthUser | null> {
  let refreshToken: string | null = null;
  try {
    refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
  if (!refreshToken) return null;
  try {
    const res = await fetch(`${insforgeUrl}/api/auth/refresh?client_type=mobile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${insforgeAnonKey}` },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      clearStoredRefreshToken();
      return null;
    }
    const data = (await res.json()) as {
      accessToken?: string;
      refreshToken?: string;
      user?: AuthUser;
    };
    if (!data.accessToken) {
      clearStoredRefreshToken();
      return null;
    }
    // Seed every SDK surface (database/storage/realtime) with the fresh token,
    // and hand the SDK the rotated refresh token for in-session auto-refresh.
    insforge.setAccessToken(data.accessToken);
    if (data.refreshToken) {
      insforge.getHttpClient().setRefreshToken(data.refreshToken);
      storeRefreshToken(data.refreshToken);
    }
    return data.user ?? null;
  } catch {
    return null;
  }
}

// Shape we rely on from an InsForge user. The SDK returns more fields; we keep
// this loose and only read what the shell needs.
export interface AuthUser {
  id: string;
  email?: string;
  name?: string;
  profile?: { name?: string; avatar_url?: string } | null;
  [key: string]: unknown;
}

export interface SignInResult {
  ok: boolean;
  error?: string;
}

export interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Rehydrate the session on mount. On a cold load the SDK refreshes via the
  // httpOnly cookie, so a page refresh on a console route keeps the user signed
  // in. `user` is briefly null during this round-trip — gate UI on `loading`.
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    (async () => {
      try {
        const restored = await restoreSession();
        if (cancelled.current) return;
        setUser(restored);
      } catch {
        if (!cancelled.current) setUser(null);
      } finally {
        if (!cancelled.current) setLoading(false);
      }
    })();
    return () => {
      cancelled.current = true;
    };
  }, []);

  const signIn = useCallback(
    async (email: string, password: string): Promise<SignInResult> => {
      try {
        const { data, error } = await insforge.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) {
          telemetry.recordUserActionFailure('sign_in', error);
          return { ok: false, error: error.message || 'Sign in failed.' };
        }
        const session = data as { user?: AuthUser; refreshToken?: string } | null;
        // Persist the refresh token so a page reload can re-mint the session
        // (the SDK already holds it in memory for this tab).
        storeRefreshToken(session?.refreshToken);
        setUser(session?.user ?? null);
        return { ok: true };
      } catch (err) {
        telemetry.recordUserActionFailure('sign_in', err);
        return { ok: false, error: 'Something went wrong. Please try again.' };
      }
    },
    [],
  );

  const signOut = useCallback(async () => {
    try {
      await insforge.auth.signOut();
    } catch (err) {
      telemetry.recordUserActionFailure('sign_out', err);
    } finally {
      clearStoredRefreshToken();
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, signIn, signOut }),
    [user, loading, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
