/* Shared primitives for the Instrument console kit */

/* ── Axis 1: ALERT STATE — relayed from the source, never an Instrument
   judgment. Instrument doesn't know if a service is "down" or "degraded": it
   can't see the company's whole service graph or what the business impact is.
   What it knows for a fact is whether an alert is FIRING or has RESOLVED. Any
   impact wording belongs to the alert's own description (quoted), not here. */
const ALERT_MAP = {
  firing:   { cls: 'pill-crit', word: 'Firing'   },
  resolved: { cls: 'pill-ok',   word: 'Resolved' },
};
const RULE_COLOR = { firing: 'var(--crit)', resolved: 'var(--ok)' };

function Pill({ alert, label }) {
  const m = ALERT_MAP[alert] || ALERT_MAP.firing;
  return (
    <span className={'pill ' + m.cls}>
      <span className="dot"></span>
      {label || m.word}
    </span>
  );
}

/* ── Axis 2: ACTIVITY — what INSTRUMENT is doing about an alert. Orthogonal to
   the alert state, so it coexists with it. The lifecycle of an investigation:
   `new` (arrived, not yet looked at — quiet, no pulse) → `investigating`
   (a human asked Instrument to look; calm-blue breathing dot for the live look)
   → `complete` (the investigation finished; settled green). Never an alert color. */
function Activity({ kind = 'new', label }) {
  const words = {
    new: 'New',
    investigating: 'Investigating',
    complete: 'Investigation complete',
    watching: 'Watching',
    found: 'Root cause found',
  };
  const live = kind === 'investigating';
  const settled = kind === 'complete' || kind === 'found';
  const cls = 'activity'
    + (settled ? ' activity-found' : '')
    + (kind === 'new' ? ' activity-new' : '');
  return (
    <span className={cls}>
      <span className={'dot' + (live ? ' pulse' : '')}></span>
      {label || words[kind]}
    </span>
  );
}

/* Confidence is a quiet ATTRIBUTE of a finding — a word, never a percentage.
   A compact inline chip whose tone follows the word: High reads settled-green,
   Likely reads calm-blue, anything lower desaturates to ink. */
function Confidence({ word }) {
  const tone = word === 'High' ? 'var(--ok-ink)'
    : word === 'Likely' ? 'var(--info-ink)'
    : 'var(--ink-3)';
  return (
    <span className="conf-chip">
      <Icon name="gauge" />
      <span className="cw" style={{ color: tone }}>{word} confidence</span>
    </span>
  );
}

function Sparkle() {
  return <span className="tag tag-ai"><Icon name="sparkle" />Instrument</span>;
}

/* A calm, centered confirmation. Instrument never acts on your systems without
   an explicit OK — starting an investigation and generating a fix both pass
   through here. */
function ConfirmDialog({ icon = 'info', title, body, confirmLabel = 'Confirm', confirmIcon, cancelLabel = 'Cancel', onConfirm, onCancel }) {
  return (
    <React.Fragment>
      <div className="scrim" onClick={onCancel}></div>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="m-ic"><Icon name={icon} /></div>
        <h3>{title}</h3>
        <div className="m-body">{body}</div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onCancel}>{cancelLabel}</button>
          <button className="btn btn-primary" onClick={onConfirm}>{confirmIcon && <Icon name={confirmIcon} />}{confirmLabel}</button>
        </div>
      </div>
    </React.Fragment>
  );
}

function Icon({ name, className, style }) {
  const ph = window.Instrument.phClass(name);
  return <i className={'ph ' + ph + (className ? ' ' + className : '')} style={style} />;
}

/* A live phase checklist for any long-running Instrument job (investigating an
   incident, drafting a fix/PR/change). Each phase carries its own state so the
   user sees exactly where the job is — and, crucially, gets honest feedback when
   a call fails and Instrument is retrying it, rather than a blind spinner.
   States: 'pending' | 'active' | 'retrying' | 'done'. `note` surfaces the reason
   for a retry in calm, plain language. */
function GenProgress({ phases = [], note }) {
  return (
    <React.Fragment>
      <ol className="gen-steps">
        {phases.map((p, i) => (
          <li key={i} className={'gen-step ' + p.state}>
            <span className="gen-mark">
              {p.state === 'done'
                ? <Icon name="check" />
                : p.state === 'retrying'
                  ? <Icon name="undo" />
                  : p.state === 'active'
                    ? <span className="gen-spin"></span>
                    : <span className="gen-pend"></span>}
            </span>
            <span className="gen-label">{p.label}</span>
            {p.state === 'retrying' && <span className="gen-tag">Retrying</span>}
            {p.state === 'active' && <span className="gen-tag muted">Working</span>}
          </li>
        ))}
      </ol>
      {note && (
        <div className="gen-note">
          <Icon name="warning" />
          <span>{note}</span>
        </div>
      )}
    </React.Fragment>
  );
}

Object.assign(window, { Pill, Activity, Confidence, Sparkle, ConfirmDialog, Icon, GenProgress, ALERT_MAP, RULE_COLOR });
