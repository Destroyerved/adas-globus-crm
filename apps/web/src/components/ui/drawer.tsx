import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Right-side drawer (DESIGN 6.2, 6.11): 480px, full width on phones, over a navy scrim.
 * Focus moves into the drawer and stays there, Escape closes it, and focus returns to the
 * control that opened it.
 */
export function Drawer({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  width = 480,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    );
    (first ?? panel)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (!firstEl || !lastEl) return;
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end fade-in"
      style={{ backgroundColor: 'var(--scrim)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ boxShadow: 'var(--shadow-dialog)', maxWidth: `${width}px` }}
        className="drawer-panel w-full h-full bg-surface flex flex-col outline-none"
      >
        <header className="flex items-start justify-between gap-[12px] px-[20px] py-[16px] border-b border-line">
          <div className="min-w-0">
            <h2 className="text-title text-ink m-0">{title}</h2>
            {description && <p className="m-0 mt-[2px] text-[13px] text-ink-3">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex items-center justify-center h-[32px] w-[32px] rounded-pill bg-transparent hover:bg-bg-alt text-ink-2 border-0 cursor-pointer shrink-0"
          >
            <X size={18} strokeWidth={1.6} aria-hidden="true" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-[20px] py-[16px]">{children}</div>
        {footer && (
          <footer className="px-[20px] py-[14px] border-t border-line flex flex-wrap justify-end gap-[8px]">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
