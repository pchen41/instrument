// Contract test for parsePr: the github MCP's create_pull_request returns
// `{ id, url }` with NO `number` field, so the PR number must be derived from the
// URL's trailing /pull/<n>. Earlier this returned null → github_pr_unparsed, which
// failed every generation's first handoff attempt (recovered only on retry via
// list_pull_requests). The list/classic shapes (explicit number) stay covered.
import { describe, expect, it } from 'vitest';
import { parsePr } from './prgen-store';

describe('parsePr', () => {
  it('derives the number from the URL when create_pull_request omits `number`', () => {
    const pr = parsePr('{"id":"3819943139","url":"https://github.com/pchen41/instrument/pull/3"}');
    expect(pr).toEqual({ number: 3, url: 'https://github.com/pchen41/instrument/pull/3', nodeId: null });
  });

  it('uses the explicit number + html_url (list_pull_requests / classic shape)', () => {
    const pr = parsePr('{"number":5,"html_url":"https://github.com/o/r/pull/5","node_id":"PR_x"}');
    expect(pr).toMatchObject({ number: 5, url: 'https://github.com/o/r/pull/5', nodeId: 'PR_x' });
  });

  it('reads a nested pull_request envelope', () => {
    expect(parsePr('{"pull_request":{"number":7,"html_url":"https://github.com/o/r/pull/7"}}')?.number).toBe(7);
  });

  it('returns null when no number is present and the url has no /pull/<n>', () => {
    expect(parsePr('{"id":"9","url":"https://github.com/o/r"}')).toBeNull();
  });

  it('returns null on a non-JSON response', () => {
    expect(parsePr('Created PR successfully')).toBeNull();
  });
});
