import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { formatDate, formatNumber } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { Select } from '@/components/ui/select.js';
import { api, type CurrentUser, type Filter, type FilterCondition, type Page } from '@/lib/api.js';
import { thClass } from './live-kit.js';

/**
 * List building blocks (PRD 6.7, 6.8; DESIGN 6.5): list state lives in the URL, pages come
 * from the server by cursor, and sorting and filtering happen in SQL, never in the browser.
 */

/** Reads and writes a set of URL query parameters; values equal to their default are dropped. */
export function useUrlState<K extends string>(
  defaults: Record<K, string>,
): [Record<K, string>, (patch: Partial<Record<K, string>>) => void] {
  const defaultsRef = useRef(defaults);
  const read = useCallback((): Record<K, string> => {
    const params = new URLSearchParams(window.location.search);
    const out = { ...defaultsRef.current };
    for (const key of Object.keys(out) as K[]) {
      const value = params.get(key);
      if (value !== null) out[key] = value;
    }
    return out;
  }, []);
  const [state, setState] = useState(read);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const onPop = () => setState(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [read]);

  const update = useCallback((patch: Partial<Record<K, string>>) => {
    const current = stateRef.current;
    if ((Object.keys(patch) as K[]).every((key) => patch[key] === current[key])) return;
    const next = { ...current, ...patch } as Record<K, string>;
    const url = new URL(window.location.href);
    for (const key of Object.keys(next) as K[]) {
      // An empty value differs from a non-empty default (for example "any assignee" versus
      // "me"), so it stays in the URL as key= and survives a reload.
      if (next[key] === defaultsRef.current[key]) url.searchParams.delete(key);
      else url.searchParams.set(key, next[key]);
    }
    window.history.replaceState(window.history.state, '', url);
    stateRef.current = next;
    setState(next);
  }, []);

  return [state, update];
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Search box text that is written to the URL a moment after typing stops. */
export function useSearchText(
  initial: string,
  commit: (q: string) => void,
): [string, (value: string) => void] {
  const [text, setText] = useState(initial);
  const debounced = useDebounced(text);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    commitRef.current(debounced.trim());
  }, [debounced]);
  return [text, setText];
}

/** Cursor-paged list from the API; "Show more" fetches the next page. */
export function usePagedList<T>(
  key: readonly unknown[],
  fetchPage: (cursor: string | null) => Promise<Page<T>>,
) {
  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<T>) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  return { query, items, total: query.data?.pages[0]?.total };
}

/** Combines simple conditions into one filter; empty when nothing is set. */
export function allOf(conditions: (FilterCondition | null | false | undefined)[]): Filter | null {
  const list = conditions.filter((c): c is FilterCondition => Boolean(c));
  if (list.length === 0) return null;
  if (list.length === 1) return list[0] ?? null;
  return { and: list };
}

