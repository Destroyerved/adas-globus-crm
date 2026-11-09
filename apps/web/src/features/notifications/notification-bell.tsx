import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { formatRelative } from '@adas/shared';
import { useToast } from '@/components/ui/toast.js';
import { saveExport } from '@/features/exports/export-kit.js';
import { api, type NotificationRow } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';

export type RecordScreen = 'lead' | 'contact' | 'company' | 'deal' | 'tasks' | 'imports';

function targetOf(n: NotificationRow): { screen: RecordScreen; id: string | null } | null {
  switch (n.entity_type) {
    case 'lead':
    case 'contact':
    case 'company':
    case 'deal':
      return n.entity_id ? { screen: n.entity_type, id: n.entity_id } : null;
    case 'task':
      return { screen: 'tasks', id: null };
    case 'import_batch':
      return { screen: 'imports', id: n.entity_id };
    default:
      return null;
  }
}

/**
 * Notification bell (PRD 4.7, DESIGN 5.2): assignments, reminders, overdue tasks, SLA and
 * idle-deal warnings written by the API and the worker. Checks for new ones every minute.
 */
export function NotificationBell({
  onOpen,
}: {
  onOpen: (screen: RecordScreen, id: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const list = useQuery({
    queryKey: ['notifications'],
    queryFn: api.notifications,
    refetchInterval: 60_000,
  });
  const unread = list.data?.unreadCount ?? 0;

  const markRead = useMutation({
    mutationFn: (id?: string) => api.markNotificationsRead(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The badge's text must be a word of the button's name (WCAG 2.5.3): "Notifications, 3 unread".
  const badge = unread > 99 ? '99+' : String(unread);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${badge} unread` : 'Notifications'}
        className="relative inline-flex items-center justify-center h-[32px] w-[32px] rounded-pill bg-transparent hover:bg-bg-alt text-ink-2 hover:text-ink cursor-pointer border-0"
      >
        <Bell size={18} strokeWidth={1.6} aria-hidden="true" />
        {unread > 0 && (
          <span
            className="absolute top-[3px] right-[2px] min-w-[16px] h-[16px] px-[4px] rounded-pill bg-primary text-primary-foreground text-[10.5px] font-semibold leading-[16px] text-center tabular-nums"
            aria-hidden="true"
          >
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          style={{ boxShadow: 'var(--shadow-pop)' }}
          className="absolute right-0 mt-[6px] w-[min(360px,calc(100vw-32px))] rounded-[10px] bg-surface border border-line z-40"
        >
          <div className="flex items-center justify-between px-[12px] py-[10px] border-b border-line">
            <span className="text-[13px] font-semibold text-ink">
              Notifications{unread > 0 ? ` (${unread} unread)` : ''}
            </span>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => markRead.mutate(undefined)}
                disabled={markRead.isPending}
                className="text-[12px] font-semibold text-primary-ink hover:underline bg-transparent border-0 p-0 cursor-pointer"
              >
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {list.isPending && <p className="m-0 p-[12px] text-[13px] text-ink-3">Loading…</p>}
            {list.isError && (
              <p className="m-0 p-[12px] text-[13px] text-danger">{errorMessage(list.error)}</p>
            )}
            {list.isSuccess && list.data.items.length === 0 && (
              <p className="m-0 p-[12px] text-[13px] text-ink-2">
                You&rsquo;re all caught up. Assignments, reminders and overdue tasks show up here.
              </p>
            )}
            {list.isSuccess && list.data.items.length > 0 && (
              <ul className="m-0 p-0 list-none">
                {list.data.items.map((n) => {
                  const target = targetOf(n);
                  return (
                    <li key={n.id} className="border-b border-line last:border-b-0">
                      <button
                        type="button"
                        onClick={() => {
                          if (!n.read_at) markRead.mutate(n.id);
                          // A ready export downloads; anything else opens its record.
                          if (n.entity_type === 'export' && n.entity_id) {
                            saveExport(n.entity_id).catch((err: unknown) =>
                              toast(errorMessage(err), 'danger'),
                            );
                          } else if (target) {
                            onOpen(target.screen, target.id);
                          }
                          setOpen(false);
                        }}
                        className={`w-full text-left px-[12px] py-[10px] border-0 cursor-pointer hover:bg-bg-alt ${n.read_at ? 'bg-surface' : 'bg-tint'}`}
                      >
                        <div className="flex justify-between gap-[8px]">
                          <span className="text-[13.5px] font-semibold text-ink">{n.title}</span>
                          <span className="text-[12px] text-ink-3 whitespace-nowrap">
                            {formatRelative(n.created_at)}
                          </span>
                        </div>
                        {n.body && <div className="text-[13px] text-ink-2 mt-[2px]">{n.body}</div>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
