import { forwardRef, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

/** Native select and textarea styled as DESIGN 6.2 form controls (36px, radius 8). */
export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(function Select({ className = '', invalid = false, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={`h-[36px] w-full rounded-[8px] bg-surface border ${invalid ? 'border-danger' : 'border-line-field focus:border-primary'} px-[10px] text-[14px] text-ink focus:outline-none ${className}`.trim()}
      {...props}
    >
      {children}
    </select>
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ className = '', invalid = false, rows = 4, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={`w-full rounded-[8px] bg-surface border ${invalid ? 'border-danger' : 'border-line-field focus:border-primary'} px-[12px] py-[8px] text-[14px] text-ink placeholder:text-ink-3 focus:outline-none resize-y ${className}`.trim()}
      {...props}
    />
  );
});
