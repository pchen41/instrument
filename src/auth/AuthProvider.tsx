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
import { insforge } from '../lib/insforge';
import { telemetry } from '../lib/telemetry';

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
        const { data, error } = await insforge.auth.getCurrentUser();
        if (cancelled.current) return;
        setUser(error ? null : ((data?.user as AuthUser | undefined) ?? null));
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
        setUser((data?.user as AuthUser | undefined) ?? null);
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
