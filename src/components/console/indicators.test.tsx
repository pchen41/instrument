import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Activity, Confidence, Pill } from './indicators';

describe('Activity marker (durable job state → words)', () => {
  it('labels each display state', () => {
    const cases = [
      ['new', 'New'],
      ['investigating', 'Investigating'],
      ['complete', 'Investigation complete'],
      ['failed', 'Investigation failed'],
    ] as const;
    for (const [kind, word] of cases) {
      const { container } = render(<Activity kind={kind} />);
      expect(container.textContent).toContain(word);
    }
  });

  it('only the investigating marker pulses; failed reads crit-toned', () => {
    const live = render(<Activity kind="investigating" />).container;
    expect(live.querySelector('.dot.pulse')).not.toBeNull();

    const failed = render(<Activity kind="failed" />).container;
    expect(failed.querySelector('.activity-failed')).not.toBeNull();
    expect(failed.querySelector('.dot.pulse')).toBeNull();
  });
});

describe('Pill + Confidence', () => {
  it('renders the relayed alert state, not an Instrument judgment', () => {
    expect(render(<Pill alert="firing" />).container.textContent).toContain('Firing');
    expect(render(<Pill alert="resolved" />).container.textContent).toContain('Resolved');
  });

  it('renders confidence as a word, never a percentage', () => {
    const { container } = render(<Confidence level="high" />);
    expect(container.textContent).toContain('High confidence');
    expect(container.textContent).not.toMatch(/%/);
    expect(render(<Confidence level={null} />).container.textContent).toBe('');
  });
});
