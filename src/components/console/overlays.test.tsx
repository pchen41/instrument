import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfirmDialog, Drawer } from './overlays';

describe('ConfirmDialog accessibility', () => {
  it('is a labelled modal dialog with focus on the confirm action', () => {
    render(
      <ConfirmDialog
        title="Start investigation?"
        confirmLabel="Investigate"
        body={<span>read-only</span>}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Start investigation?');
    expect(screen.getByRole('button', { name: 'Investigate' })).toHaveFocus();
  });

  it('cancels on Escape and on scrim click', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmDialog title="Confirm?" body={null} onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);

    const scrim = container.querySelector('.scrim') as HTMLElement;
    fireEvent.click(scrim);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('confirms when the confirm button is pressed', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="Confirm?" body={null} confirmLabel="Go" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('Drawer accessibility', () => {
  it('is a labelled modal dialog with a labelled close button', () => {
    render(
      <Drawer title="Pull request #12" icon="pr" onClose={vi.fn()}>
        <p>body</p>
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Pull request #12');
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Drawer title="Draft monitor" onClose={onClose}>
        <p>body</p>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes only the topmost overlay (a confirm over a drawer)', () => {
    const onClose = vi.fn();
    const onCancel = vi.fn();
    render(
      <>
        <Drawer title="Draft monitor" onClose={onClose}>
          <p>body</p>
        </Drawer>
        <ConfirmDialog title="Apply change?" body={null} onConfirm={vi.fn()} onCancel={onCancel} />
      </>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
