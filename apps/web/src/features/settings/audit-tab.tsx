import { useMemo } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { formatDateTime } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Select } from '@/components/ui/select.js';
import { api } from '@/lib/api.js';
import {
  DataPanel,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadRowClass,
} from '@/features/shared/live-kit.js';
import { Toolbar, useUrlState, useUsers } from '@/features/shared/list-kit.js';
import { viewerTimeZone } from '@/features/records/timeline.js';
import { actionLabel } from './settings-kit.js';

const DEFAULTS = { action: '', actor: '', from: '', to: '' };

/** A short, readable summary of what changed, without dumping raw JSON. */
function summary(metadata: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const shown = value
        .slice(0, 4)
        .map((v) =>
          typeof v === 'object' && v !== null
            ? Object.values(v as Record<string, unknown>).join(' ')
            : String(v),
        );
      parts.push(`${key}: ${shown.join(', ')}${value.length > 4 ? ` +${value.length - 4}` : ''}`);
    } else if (typeof value === 'object') {
      parts.push(`${key}: ${Object.keys(value as object).length} values`);
    } else {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.join(' · ');
}

/** Audit log viewer (PRD 4.17, 9): newest first, filtered, paged; nothing can be edited. */
export function AuditTab() {
  const [state, setState] = useUrlState(DEFAULTS);
  const users = useUsers();
  const actions = useQuery({ queryKey: ['audit-actions'], queryFn: api.auditActions });
  const timeZone = viewerTimeZone();
  const filters = { action: state.action, actor: state.actor, from: state.from, to: state.to };
  const query = useInfiniteQuery({
    queryKey: ['audit-logs', filters],
    queryFn: ({ pageParam }) => api.auditLogs({ ...filters, cursor: pageParam, limit: '50' }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const filtered = Boolean(state.action || state.actor || state.from || state.to);

  return (
    <div className="space-y-[12px]">
      <Toolbar>
        <Select
          aria-label="Action"
          value={state.action}
          onChange={(e) => setState({ action: e.target.value })}
          className="lg:w-[240px]"
        >
          <option value="">Any action</option>
          {(actions.data ?? []).map((a) => (
            <option key={a} value={a}>
              {actionLabel(a)}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Person"
          value={state.actor}
          onChange={(e) => setState({ actor: e.target.value })}
          className="lg:w-[200px]"
        >
          <option value="">Anyone</option>
          {(users.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
        <div className="flex gap-[8px]">
          <Input
            type="date"
            aria-label="From date"
            value={state.from}
            onChange={(e) => setState({ from: e.target.value })}
            className="lg:w-[160px]"
          />
          <Input
            type="date"
            aria-label="To date"
            value={state.to}
            onChange={(e) => setState({ to: e.target.value })}
            className="lg:w-[160px]"
          />
        </div>
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => setState({ action: '', actor: '', from: '', to: '' })}
          >
            Clear filters
          </Button>
        )}
      </Toolbar>
      <DataPanel
        query={query}
        isEmpty={rows.length === 0}
        emptyTitle={filtered ? 'Nothing matches these filters' : 'Nothing recorded yet'}
        emptyDescription={
          filtered
            ? 'Clear the filters to see every entry.'
            : 'Changes to people, roles and settings, deletions and exports are recorded here.'
        }
        footer={
          query.hasNextPage ? (
            <div className="px-[12px] py-[10px] border-t border-line">
              <Button
                variant="secondary"
                size="sm"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? 'Loading…' : 'Show older'}
              </Button>
            </div>
          ) : null
        }
      >
        <table className={tableClass}>
          <caption className="sr-only">Audit log, newest first</caption>
          <thead>
            <tr className={theadRowClass}>
              <th className={thClass}>When</th>
              <th className={thClass}>Who</th>
              <th className={thClass}>What</th>
              <th className={`${thClass} hidden md:table-cell`}>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const details = summary(a.metadata);
              return (
                <tr key={a.id} className={rowClass}>
                  <td className={`${tdClass} whitespace-nowrap text-ink-2`}>
                    {formatDateTime(a.created_at, timeZone)}
                  </td>
                  <td className={tdClass}>{a.actor_name ?? 'System'}</td>
                  <td className={tdClass}>
                    <div className="text-ink">{actionLabel(a.action)}</div>
                    <div className="text-[12.5px] text-ink-3 break-all">
                      {a.entity_type}
                      {a.entity_id ? ` · ${a.entity_id}` : ''}
                    </div>
                  </td>
                  <td className={`${tdClass} hidden md:table-cell text-[13px] text-ink-2`}>
                    <span className="line-clamp-2 break-words" title={details}>
                      {details || '—'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DataPanel>
    </div>
  );
}
