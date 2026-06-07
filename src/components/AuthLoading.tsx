/**
 * Calm full-screen loading state shown while the auth session rehydrates on a
 * cold load. Uses the warm-paper background so a refresh on a console route
 * does not flash the sign-in page before the session resolves.
 */
export function AuthLoading() {
  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '14px',
        background: 'var(--paper)',
        color: 'var(--ink-3)',
      }}
    >
      <img
        src="/assets/logo-mark.svg"
        alt=""
        width={36}
        height={36}
        className="pulse"
      />
      <span style={{ fontSize: '13.5px' }}>Loading your workspace…</span>
    </div>
  );
}
