import { type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'default' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-foreground border border-transparent hover:bg-primary-ink font-semibold',
  outline:
    'bg-transparent text-primary-ink border border-primary hover:bg-primary hover:text-primary-foreground font-semibold',
  ghost:
    'bg-transparent text-ink-2 border border-transparent hover:bg-bg-alt hover:text-ink font-medium',
  danger:
    'bg-danger text-primary-foreground border border-transparent hover:opacity-95 font-semibold',
  link: 'bg-transparent text-primary-ink border-0 p-0 h-auto font-semibold hover:underline underline-offset-4 group',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-[32px] px-[14px] text-[13px] rounded-pill',
  default: 'h-[36px] px-[16px] text-[14px] rounded-pill',
  lg: 'h-[40px] px-[20px] text-[14px] rounded-pill',
  icon: 'h-[32px] w-[32px] p-0 rounded-pill justify-center',
};

export function Button({
  variant = 'primary',
  size = 'default',
  className = '',
  type = 'button',
  children,
  ...props
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-[8px] whitespace-nowrap cursor-pointer select-none transition-[background-color,color,border-color,transform] duration-120 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none';
  const sizeClass = variant === 'link' ? '' : SIZE_CLASSES[size];

  return (
    <button
      type={type}
      className={`${base} ${VARIANT_CLASSES[variant]} ${sizeClass} ${className}`.trim()}
      {...props}
    >
      {children}
      {variant === 'link' && (
        <ArrowRight
          size={16}
          strokeWidth={1.6}
          className="transition-transform duration-200 group-hover:translate-x-[3px]"
          aria-hidden="true"
        />
      )}
    </button>
  );
}
