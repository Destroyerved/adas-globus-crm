import { Check, Plus, X } from 'lucide-react';

export interface FilterChipProps {
  label: string;
  value?: string;
  active?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
}

export function FilterChip({ label, value, active = false, onClick, onRemove }: FilterChipProps) {
  if (active && value) {
    return (
      <div className="inline-flex items-center h-[28px] rounded-pill bg-primary text-primary-foreground text-[13px] font-medium pl-[10px] pr-[6px] gap-[6px]">
        <Check size={14} strokeWidth={1.8} aria-hidden="true" />
        <button
          type="button"
          onClick={onClick}
          className="cursor-pointer bg-transparent border-0 p-0 text-inherit font-medium"
        >
          {label}: {value}
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${label} filter`}
            className="inline-flex items-center justify-center h-[20px] w-[20px] rounded-pill hover:bg-primary-ink cursor-pointer"
          >
            <X size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-[6px] h-[28px] px-[11px] rounded-pill bg-surface border border-line-strong hover:border-primary text-[13px] font-medium text-ink cursor-pointer transition-colors duration-120"
    >
      <span>{value ? `${label}: ${value}` : label}</span>
    </button>
  );
}

export function AddFilterChip({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-[5px] h-[28px] px-[10px] rounded-pill bg-transparent hover:bg-bg-alt text-[13px] font-medium text-ink-2 hover:text-ink cursor-pointer transition-colors duration-120"
    >
      <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
      <span>Add filter</span>
    </button>
  );
}
