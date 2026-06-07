import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthContext, type AuthContextValue } from '../../auth/AuthProvider';
import { ConsoleLayout } from './ConsoleLayout';

function renderShell(initialPath = '/incidents') {
  const auth: AuthContextValue = {
    user: { id: 'u1', email: 'rae@acme.io', name: 'Rae Alvarez' },
    loading: false,
    signIn: vi.fn(async () => ({ ok: true })),
    signOut: vi.fn(async () => {}),
  };

  return {
    auth,
    ...render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route element={<ConsoleLayout />}>
              <Route path="/incidents" element={<div>Incidents body</div>} />
              <Route path="/recommendations" element={<div>Recs body</div>} />
              <Route path="/integrations" element={<div>Integrations body</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    ),
  };
}

describe('Console shell', () => {
  it('renders the three navigation items', () => {
    renderShell();
    const nav = screen.getByRole('navigation');
    expect(nav).toHaveTextContent('Incidents');
    expect(nav).toHaveTextContent('Recommendations');
    expect(nav).toHaveTextContent('Integrations');
  });

  it('renders Instrument branding and the signed-in profile area', () => {
    renderShell();
    expect(screen.getByText('Instrument')).toBeInTheDocument();
    expect(screen.getByText('Rae Alvarez')).toBeInTheDocument();
    expect(screen.getByText('rae@acme.io')).toBeInTheDocument();
  });

  it('shows the connected sources list', () => {
    renderShell();
    // Datadog and GitHub are connected in the static demo config; TrueFoundry
    // is not, so it should not appear in the sidebar's connected list.
    expect(screen.getByText('Datadog')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.queryByText('TrueFoundry')).not.toBeInTheDocument();
  });

  it('marks the active section in the navigation', () => {
    renderShell('/recommendations');
    const active = screen.getByRole('link', { name: /Recommendations/ });
    expect(active.className).toContain('on');
  });
});