export function ListFooter({
  shown,
  total,
  hasMore,
  loading,
  onMore,
  noun,
}: {
  shown: number;
  total: number | undefined;
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
  noun: string;
}) {
  if (shown === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-[8px] px-[16px] py-[10px] border-t border-line text-[13px] text-ink-3">
      <span className="tabular-nums">
        Showing {formatNumber(shown)} of {formatNumber(total ?? shown)} {noun}
      </span>
      {hasMore && (
        <Button variant="outline" size="sm" disabled={loading} onClick={onMore}>
          {loading ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </div>
  );
}

/** Sortable column header: one click sorts, a second click reverses (DESIGN 6.5). */
export function SortHeader({
  label,
  field,
  sort,
  onSort,
  descFirst = false,
  className = '',
}: {
  label: string;
  field: string;
  sort: string;
  onSort: (sort: string) => void;
  descFirst?: boolean;
  className?: string;
}) {
  const active = sort === field || sort === `-${field}`;
  const desc = sort === `-${field}`;
  const next = active ? (desc ? field : `-${field}`) : descFirst ? `-${field}` : field;
  return (
    <th
      scope="col"
      aria-sort={active ? (desc ? 'descending' : 'ascending') : 'none'}
      className={`${thClass} ${className}`.trim()}
    >
      <button
        type="button"
        onClick={() => onSort(next)}
        className={`inline-flex items-center gap-[4px] bg-transparent border-0 p-0 cursor-pointer text-label ${active ? 'text-ink' : 'text-ink-3 hover:text-ink'}`}
      >
        {label}
        {active &&
          (desc ? (
            <ArrowDown size={13} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <ArrowUp size={13} strokeWidth={1.8} aria-hidden="true" />
          ))}
      </button>
    </th>
  );
}

/** Who is signed in, with the scope of each capability (from /auth/me). */
export function useMe(): CurrentUser | undefined {
  return useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 300_000 }).data;
}

export function can(user: CurrentUser | undefined, capability: string): boolean {
  const scope = user?.capabilities?.[capability];
  return scope !== undefined && scope !== 'none';
}

export function useReferenceLists() {
  return useQuery({
    queryKey: ['reference-lists'],
    queryFn: api.referenceLists,
    staleTime: 300_000,
  });
}

export function useUsers() {
  return useQuery({ queryKey: ['users'], queryFn: api.listUsers, staleTime: 300_000 });
}

/** Owner filter: anyone, me, or a named person (sent as "@me" so saved views stay personal). */
export function OwnerFilter({
  value,
  onChange,
  label = 'Owner',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const users = useUsers();
  return (
    <Select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="sm:w-[180px]"
    >
      <option value="">Any owner</option>
      <option value="@me">Me</option>
      {(users.data ?? []).map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </Select>
  );
}

/** Choose a person to own or do something; only active users are offered. */
export function UserSelect({
  value,
  onChange,
  label,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  id?: string;
}) {
  const users = useUsers();
  return (
    <Select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {(users.data ?? [])
        .filter((u) => !u.status || u.status === 'active')
        .map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
            {u.team_name ? ` · ${u.team_name}` : ''}
          </option>
        ))}
    </Select>
  );
}

/** A row of filter controls above a table; wraps on small screens. */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-col lg:flex-row lg:items-center gap-[8px]">{children}</div>;
}

/**
 * A time range kept in the URL as "startISO,endISO" (end exclusive), as the dashboard writes
 * it. Returns null for anything else, so a hand-edited URL never reaches the API.
 */
export function rangeParam(value: string): [string, string] | null {
  const [start, end, extra] = value.split(',');
  if (!start || !end || extra !== undefined) return null;
  if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return null;
  return [start, end];
}

/** "1 Mar 2026 to 31 Mar 2026" for a range param, in the viewer's time zone. */
export function rangeLabel(range: [string, string], timeZone: string): string {
  const lastMoment = new Date(Date.parse(range[1]) - 1);
  return `${formatDate(range[0], timeZone)} to ${formatDate(lastMoment, timeZone)}`;
}

/** Filters that came from a link (for example a dashboard number), each removable. */
export function FilterChips({
  chips,
}: {
  chips: { key: string; label: string; onRemove: () => void }[];
}) {
  if (chips.length === 0) return null;
  return (
    <ul className="m-0 p-0 list-none flex flex-wrap gap-[6px]" aria-label="Active filters">
      {chips.map((chip) => (
        <li
          key={chip.key}
          className="inline-flex items-center gap-[4px] h-[28px] pl-[10px] pr-[4px] rounded-pill border border-line-strong bg-surface text-[13px] text-ink"
        >
          {chip.label}
          <button
            type="button"
            aria-label={`Remove filter: ${chip.label}`}
            onClick={chip.onRemove}
            className="h-[22px] w-[22px] grid place-items-center rounded-pill bg-transparent border-0 text-ink-3 hover:bg-bg-alt hover:text-ink cursor-pointer"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}
