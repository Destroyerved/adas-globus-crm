import { useQuery } from '@tanstack/react-query';
import { formatNumber, type ImportBatchStatus, type ImportBatchView } from '@adas/shared';
import { StatusBadge } from '@/components/ui/badge.js';
import { type Kpi } from '@/features/dashboard/dashboard-kit.js';
import { api } from '@/lib/api.js';

/** Shared parts of the Imports screens (PRD 4.9; DESIGN 6.4, 6.7). */

type Tone = 'neutral' | 'info' | 'brand' | 'success' | 'warning' | 'danger';

const STATUS: Record<ImportBatchStatus, { label: string; tone: Tone }> = {
  uploaded: { label: 'Not started', tone: 'neutral' },
  mapped: { label: 'Not started', tone: 'neutral' },
  checking: { label: 'Checking', tone: 'info' },
  checked: { label: 'Ready to import', tone: 'info' },
  queued: { label: 'Importing', tone: 'brand' },
  running: { label: 'Importing', tone: 'brand' },
  completed: { label: 'Imported', tone: 'success' },
  failed: { label: 'Stopped', tone: 'danger' },
  rolling_back: { label: 'Undoing', tone: 'warning' },
  rolled_back: { label: 'Undone', tone: 'neutral' },
};

export function ImportStatusBadge({ status }: { status: ImportBatchStatus }) {
  const s = STATUS[status];
  return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>;
}

/** Statuses the worker is busy with; the screen checks for progress every second. */
export const WORKING: readonly ImportBatchStatus[] = [
  'checking',
  'queued',
  'running',
  'rolling_back',
];

export function useImport(importId: string) {
  return useQuery({
    queryKey: ['imports', importId],
    queryFn: () => api.getImport(importId),
    refetchInterval: (query) =>
      query.state.data && WORKING.includes(query.state.data.status) ? 1000 : false,
  });
}

export const entityLabel = (batch: Pick<ImportBatchView, 'entity'>, plural = true) =>
  batch.entity === 'company' ? (plural ? 'Companies' : 'Company') : plural ? 'Contacts' : 'Contact';

/** The counts of a dry run or a run as KPI tiles. */
export function countTiles(
  counts: ImportBatchView['counts'],
  entity: ImportBatchView['entity'],
  done: boolean,
): Kpi[] {
  const n = (v: number | undefined) => formatNumber(v ?? 0);
  const what = entity === 'company' ? 'companies' : 'contacts';
  const tiles: Kpi[] = [
    { label: done ? `New ${what} added` : `New ${what} to add`, value: n(counts.created) },
    {
      label: done ? 'Existing records updated' : 'Existing records to update',
      value: n(counts.updated),
    },
    { label: 'Already in the CRM, left unchanged', value: n(counts.skipped) },
    { label: 'Repeated in the file', value: n(counts.duplicate) },
    {
      label: 'Possible duplicates for review',
      value: n(counts.probable),
      tone: (counts.probable ?? 0) > 0 ? 'warning' : undefined,
    },
    {
      label: 'Rows with errors',
      value: n(counts.error),
      tone: (counts.error ?? 0) > 0 ? 'danger' : undefined,
    },
  ];
  return tiles;
}

/** Plain progress bar with its numbers (DESIGN 6.13: no spinner for page work). */
export function ImportProgress({
  label,
  done,
  total,
}: {
  label: string;
  done: number;
  total: number;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="space-y-[8px]">
      <div className="flex items-baseline justify-between gap-[12px] text-[14px]">
        <span className="text-ink font-semibold">{label}</span>
        <span className="text-ink-2 tabular-nums">
          {formatNumber(done)} of {formatNumber(total)} rows
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-[8px] rounded-pill bg-bg-alt overflow-hidden"
      >
        <div
          className="h-full bg-primary transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** "120 added · 4 updated · 3 errors" for the list. */
export function resultSummary(batch: ImportBatchView): string {
  if (batch.status === 'rolled_back' && batch.undoCounts) {
    return `${formatNumber(batch.undoCounts.removed)} removed · ${formatNumber(batch.undoCounts.reverted)} reverted`;
  }
  const c = batch.status === 'checked' ? (batch.dryRunCounts ?? {}) : batch.counts;
  const parts: string[] = [];
  if (c.created)
    parts.push(`${formatNumber(c.created)} ${batch.status === 'checked' ? 'new' : 'added'}`);
  if (c.updated) parts.push(`${formatNumber(c.updated)} updated`);
  if (c.error) parts.push(`${formatNumber(c.error)} ${c.error === 1 ? 'error' : 'errors'}`);
  return parts.join(' · ');
}
