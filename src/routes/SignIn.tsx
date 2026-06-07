import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { signInRouteDecision } from '../auth/guard';
import { validateSignIn, hasErrors, type SignInErrors } from '../auth/validation';
import { AuthLoading } from '../components/AuthLoading';
import { Icon } from '../components/Icon';

interface LocationState {
  from?: { pathname?: string };
}

/**
 * Sign-in-only demo auth entry, adapted from the auth prototype's minimal
 * variation. First-slice auth is username/password for a single configured
 * workspace — there is intentionally no signup toggle and no OAuth (PRD SEC-2,
 * SEC-3). Account creation / OAuth from the prototype are omitted.
 */
export function SignIn() {
  const { user, loading, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [touched, setTouched] = useState<{ email?: boolean; password?: boolean }>({});
  const [submitted, setSubmitted] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading'>('idle');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    document.title = 'Sign in · Instrument';
  }, []);

  const errors: SignInErrors = validateSignIn({ email, password });
  const showError = (k: keyof SignInErrors) =>
    (submitted || touched[k]) && errors[k] ? errors[k] : '';

  const redirectTo =
    (location.state as LocationState | null)?.from?.pathname || '/incidents';

  // Already-signed-in users skip the form. While auth resolves, show loading so
  // we don't flash the form before redirecting.
  const decision = signInRouteDecision({ user, loading });
  if (decision === 'loading') return <AuthLoading />;
  if (decision === 'redirect') return <Navigate to={redirectTo} replace />;

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setFormError('');
    setSubmitted(true);
    if (hasErrors(validateSignIn({ email, password }))) return;

    setStatus('loading');
    const result = await signIn(email, password);
    if (result.ok) {
      navigate(redirectTo, { replace: true });
    } else {
      setStatus('idle');
      setFormError(result.error || 'Email or password is incorrect.');
    }
  }

  return (
    <div className="auth-stage is-graph">
      <div className="auth-card">
        <div className="auth-body">
          <div className="auth-brand">
            <img src="/assets/logo-mark.svg" alt="" />
            <span className="wm">Instrument</span>
          </div>
          <h1 className="auth-title">Sign in</h1>
          <p className="auth-sub">Welcome back to your workspace.</p>

          <form className="auth-form" onSubmit={submit} noValidate>
            {formError && (
              <div className="auth-alert" role="alert">
                <Icon name="critical" />
                <span>
                  {formError} <strong>Check your details and try again.</strong>
                </span>
              </div>
            )}

            <div className="field">
              <div className="field-top">
                <label htmlFor="email">Work email</label>
              </div>
              <div
                className={
                  'control' +
                  (focus === 'email' ? ' is-focus' : '') +
                  (showError('email') ? ' is-error' : '')
                }
              >
                <input
                  id="email"
                  type="email"
                  value={email}
                  placeholder="you@company.com"
                  autoComplete="email"
                  spellCheck={false}
                  onChange={(e) => setEmail(e.target.value)}
                  onFocus={() => setFocus('email')}
                  onBlur={() => {
                    setTouched((t) => ({ ...t, email: true }));
                    setFocus(null);
                  }}
                />
              </div>
              {showError('email') && (
                <div className="field-msg">
                  <Icon name="warning" />
                  <span>{showError('email')}</span>
                </div>
              )}
            </div>

            <div className="field">
              <div className="field-top">
                <label htmlFor="password">Password</label>
              </div>
              <div
                className={
                  'control' +
                  (focus === 'password' ? ' is-focus' : '') +
                  (showError('password') ? ' is-error' : '')
                }
              >
                <input
                  id="password"
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  placeholder="Your password"
                  autoComplete="current-password"
                  spellCheck={false}
                  onChange={(e) => setPassword(e.target.value)}
                  onFocus={() => setFocus('password')}
                  onBlur={() => {
                    setTouched((t) => ({ ...t, password: true }));
                    setFocus(null);
                  }}
                />
                <button
                  type="button"
                  className="pw-toggle"
                  onClick={() => setShowPw((v) => !v)}
                  tabIndex={-1}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? 'Hide' : 'Show'}
                </button>
              </div>
              {showError('password') && (
                <div className="field-msg">
                  <Icon name="warning" />
                  <span>{showError('password')}</span>
                </div>
              )}
            </div>

            <button
              type="submit"
              className="auth-submit"
              disabled={status === 'loading'}
            >
              {status === 'loading' ? (
                <>
                  <span className="spinner" /> Signing in…
                </>
              ) : (
                <>
                  Sign in <Icon name="arrow-right" />
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
