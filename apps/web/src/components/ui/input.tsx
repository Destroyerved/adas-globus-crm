import { forwardRef, type InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = '', invalid = false, ...props },
  ref,
) {
  const borderClass = invalid
    ? 'border-danger focus:border-danger'
    : 'border-line-field focus:border-primary';

  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={`h-[36px] w-full rounded-[8px] bg-surface border ${borderClass} px-[12px] text-[14px] text-ink placeholder:text-ink-3 transition-[border-color,box-shadow] duration-120 focus:outline-none ${className}`.trim()}
      {...props}
    />
  );
});
