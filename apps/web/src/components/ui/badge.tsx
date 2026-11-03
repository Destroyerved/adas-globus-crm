import { type ReactNode } from 'react';
import { type Market, type StatusTone } from '@adas/shared';

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'bg-neutral-bg text-neutral',
  info: 'bg-info-bg text-info',
  brand: 'bg-brand-bg text-brand',
  success: 'bg-success-bg text-success',
  warning: 'bg-warning-bg text-warning',
  danger: 'bg-danger-bg text-danger',
};

export interface StatusBadgeProps {
  tone: StatusTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function StatusBadge({ tone, icon, children, className = '' }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-[5px] h-[22px] px-[9px] rounded-pill text-[12px] font-semibold leading-none whitespace-nowrap ${TONE_CLASSES[tone]} ${className}`.trim()}
    >
      {icon}
      <span>{children}</span>
    </span>
  );
}

export interface MarketBadgeProps {
  market: Market;
  className?: string;
}

export function MarketBadge({ market, className = '' }: MarketBadgeProps) {
  return (
    <span
      className={`inline-flex items-center justify-center h-[22px] px-[8px] rounded-pill bg-neutral-bg text-neutral text-[11.5px] font-[650] tracking-[0.06em] uppercase leading-none ${className}`.trim()}
    >
      {market}
    </span>
  );
}
