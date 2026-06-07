import type { ReactNode } from 'react';
import { Icon } from './Icon';

export interface EmptyStateProps {
  icon: string;
  title: string;
  children?: ReactNode;
}

/** Calm centered empty state, matching the prototype's `.empty` block. */
export function EmptyState({ icon, title, children }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="ei">
        <Icon name={icon} />
      </div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
