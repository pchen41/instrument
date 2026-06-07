import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from '../Icon';

// A single document-level Escape listener drives a stack of open overlays, so a
// confirm opened on top of a drawer closes only the confirm — not both at once.
const escapeStack: Array<() => void> = [];
let escapeListenerInstalled = false;
function ensureEscapeListener() {
  if (escapeListenerInstalled || typeof document === 'undefined') return;
  escapeListenerInstalled = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const top = escapeStack[escapeStack.length - 1];
    if (top) {
      e.stopPropagation();
      top();
    }
  });
}

function useEscape(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    ensureEscapeListener();
    const handler = () => ref.current();
    escapeStack.push(handler);
    return () => {
      const i = escapeStack.indexOf(handler);
      if (i >= 0) escapeStack.splice(i, 1);
    };
  }, []);
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Move focus into the overlay on open, keep Tab/Shift+Tab cycling within it
 * (aria-modal demands the trap), and restore focus to the trigger on close.
 */
function useModalFocus<T extends HTMLElement>(initialFocus: () => void) {
  const containerRef = useRef<T>(null);
  useEffect(() => {
    const previously = document.activeElement as HTMLElement | null;
    initialFocus();
    const el = containerRef.current;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !el) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !el.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !el.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    el?.addEventListener('keydown', onKeyDown);
    return () => {
      el?.removeEventListener('keydown', onKeyDown);
      previously?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return containerRef;
}

export interface ConfirmDialogProps {
  icon?: string;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  confirmIcon?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Calm, centered confirmation. Instrument never acts on your systems without an
 * explicit OK, so destructive / outward actions pass through here. Accessible:
 * role="dialog", aria-modal, labelled by its title, Escape (topmost only) +
 * scrim cancel, focus trapped, and focus moved to the confirm button on open.
 */
export function ConfirmDialog({
  icon = 'info',
  title,
  body,
  confirmLabel = 'Confirm',
  confirmIcon,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEscape(onCancel);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const containerRef = useModalFocus<HTMLDivElement>(() => confirmRef.current?.focus());
  const titleId = useId();
  return (
    <>
      <div className="scrim" onClick={onCancel} />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={containerRef}>
        <div className="m-ic">
          <Icon name={icon} />
        </div>
        <h3 id={titleId}>{title}</h3>
        <div className="m-body">{body}</div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="btn btn-primary" ref={confirmRef} onClick={onConfirm}>
            {confirmIcon && <Icon name={confirmIcon} />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}

export interface DrawerProps {
  icon?: string;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}

/**
 * Right-side detail drawer. Accessible: role="dialog", aria-modal, labelled by
 * its header, Escape (topmost only) + scrim close, focus trapped, and focus
 * moved to the close button on open.
 */
export function Drawer({ icon, title, children, footer, onClose }: DrawerProps) {
  useEscape(onClose);
  const closeRef = useRef<HTMLButtonElement>(null);
  const containerRef = useModalFocus<HTMLDivElement>(() => closeRef.current?.focus());
  const titleId = useId();
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={containerRef}>
        <div className="drawer-head">
          {icon && <Icon name={icon} style={{ fontSize: '20px', color: 'var(--brand-600)' }} />}
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="icon-btn"
            ref={closeRef}
            aria-label="Close"
            style={{ marginLeft: 'auto', border: 'none', background: 'transparent' }}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </>
  );
}
