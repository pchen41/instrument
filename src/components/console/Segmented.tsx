import { Icon } from '../Icon';

export interface SegOption<T extends string> {
  id: T;
  label: string;
  icon?: string;
  count?: number;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (id: T) => void;
  options: SegOption<T>[];
  ariaLabel: string;
}

/**
 * Single-select segmented control (Active/Resolved, Open/Archive). Exposed as an
 * ARIA radiogroup so the choice is announced and arrow-key navigable, matching
 * the prototype's `.seg` look.
 */
export function Segmented<T extends string>({ value, onChange, options, ariaLabel }: SegmentedProps<T>) {
  // Roving selection: arrow keys both select and move DOM focus to the new
  // option, per the ARIA radiogroup pattern.
  const move = (delta: number, group: HTMLElement | null) => {
    const i = options.findIndex((o) => o.id === value);
    const nextIndex = (i + delta + options.length) % options.length;
    const next = options[nextIndex];
    if (!next) return;
    onChange(next.id);
    const radios = group?.querySelectorAll<HTMLElement>('[role="radio"]');
    radios?.[nextIndex]?.focus();
  };
  return (
    <div className="seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={on ? 'on' : ''}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(1, e.currentTarget.parentElement);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(-1, e.currentTarget.parentElement);
              }
            }}
          >
            {o.icon && <Icon name={o.icon} />}
            {o.label}
            {typeof o.count === 'number' && <span className="seg-count">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
