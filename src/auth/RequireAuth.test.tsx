import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthContext, type AuthContextValue } from './AuthProvider';
import { RequireAuth } from './RequireAuth';

function makeAuth(partial: Partial<AuthContextValue>): AuthContextValue {
  return {
    user: null,
    loading: false,
    signIn: vi.fn(async () => ({ ok: true })),
    signOut: vi.fn(async () => {}),
    ...partial,
  };
}

function renderGuarded(auth: AuthContextValue) {
  return render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={['/incidents']}>
        <Routes>
          <Route path="/sign-in" element={<div>SIGN IN PAGE</div>} />
          <Route
            path="/incidents"
            element={
              <RequireAuth>
                <div>PROTECTED CONSOLE</div>
              </RequireAuth>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('RequireAuth', () => {
  it('redirects an unauthenticated user to sign-in', () => {
    renderGuarded(makeAuth({ user: null, loading: false }));
    expect(screen.getByText('SIGN IN PAGE')).toBeInTheDocument();
    expect(screen.queryByText('PROTECTED CONSOLE')).not.toBeInTheDocument();
  });

  it('renders the protected content for an authenticated user', () => {
    renderGuarded(makeAuth({ user: { id: 'u1' }, loading: false }));
    expect(screen.getByText('PROTECTED CONSOLE')).toBeInTheDocument();
    expect(screen.queryByText('SIGN IN PAGE')).not.toBeInTheDocument();
  });

  it('shows neither while auth is still resolving (no sign-in flash)', () => {
    renderGuarded(makeAuth({ user: null, loading: true }));
    expect(screen.queryByText('SIGN IN PAGE')).not.toBeInTheDocument();
    expect(screen.queryByText('PROTECTED CONSOLE')).not.toBeInTheDocument();
  });
});
