import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const fx = vi.hoisted(() => {
  const card = (over: Record<string, unknown>) => ({
    id: 'r',
    title: 't',
    category: 'alert',
    state: 'active',
    service_name: 'svc',
    confidence: 'high',
    proposed_next_step: 'next',
    rationale: 'why',
    steps: [],
    outdated_reason: null,
    updated_at: '',
    ...over,
  });
  const active = [
    card({
      id: 'rec-multi',
      title: 'job-worker-tick has no alert on its retry rate',
      category: 'alert',
      steps: [
        {
          key: 'add-retry-metric',
          order: 0,
          kind: 'code_pr',
          state: 'ready',
          label: 'Add a retry-rate metric to job-worker-tick',
          generated_pr: { number: 12, branch: 'instrument/job-worker-retry-metric', url: 'https://github.com/pchen41/instrument/pull/12' },
        },
        {
          key: 'create-retry-monitor',
          order: 1,
          kind: 'datadog_new_monitor',
          state: 'locked',
          label: 'Alert when instrument.job.retry > 5/min',
          prerequisite_step_key: 'add-retry-metric',
          waits_for: 'the retry-metric PR (#12) is merged',
        },
      ],
    }),
    card({
      id: 'rec-review',
      title: 'PR #14 adds external-action-executor with no instrumentation',
      category: 'pr_review',
      steps: [
        { key: 'pr14-review', order: 0, kind: 'pr_review_record', state: 'done', label: '3 observability comments posted on PR #14' },
      ],
    }),
  ];
  const archive = [
    card({ id: 'rec-acc', state: 'accepted', title: 'Accepted metric', category: 'instrumentation', steps: [] }),
    card({ id: 'rec-dis', state: 'dismissed', title: 'Dismissed log verbosity', category: 'instrumentation', steps: [] }),
    card({ id: 'rec-out', state: 'outdated', title: 'Outdated span', category: 'instrumentation', steps: [], outdated_reason: 'The path no longer exists.' }),
  ];
  return { active, archive };
});

vi.mock('../../data/hooks', () => ({
  useRecommendationsView: (scope: 'active' | 'archive') => ({
    data: scope === 'active' ? fx.active : fx.archive,
    loading: false,
    error: null,
    refreshing: false,
    lastUpdatedAt: 1,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../data/actions', () => ({
  setRecommendationState: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { Recommendations } from './Recommendations';
import { setRecommendationState } from '../../data/actions';

describe('Recommendations — step locking + generated artifacts', () => {
  it('locks a dependent step until its prerequisite merges', () => {
    render(<Recommendations />);
    expect(screen.getByText('Unlocks when the retry-metric PR (#12) is merged')).toBeInTheDocument();
  });

  it('keeps the generated PR visible and linkable from the step', () => {
    render(<Recommendations />);
    expect(screen.getByRole('button', { name: /View PR #12/ })).toBeInTheDocument();
  });

  it('opens posted PR-review comments from a pr_review recommendation', () => {
    render(<Recommendations />);
    expect(screen.getByRole('button', { name: /View comments/ })).toBeInTheDocument();
  });

  it('dismisses a recommendation through the real action endpoint', () => {
    render(<Recommendations />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]);
    expect(setRecommendationState).toHaveBeenCalledWith('rec-multi', 'dismissed');
  });
});

describe('Recommendations — archive filter', () => {
  it('shows archived recommendations separately with state badges', () => {
    render(<Recommendations />);
    expect(screen.queryByText('Accepted metric')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Archive' }));
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('Dismissed')).toBeInTheDocument();
    expect(screen.getByText('Outdated')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restore/ })).toBeInTheDocument();
  });
});
