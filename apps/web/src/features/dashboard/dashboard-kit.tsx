import { useState, type ReactNode } from 'react';
import { type UseQueryResult } from '@tanstack/react-query';
import { formatNumber, type DeltaChip } from '@adas/shared';
import { Panel } from '@/components/ui/panel.js';
import { ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { type WidgetResult } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';

/** Building blocks for dashboard widgets (DESIGN 6.6, 6.7, 7). */

/** A widget panel with its own loading and error state, so one failure never blocks the page. */
export function WidgetPanel<T>({
  title,
  query,
  children,
  wide = false,
}: {
  title: string;
  query: UseQueryResult<WidgetResult<T>>;
  children: (data: T) => ReactNode;
  wide?: boolean;
}) {
  return (
    <Panel
      title={title}
      className={`min-w-0 ${wide ? 'lg:col-span-2' : ''}`}
      aria-busy={query.isFetching || undefined}
      data-testid="dashboard-widget"
    >
      {query.isPending && <LoadingState rows={3} />}
      {query.isError && (
        <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      )}
      {query.isSuccess && (
        <div className={query.isFetching ? 'opacity-70' : ''}>{children(query.data.data)}</div>
      )}
    </Panel>
  );
}

export interface Kpi {
  label: string;
  value: string;
  /** Where the number comes from; the tile opens it. */
  onOpen?: () => void;
  tone?: 'danger' | 'warning';
  /** Change vs the previous period (DESIGN 6.7: ▲/▼ arrow + signed value + tone, never colour alone). */
  delta?: DeltaChip | null;
}

const DELTA_STYLE: Record<DeltaChip['tone'], string> = {
  success: 'bg-success-bg text-success',
  danger: 'bg-danger-bg text-danger',
  neutral: 'bg-neutral-bg text-neutral',
};

const DELTA_ARROW: Record<DeltaChip['direction'], string> = {
  up: '▲',
  down: '▼',
  flat: '—',
};

export function DeltaBadge({ delta }: { delta: DeltaChip }) {
  return (
    <span
      data-testid="kpi-delta"
      className={`inline-flex items-center gap-[4px] mt-[4px] px-[7px] h-[20px] rounded-pill text-[11.5px] font-semibold tabular-nums ${DELTA_STYLE[delta.tone]}`}
    >
      <span aria-hidden="true">{DELTA_ARROW[delta.direction]}</span>
      <span>{delta.text}</span>
      <span className="sr-only"> vs previous period</span>
    </span>
  );
}

/**
 * KPI tiles in a row divided by 1px vertical rules (DESIGN 6.7). Tiles size to their number
 * and wrap, so a long amount takes its own row on a phone instead of being cut off; the
 * container hides the rule at the start of each row. A tile with onOpen opens its list.
 */
export function KpiRow({ items }: { items: Kpi[] }) {
  return (
    <div className="overflow-hidden">
      <div className="flex flex-wrap gap-y-[12px] -ml-px">
        {items.map((k) => {
          const body = (
            <>
              <span
                className={`text-kpi block whitespace-nowrap ${k.tone === 'danger' ? 'text-danger' : k.tone === 'warning' ? 'text-warning' : 'text-ink'}`}
              >
                {k.value}
              </span>
              <span className="block mt-[2px] text-[13px] text-ink-2 line-clamp-2">{k.label}</span>
              {k.delta && <DeltaBadge delta={k.delta} />}
              {k.onOpen && <span className="sr-only">, open the list</span>}
            </>
          );
          const cls = 'flex-auto min-w-[120px] border-l border-line px-[16px] py-[4px] text-left';
          return k.onOpen ? (
            <button
              key={k.label}
              type="button"
              onClick={k.onOpen}
              className={`${cls} bg-transparent border-y-0 border-r-0 rounded-none hover:bg-bg-alt cursor-pointer`}
            >
              {body}
            </button>
          ) : (
            <div key={k.label} className={cls}>
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface Bar {
  key: string;
  label: string;
  value: number;
  /** Text shown at the end of the bar, for example a money amount. */
  display?: string;
  detail?: string;
  muted?: boolean;
  onOpen?: () => void;
}

/**
 * A sorted horizontal bar list in one colour, with a "View as table" toggle and a text
 * summary for screen readers (DESIGN 7).
 */
export function BarList({
  title,
  bars,
  valueLabel = 'Count',
  empty,
}: {
  title: string;
  bars: Bar[];
  valueLabel?: string;
  empty: string;
}) {
  const [asTable, setAsTable] = useState(false);
  if (bars.length === 0) return <p className="m-0 text-[14px] text-ink-2">{empty}</p>;
  const max = Math.max(...bars.map((b) => b.value), 1);
  const summary = bars.map((b) => `${b.label}: ${b.display ?? formatNumber(b.value)}`).join('; ');
  return (
    <figure className="m-0">
      <figcaption className="flex items-center justify-between gap-[8px] mb-[8px]">
        <span className="text-label text-ink-3">{title}</span>
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
          className="bg-transparent border-0 p-0 text-[12.5px] font-semibold text-primary-ink cursor-pointer hover:underline"
        >
          {asTable ? 'View as chart' : 'View as table'}
        </button>
      </figcaption>
      <p className="sr-only">{summary}</p>
      {asTable ? (
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="border-b border-line text-label text-ink-3">
              <th className="text-left font-semibold py-[6px]">{title}</th>
              <th className="text-right font-semibold py-[6px]">{valueLabel}</th>
            </tr>
          </thead>
          <tbody>
            {bars.map((b) => (
              <tr key={b.key} className="border-b border-line last:border-b-0">
                <td className="py-[6px]">
                  {b.onOpen ? (
                    <button
                      type="button"
                      onClick={b.onOpen}
                      className="bg-transparent border-0 p-0 text-left text-ink hover:underline cursor-pointer"
                    >
                      {b.label}
                    </button>
                  ) : (
                    b.label
                  )}
                  {b.detail && <span className="text-ink-3"> · {b.detail}</span>}
                </td>
                <td className="py-[6px] text-right tabular-nums">
                  {b.display ?? formatNumber(b.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="m-0 p-0 list-none grid gap-[8px]" aria-hidden="true">
          {bars.map((b) => {
            const row = (
              <>
                <span className="flex justify-between gap-[8px] text-[13px]">
                  <span className="text-ink truncate">
                    {b.label}
                    {b.detail && <span className="text-ink-3"> · {b.detail}</span>}
                  </span>
                  <span className="text-ink-2 tabular-nums whitespace-nowrap">
                    {b.display ?? formatNumber(b.value)}
                  </span>
                </span>
                <span className="block h-[8px] mt-[4px] rounded-[2px] bg-bg-alt overflow-hidden">
                  <span
                    className={`block h-full rounded-[2px] ${b.muted ? 'bg-chart-muted' : 'bg-chart-1'}`}
                    style={{ width: `${Math.max(2, (b.value / max) * 100)}%` }}
                  />
                </span>
              </>
            );
            return (
              <li key={b.key}>
                {b.onOpen ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={b.onOpen}
                    className="w-full bg-transparent border-0 p-0 text-left cursor-pointer hover:opacity-80"
                  >
                    {row}
                  </button>
                ) : (
                  row
                )}
              </li>
            );
          })}
        </ul>
      )}
    </figure>
  );
}

/** Short lists of tasks or inquiries inside a widget. */
export function MiniList({ children }: { children: ReactNode }) {
  return <ul className="m-0 mt-[12px] p-0 list-none divide-y divide-line">{children}</ul>;
}
