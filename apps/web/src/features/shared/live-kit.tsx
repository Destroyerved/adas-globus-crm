import { useMemo, type FormEvent, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { formatNumber } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { ApiError, api } from '@/lib/api.js';

/** Shared building blocks for screens that read live data (DESIGN 5.3, 6.2, 6.5, 6.13). */

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Try again.';
}

export function fieldError(err: unknown, field: string): string | undefined {
  return err instanceof ApiError ? err.fieldErrors[field]?.[0] : undefined;
}

/** Maps user IDs to display names for "Owner" columns. */
export function useUserNames(): (id: string | null | undefined) => string {
  const users = useQuery({ queryKey: ['users'], queryFn: api.listUsers, staleTime: 300_000 });
  return useMemo(() => {
    const byId = new Map((users.data ?? []).map((u) => [u.id, u.name]));
    return (id) => (id ? (byId.get(id) ?? '—') : '—');
  }, [users.data]);
}

export function PageHeader({
  kicker,
  title,
  count,
  actions,
}: {
  kicker: string;
  title: string;
  count?: number;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-[12px]">
      <div>
        <div className="kicker mb-[4px]">{kicker}</div>
        <h1 className="text-display text-ink m-0">
          <strong>{title}</strong>{' '}
          {count !== undefined && (
            <span className="text-ink-3 font-light tabular-nums">{formatNumber(count)}</span>
          )}
        </h1>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-[8px]">{actions}</div>}
    </div>
  );
}

export function SearchBox({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className="relative w-full sm:w-[320px]">
      <Search
        size={16}
        strokeWidth={1.6}
        aria-hidden="true"
        className="absolute left-[12px] top-1/2 -translate-y-1/2 text-ink-3"
      />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label}
        aria-label={label}
        className="pl-[36px]"
      />
    </div>
  );
}

/** A white panel that shows loading, error and empty states before its table. */
export function DataPanel<T>({
  query,
  isEmpty,
  emptyTitle,
  emptyDescription,
  emptyActionLabel,
  onEmptyAction,
  children,
}: {
  query: UseQueryResult<T>;
  isEmpty: boolean;
  emptyTitle: string;
  emptyDescription: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="bg-surface border border-line rounded-[10px] overflow-hidden">
      {query.isPending && <LoadingState rows={6} />}
      {query.isError && (
        <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      )}
      {query.isSuccess && isEmpty && (
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
          actionLabel={emptyActionLabel}
          actionVariant="primary"
          onAction={onEmptyAction}
        />
      )}
      {query.isSuccess && !isEmpty && <div className="relative overflow-x-auto">{children}</div>}
    </div>
  );
}

export const tableClass = 'w-full border-collapse text-left text-[14px]';
export const theadRowClass = 'h-[36px] border-b border-line text-label text-ink-3';
export const thClass = 'px-[12px] font-semibold whitespace-nowrap';
export const rowClass = 'h-[44px] border-b border-line last:border-b-0 hover:bg-bg-alt';
export const tdClass = 'px-[12px] py-[8px] align-middle';

export function Field({
  label,
  optional,
  error,
  children,
}: {
  label: string;
  optional?: boolean;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-[6px] text-label text-ink">
      <span>
        {label} {optional && <em className="not-italic font-normal text-ink-3">(optional)</em>}
      </span>
      {children}
      {error && <span className="text-[13px] font-normal text-danger">{error}</span>}
    </label>
  );
}

/** Inline create form shown above a list (DESIGN 6.2: label above field, server errors shown). */
export function CreateForm({
  title,
  submitLabel,
  pending,
  error,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (data: FormData) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const handle = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(new FormData(event.currentTarget));
  };
  return (
    <form
      onSubmit={handle}
      aria-label={title}
      className="bg-surface border border-line rounded-[10px] p-[20px] grid gap-[16px]"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-title text-ink m-0">{title}</h2>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close form">
          <X size={16} strokeWidth={1.6} aria-hidden="true" />
        </Button>
      </div>
      <div className="grid gap-[12px] sm:grid-cols-2">{children}</div>
      {error !== null && error !== undefined && (
        <p role="alert" className="m-0 text-[13px] text-danger">
          {errorMessage(error)}
        </p>
      )}
      <div className="flex gap-[8px]">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function str(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

export function matches(query: string, ...values: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return values.some((v) => v?.toLowerCase().includes(q));
}
