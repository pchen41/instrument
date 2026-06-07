import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Segmented } from './Segmented';

function setup(value: 'active' | 'resolved' = 'active') {
  const onChange = vi.fn();
  render(
    <Segmented
      ariaLabel="Incident filter"
      value={value}
      onChange={onChange}
      options={[
        { id: 'active', label: 'Active', icon: 'signal' },
        { id: 'resolved', label: 'Resolved', icon: 'check-circle' },
      ]}
    />,
  );
  return { onChange };
}

describe('Segmented control accessibility', () => {
  it('is a labelled radiogroup with a checked radio', () => {
    setup('active');
    const group = screen.getByRole('radiogroup', { name: 'Incident filter' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Active' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Resolved' })).toHaveAttribute('aria-checked', 'false');
  });

  it('selects on click', () => {
    const { onChange } = setup('active');
    fireEvent.click(screen.getByRole('radio', { name: 'Resolved' }));
    expect(onChange).toHaveBeenCalledWith('resolved');
  });

  it('moves selection with the arrow keys', () => {
    const { onChange } = setup('active');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Active' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('resolved');
  });
});
