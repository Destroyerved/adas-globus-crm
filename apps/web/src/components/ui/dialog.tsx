import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Confirm dialog (DESIGN 6.11): it names the object, and the confirm button repeats the verb,
 * for example "Delete lead". Destructive actions keep the Danger fill; others pass
 * `tone="primary"`.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  pending,
  error,
  tone = 'danger',
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  pending?: boolean;
  error?: string | null;
  /** DESIGN 6.1: the danger fill is for destructive confirmations only. */
  tone?: 'danger' | 'primary';
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    if (!open) return undefined;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancel.current();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[55] grid place-items-center p-[16px] fade-in"
      style={{ backgroundColor: 'var(--scrim)' }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        style={{ boxShadow: 'var(--shadow-dialog)' }}
        className="w-full max-w-[480px] bg-surface rounded-[14px] p-[24px] space-y-[16px]"
      >
        <h2 className="text-title text-ink m-0">{title}</h2>
        <div className="text-[14px] text-ink-2">{body}</div>
        {error && (
          <p role="alert" className="m-0 text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-[8px]">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="inline-flex items-center h-[36px] px-[16px] rounded-pill bg-transparent text-ink-2 hover:bg-bg-alt hover:text-ink font-medium text-[14px] border-0 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending || confirmDisabled}
            className={`inline-flex items-center h-[36px] px-[16px] rounded-pill text-primary-foreground font-semibold text-[14px] border-0 cursor-pointer disabled:opacity-50 ${tone === 'danger' ? 'bg-danger' : 'bg-primary hover:bg-primary-ink'}`}
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
