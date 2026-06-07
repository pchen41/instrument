import { Icon } from '../Icon';
import type { JobPhase } from '../../lib/schemas';

// A live phase checklist for a long-running Instrument job, rendered straight
// from durable jobs.phases. Each phase carries its own state so the user sees
// exactly where the job is — and, crucially, honest feedback when a call failed
// and Instrument is retrying (never a blind spinner). `note` surfaces the reason
// for a retry / failure in calm, plain language.

type GenState = 'pending' | 'active' | 'retrying' | 'done' | 'failed' | 'skipped';

const PHASE_TO_GEN: Record<JobPhase['state'], GenState> = {
  pending: 'pending',
  running: 'active',
  retrying: 'retrying',
  succeeded: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

function Mark({ state }: { state: GenState }) {
  if (state === 'done') return <Icon name="check" />;
  if (state === 'failed') return <Icon name="critical" />;
  if (state === 'retrying') return <Icon name="undo" />;
  if (state === 'active') return <span className="gen-spin" />;
  return <span className="gen-pend" />;
}

export function GenProgress({ phases, note }: { phases: JobPhase[]; note?: string | null }) {
  return (
    <>
      <ol className="gen-steps">
        {phases.map((p) => {
          const state = PHASE_TO_GEN[p.state] ?? 'pending';
          return (
            <li key={p.key} className={'gen-step ' + state}>
              <span className="gen-mark">
                <Mark state={state} />
              </span>
              <span className="gen-label">{p.label}</span>
              {state === 'retrying' && <span className="gen-tag">Retrying</span>}
              {state === 'active' && <span className="gen-tag muted">Working</span>}
              {state === 'failed' && <span className="gen-tag">Failed</span>}
            </li>
          );
        })}
      </ol>
      {note && (
        <div className="gen-note">
          <Icon name="warning" />
          <span>{note}</span>
        </div>
      )}
    </>
  );
}
