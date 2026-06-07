import { useEffect, useId, useState } from 'react';
import { Icon } from '../../components/Icon';
import type { InvestigationStartMode } from '../../data/reads';

// Investigation-start policy. Copy is honest about the boundary: investigations
// only ever READ — a fix is never generated automatically, regardless of mode.
interface ModeDef {
  id: InvestigationStartMode;
  short: string;
  label: string;
  desc: string;
  spark?: boolean;
}

export const AUTO_MODES: ModeDef[] = [
  {
    id: 'manual',
    short: 'Manual',
    label: 'Manual',
    desc: 'Every investigation waits for you to press Investigate.',
  },
  {
    id: 'auto',
    short: 'Automatic',
    label: 'Automatic',
    desc: 'Instrument starts investigating every firing alert the moment it arrives.',
  },
  {
    id: 'smart',
    short: 'Instrument decides',
    label: 'Let Instrument decide',
    spark: true,
    desc: 'Instrument starts on its own for important alerts, and waits for you when the situation looks ambiguous.',
  },
];

export interface AutoInvestigateMenuProps {
  value: InvestigationStartMode;
  onChange: (mode: InvestigationStartMode) => void;
  saving?: boolean;
}

/**
 * The investigation-start setting control. Selecting a mode persists it on the
 * workspace (the parent owns the write + optimistic state); changing it never
 * touches investigations already in flight.
 */
export function AutoInvestigateMenu({ value, onChange, saving }: AutoInvestigateMenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const current = AUTO_MODES.find((m) => m.id === value) ?? AUTO_MODES[0];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="ai-menu-wrap">
      <button
        type="button"
        className={'btn btn-secondary btn-sm ai-trigger' + (open ? ' on' : '')}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title="Investigation start"
      >
        <Icon name="search" />
        <span className="ai-trigger-label">{current.short}</span>
        {saving ? <span className="gen-spin" /> : <Icon name="chevron-down" className="ai-caret" />}
      </button>
      {open && (
        <>
          <div className="menu-catch" onClick={() => setOpen(false)} />
          <div className="ai-pop" role="menu" id={menuId} aria-label="Investigation start">
            <div className="ai-pop-head">Investigation start</div>
            <p className="ai-pop-sub">
              When an alert fires, decide whether Instrument waits for you or starts looking on its
              own. Investigations only read your systems — a fix is never generated automatically.
            </p>
            <div className="ai-opts">
              {AUTO_MODES.map((m) => {
                const on = m.id === value;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={'ai-opt' + (on ? ' on' : '')}
                    role="menuitemradio"
                    aria-checked={on}
                    onClick={() => {
                      onChange(m.id);
                      setOpen(false);
                    }}
                  >
                    <span className={'ai-radio' + (on ? ' on' : '')} />
                    <span className="ai-opt-body">
                      <span className="ai-opt-label">
                        {m.label}
                        {m.spark && <Icon name="sparkle" className="ai-opt-spark" />}
                      </span>
                      <span className="ai-opt-desc">{m.desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
