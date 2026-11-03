import { type HTMLAttributes, type ReactNode } from 'react';

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  actions?: ReactNode;
  padded?: boolean;
  children: ReactNode;
}

export function Panel({
  title,
  actions,
  padded = true,
  className = '',
  children,
  ...props
}: PanelProps) {
  return (
    <div
      className={`bg-surface border border-line rounded-[10px] ${padded ? 'p-[20px]' : ''} ${className}`.trim()}
      {...props}
    >
      {(title || actions) && (
        <div
          className={`flex items-center justify-between gap-[12px] ${padded ? 'mb-[16px]' : 'px-[20px] pt-[16px] pb-[12px] border-b border-line'}`}
        >
          {title && <h2 className="text-title text-ink m-0">{title}</h2>}
          {actions && <div className="flex items-center gap-[8px]">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export type CalloutTone = 'brand' | 'warning' | 'danger';

const CALLOUT_TONE_CLASSES: Record<CalloutTone, string> = {
  brand: 'bg-tint border-l-[3px] border-l-primary text-ink',
  warning: 'bg-warning-bg border-l-[3px] border-l-warning text-warning',
  danger: 'bg-danger-bg border-l-[3px] border-l-danger text-danger',
};

export interface CalloutProps {
  tone?: CalloutTone;
  children: ReactNode;
  className?: string;
}

export function Callout({ tone = 'brand', children, className = '' }: CalloutProps) {
  return (
    <div
      className={`rounded-r-[10px] px-[16px] py-[12px] text-[14px] ${CALLOUT_TONE_CLASSES[tone]} ${className}`.trim()}
    >
      {children}
    </div>
  );
}
