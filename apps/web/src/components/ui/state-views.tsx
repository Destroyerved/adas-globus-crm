import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from './button.js';
import { Callout } from './panel.js';

export interface EmptyStateProps {
  title: string;
  description: string;
  actionLabel?: string;
  actionVariant?: 'primary' | 'outline';
  onAction?: () => void;
}

/**
 * Centred empty state with the 2x2 glass-tile cluster (DESIGN.md §6.13).
 */
export function EmptyState({
  title,
  description,
  actionLabel,
  actionVariant = 'primary',
  onAction,
}: EmptyStateProps) {
  return (
    <div
      className="flex flex-col items-center justify-center text-center py-[48px] px-[20px]"
      data-testid="empty-state"
    >
      <div className="tile-cluster mb-[16px]" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <h2 className="text-title text-ink m-0">{title}</h2>
      <p className="text-body text-ink-2 mt-[6px] mb-0 max-w-[42ch]">{description}</p>
      {actionLabel && (
        <div className="mt-[16px]">
          <Button variant={actionVariant} onClick={onAction}>
            {actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Skeleton rows and blocks in --bg-alt with a slow shimmer (DESIGN.md §6.13).
 */
export function LoadingState({ rows = 6 }: { rows?: number }) {
  return (
    <div
      className="p-[20px] space-y-[12px]"
      role="status"
      aria-label="Loading records"
      data-testid="loading-state"
    >
      <span className="sr-only">Loading records…</span>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-[16px] py-[8px] border-b border-line last:border-b-0"
        >
          <div className="h-[16px] w-[16px] rounded-[4px] skeleton-shimmer shrink-0" />
          <div className="h-[14px] w-[180px] rounded-[4px] skeleton-shimmer" />
          <div className="h-[20px] w-[64px] rounded-pill skeleton-shimmer" />
          <div className="h-[14px] w-[120px] rounded-[4px] skeleton-shimmer hidden sm:block" />
          <div className="h-[14px] w-[90px] rounded-[4px] skeleton-shimmer ml-auto" />
        </div>
      ))}
    </div>
  );
}

export interface ErrorStateProps {
  message: string;
  requestId?: string;
  onRetry?: () => void;
}

/**
 * Inline danger callout with plain explanation, Retry button and mono request ID (DESIGN.md §6.13).
 */
export function ErrorState({
  message,
  requestId = 'req_01jc9x8k2m4p7v',
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="p-[20px]" data-testid="error-state">
      <Callout
        tone="danger"
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-[12px]"
      >
        <div className="flex items-start gap-[10px]">
          <AlertTriangle
            size={18}
            strokeWidth={1.6}
            className="shrink-0 mt-[2px]"
            aria-hidden="true"
          />
          <div>
            <p className="font-semibold m-0 text-danger">{message}</p>
            <p className="text-body-sm text-ink-2 mt-[4px] mb-0">
              Request ID: <span className="text-mono text-ink">{requestId}</span>
            </p>
          </div>
        </div>
        {onRetry && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="self-start sm:self-center"
          >
            <RotateCcw size={14} strokeWidth={1.6} aria-hidden="true" />
            <span>Retry</span>
          </Button>
        )}
      </Callout>
    </div>
  );
}
