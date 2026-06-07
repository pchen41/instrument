import { describe, expect, it } from 'vitest';
import {
  ARCHIVED_RECOMMENDATION_STATES,
  incidentDisplayState,
  listActiveIncidents,
  listActiveRecommendations,
  listArchivedRecommendations,
  listResolvedIncidents,
} from './reads';

// Chainable recorder mimicking the SDK query builder so we can assert the query
// shape (table + filters) without a live backend.
function mockClient() {
  const calls: unknown[][] = [];
  const recorder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order']) {
    recorder[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return recorder;
    };
  }
  const client = {
    database: {
      from(table: string) {
        calls.push(['from', table]);
        return recorder;
      },
    },
  };
  return { client: client as never, calls };
}

describe('incidentDisplayState', () => {
  it('is "new" when there is no investigation job', () => {
    expect(incidentDisplayState({ investigation_job_id: null }, null)).toBe('new');
  });
  it('is "complete" when the job succeeded', () => {
    expect(incidentDisplayState({ investigation_job_id: 'j' }, { state: 'succeeded' })).toBe('complete');
  });
  it('is "failed" when the job failed', () => {
    expect(incidentDisplayState({ investigation_job_id: 'j' }, { state: 'failed' })).toBe('failed');
  });
  it.each(['queued', 'running', 'retrying'] as const)('is "investigating" when job is %s', (state) => {
    expect(incidentDisplayState({ investigation_job_id: 'j' }, { state })).toBe('investigating');
  });
});

describe('list query shapes', () => {
  it('listActiveIncidents filters incident_state=active on incidents', () => {
    const { client, calls } = mockClient();
    listActiveIncidents(client);
    expect(calls).toContainEqual(['from', 'incidents']);
    expect(calls).toContainEqual(['eq', 'incident_state', 'active']);
  });

  it('listResolvedIncidents filters incident_state=resolved', () => {
    const { client, calls } = mockClient();
    listResolvedIncidents(client);
    expect(calls).toContainEqual(['eq', 'incident_state', 'resolved']);
  });

  it('listActiveRecommendations filters state=active on recommendations', () => {
    const { client, calls } = mockClient();
    listActiveRecommendations(client);
    expect(calls).toContainEqual(['from', 'recommendations']);
    expect(calls).toContainEqual(['eq', 'state', 'active']);
  });

  it('listArchivedRecommendations filters state in the archived set', () => {
    const { client, calls } = mockClient();
    listArchivedRecommendations(client);
    const inCall = calls.find((c) => c[0] === 'in');
    expect(inCall?.[1]).toBe('state');
    expect(inCall?.[2]).toEqual([...ARCHIVED_RECOMMENDATION_STATES]);
  });
});
