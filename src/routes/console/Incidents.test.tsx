import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextValue } from '../../auth/AuthProvider';

// Fixtures hoisted so the vi.mock factory can reference them.
const fx = vi.hoisted(() => {
  const incident = (over: Record<string, unknown>) => ({
    id: 'x',
    title: 't',
    service_name: 'svc',
    alert_state: 'firing',
    incident_state: 'active',
    started_automatically: false,
    investigation_job_id: 'j',
    started_at: '2026-06-06T14:00:00Z',
    resolved_at: null,
    updated_at: '2026-06-06T14:00:00Z',
    ...over,
  });
  const activeRows = [
    { incident: incident({ id: 'a', title: 'New webhook alert', investigation_job_id: null }), job: null, display: 'new' },
    {
      incident: incident({ id: 'b', title: 'github-webhook climbing', started_automatically: true }),
      job: { id: 'j', state: 'running' },
      display: 'investigating',
    },
    {
      incident: incident({ id: 'c', title: 'mcp unreachable' }),
      job: { id: 'j2', state: 'failed' },
      display: 'failed',
    },
    {
      incident: incident({ id: 'd', title: 'TrueFoundry rate limits' }),
      job: { id: 'j3', state: 'succeeded' },
      display: 'complete',
    },
  ];
  const resolvedRows = [
    {
      incident: incident({ id: 'r', title: 'Resolved retry storm', incident_state: 'resolved', alert_state: 'resolved', resolved_at: '2026-06-06T12:05:00Z' }),
      job: { id: 'jr', state: 'succeeded' },
      display: 'complete',
    },
  ];
  const workspace = { id: 'ws1', slug: 'instrument', name: 'Instrument', investigation_start_mode: 'manual', updated_at: '' };
  return { activeRows, resolvedRows, workspace };
});

vi.mock('../../data/hooks', () => ({
  useIncidentsView: (scope: 'active' | 'resolved') => ({
    data: scope === 'active' ? fx.activeRows : fx.resolvedRows,
    loading: false,
    error: null,
    refreshing: false,
    lastUpdatedAt: 1,
    refetch: vi.fn(),
  }),
  useWorkspaceSettings: () => ({
    data: fx.workspace,
    loading: false,
    error: null,
    refreshing: false,
    lastUpdatedAt: 1,
    refetch: vi.fn(),
  }),
  useChangeFlash: () => false,
}));

import { Incidents } from './Incidents';

function renderIncidents() {
  const auth: AuthContextValue = {
    user: { id: 'u1', email: 'rae@acme.io' },
    loading: false,
    signIn: vi.fn(async () => ({ ok: true })),
    signOut: vi.fn(async () => {}),
  };
  return render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={['/incidents']}>
        <Incidents />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('Incidents list — job-state mapping', () => {
  it('maps each durable job state to its lifecycle marker', () => {
    renderIncidents();
    expect(screen.getByText('Investigating')).toBeInTheDocument();
    expect(screen.getByText('Investigation failed')).toBeInTheDocument();
    expect(screen.getByText('Investigation complete')).toBeInTheDocument();
    // No job → New, with an Investigate affordance instead of View investigation.
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Investigate/ })).toBeInTheDocument();
  });

  it('renders the "Started automatically" badge only for auto-started, non-new rows', () => {
    renderIncidents();
    expect(screen.getAllByText('Started automatically')).toHaveLength(1);
  });

  it('a failed row is failed, not an endless spinner, and links to the retryable detail', () => {
    renderIncidents();
    expect(screen.getByText(/preserved progress and retry/i)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /View investigation/ }).length).toBeGreaterThanOrEqual(3);
  });

  it('separates active and resolved incidents', () => {
    renderIncidents();
    expect(screen.queryByText('Resolved retry storm')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Resolved' }));
    expect(screen.getByText('Resolved retry storm')).toBeInTheDocument();
  });
});
