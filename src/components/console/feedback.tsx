import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';

/** Centered loading state for a section's first load. */
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="load-state" role="status" aria-live="polite">
      <span className="gen-spin" />
      <span>{label}</span>
    </div>
  );
}

/** Calm error state with a retry affordance. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="empty" role="alert">
      <div className="ei err">
        <Icon name="warning" />
      </div>
      <h3>Couldn’t load this</h3>
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
          <Icon name="undo" />
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * Transient bottom toast for deferred (Task 5A) actions. Polite live region so a
 * screen reader announces it; auto-dismisses.
 */
export function Toast({ message, onDone, ms = 4200 }: { message: string; onDone: () => void; ms?: number }) {
  useEffect(() => {
    const t = setTimeout(onDone, ms);
    return () => clearTimeout(t);
  }, [onDone, ms]);
  return (
    <div className="toast" role="status" aria-live="polite">
      <Icon name="info" />
      <span>{message}</span>
    </div>
  );
}

/** Drives a single transient notice (the deferred-action toast). */
export function useTransientNotice() {
  const [notice, setNotice] = useState<string | null>(null);
  const idRef = useRef(0);
  const show = useCallback((message: string) => {
    idRef.current += 1;
    setNotice(message);
  }, []);
  const clear = useCallback(() => setNotice(null), []);
  return { notice, show, clear, key: idRef.current };
}
