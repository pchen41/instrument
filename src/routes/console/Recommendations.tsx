import { EmptyState } from '../../components/EmptyState';

/**
 * Recommendations section. Server-backed recommendation reads and their
 * accept/dismiss lifecycle arrive in later tasks (4, 7); the scaffold renders
 * an empty container.
 */
export function Recommendations() {
  return (
    <div className="content narrow">
      <div className="page-head">
        <div>
          <h1>Recommendations</h1>
          <div className="sub">
            Preventative fixes Instrument found by reading the codebase and
            signals.
          </div>
        </div>
      </div>
      <EmptyState icon="lightbulb" title="No recommendations yet">
        Instrument keeps reading the codebase and signals for observability gaps
        worth hardening. Anything it finds will show up here for review.
      </EmptyState>
    </div>
  );
}
