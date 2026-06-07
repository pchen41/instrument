import { Icon } from '../Icon';
import type { ConfidenceLevel } from '../../lib/schemas';
import type { IncidentDisplayState } from '../../data/reads';

// Two orthogonal axes, kept distinct on purpose (see the prototype's ui.jsx):
//  - ALERT STATE is relayed from the source (firing / resolved) — never an
//    Instrument judgment.
//  - ACTIVITY is what Instrument is doing about it (new / investigating /
//    complete / failed) — coexists with the alert state.

export type AlertState = 'firing' | 'resolved';

const ALERT_MAP: Record<AlertState, { cls: string; word: string }> = {
  firing: { cls: 'pill-crit', word: 'Firing' },
  resolved: { cls: 'pill-ok', word: 'Resolved' },
};

export const RULE_COLOR: Record<AlertState, string> = {
  firing: 'var(--crit)',
  resolved: 'var(--ok)',
};

export function Pill({ alert, label }: { alert: AlertState; label?: string }) {
  const m = ALERT_MAP[alert] ?? ALERT_MAP.firing;
  return (
    <span className={'pill ' + m.cls}>
      <span className="dot" />
      {label ?? m.word}
    </span>
  );
}

const ACTIVITY_WORDS: Record<IncidentDisplayState, string> = {
  new: 'New',
  investigating: 'Investigating',
  complete: 'Investigation complete',
  failed: 'Investigation failed',
};

/** What Instrument is doing about an alert, derived from durable job state. */
export function Activity({ kind = 'new', label }: { kind?: IncidentDisplayState; label?: string }) {
  const live = kind === 'investigating';
  const settled = kind === 'complete';
  const failed = kind === 'failed';
  const cls =
    'activity' +
    (settled ? ' activity-found' : '') +
    (failed ? ' activity-failed' : '') +
    (kind === 'new' ? ' activity-new' : '');
  return (
    <span className={cls}>
      <span className={'dot' + (live ? ' pulse' : '')} />
      {label ?? ACTIVITY_WORDS[kind]}
    </span>
  );
}

const CONFIDENCE_WORD: Record<ConfidenceLevel, string> = {
  high: 'High',
  likely: 'Likely',
  low: 'Low',
};

export function confidenceWord(level: ConfidenceLevel | null | undefined): string | null {
  return level ? CONFIDENCE_WORD[level] : null;
}

/** Confidence is a quiet attribute of a finding — a word, never a percentage. */
export function Confidence({ level }: { level: ConfidenceLevel | null | undefined }) {
  const word = confidenceWord(level);
  if (!word) return null;
  const tone = level === 'high' ? 'var(--ok-ink)' : level === 'likely' ? 'var(--info-ink)' : 'var(--ink-3)';
  return (
    <span className="conf-chip">
      <Icon name="gauge" />
      <span className="cw" style={{ color: tone }}>
        {word} confidence
      </span>
    </span>
  );
}

/** Marks an investigation that began without a human, per the start policy. */
export function AutoBadge() {
  return (
    <span className="auto-chip">
      <Icon name="sparkle" />
      Started automatically
    </span>
  );
}
