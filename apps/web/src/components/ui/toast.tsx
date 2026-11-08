import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { type StatusTone } from '@adas/shared';

/**
 * Toasts (DESIGN 6.11): bottom-right, a 3px tone bar, dismissed after 5 seconds, paused on
 * hover, and announced through a polite live region (DESIGN 9.2).
 */

interface ToastItem {
  id: number;
  message: string;
  tone: StatusTone;
}

type ShowToast = (message: string, tone?: StatusTone) => void;

const ToastContext = createContext<ShowToast>(() => undefined);

const BAR: Record<StatusTone, string> = {
  neutral: 'var(--ink-3)',
  info: 'var(--info)',
  brand: 'var(--primary)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const schedule = useCallback(
    (id: number) => {
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), 5000),
      );
    },
    [dismiss],
  );

  const show = useCallback<ShowToast>(
    (message, tone = 'success') => {
      const id = nextId.current++;
      setToasts((all) => [...all.slice(-2), { id, message, tone }]);
      schedule(id);
    },
    [schedule],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="fixed bottom-[16px] right-[16px] left-[16px] sm:left-auto z-[60] flex flex-col items-end gap-[8px] pointer-events-none"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            onMouseEnter={() => {
              const timer = timers.current.get(t.id);
              if (timer) clearTimeout(timer);
            }}
            onMouseLeave={() => schedule(t.id)}
            style={{ boxShadow: 'var(--shadow-pop)', borderLeft: `3px solid ${BAR[t.tone]}` }}
            className="fade-in pointer-events-auto w-full sm:w-[360px] bg-surface rounded-[8px] px-[14px] py-[10px] text-[14px] text-ink flex items-start justify-between gap-[12px]"
          >
            <span>{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="text-[13px] font-semibold text-primary-ink bg-transparent border-0 p-0 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ShowToast {
  return useContext(ToastContext);
}
