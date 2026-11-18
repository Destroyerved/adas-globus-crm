import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, formatNumber, type StatusTone } from '@adas/shared';
import { StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type DeadLetterEventView } from '@/lib/api.js';
import { viewerTimeZone } from '@/features/records/timeline.js';
import { errorMessage, tableClass, thClass, theadRowClass } from '@/features/shared/live-kit.js';

const READINESS_TONE: Record<'ok' | 'degraded' | 'down', StatusTone> = {
  ok: 'success',
  degraded: 'warning',
  down: 'danger',
};

const WORKER_STATUS_TONE: Record<string, StatusTone> = {
  running: 'success',
  draining: 'warning',
  stopped: 'neutral',
};

const BACKUP_STATUS_TONE: Record<string, StatusTone> = {
  succeeded: 'success',
  running: 'info',
  failed: 'danger',
};

const BACKUP_KIND_LABEL: Record<string, string> = {
  pg_dump: 'Database dump',
  wal_base: 'Continuous WAL base',
  files_snapshot: 'Files snapshot',
  restore_drill: 'Restore drill',
  pre_deploy: 'Pre-deploy snapshot',
};

function formatDurationShort(totalSeconds: number | null): string {
  if (totalSeconds === null) return '—';
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const mins = Math.floor(totalSeconds / 60);
  if (mins < 60) return `${mins}m ${totalSeconds % 60}s`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatBytesMb(bytes: number | string | null): string {
  if (bytes === null) return '—';
  const n = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function SystemHealthTab() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const timeZone = viewerTimeZone();

  const healthQuery = useQuery({
    queryKey: ['admin-system-health'],
    queryFn: api.getSystemHealthOverview,
    refetchInterval: 15_000,
  });

  const [purgingEvent, setPurgingEvent] = useState<DeadLetterEventView | null>(null);

  const retryOneMutation = useMutation({
    mutationFn: (eventId: string) => api.retryDeadLetterEvent(eventId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-system-health'] });
      toast('Dead-letter event queued for immediate retry.');
    },
  });

  const retryAllMutation = useMutation({
    mutationFn: () => api.retryAllDeadLetters(),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-system-health'] });
      toast(`Queued ${formatNumber(res.retriedCount)} dead-letter events for retry.`);
    },
  });

  const purgeMutation = useMutation({
    mutationFn: (eventId: string) => api.purgeDeadLetterEvent(eventId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-system-health'] });
      setPurgingEvent(null);
      toast('Dead-letter event permanently dismissed.');
    },
  });

  if (healthQuery.isPending) return <LoadingState />;
  if (healthQuery.isError) {
    return (
      <ErrorState
        message={errorMessage(healthQuery.error)}
        onRetry={() => void healthQuery.refetch()}
      />
    );
  }

  const { readiness, process: proc, queues, workers, deadLetters, backups } = healthQuery.data;

  return (
    <div className="space-y-[16px]" data-testid="settings-system-health-tab">
      {readiness.status !== 'ok' && (
        <Callout tone={readiness.status === 'down' ? 'danger' : 'warning'}>
          <div className="space-y-[4px]">
            <div className="font-semibold">
              System status is {readiness.status === 'down' ? 'unavailable' : 'degraded'}
            </div>
            <p className="m-0 text-[13px]">
              Review worker heartbeats, pending outbox age, dead-letter events, and backup recency
              below.
            </p>
          </div>
        </Callout>
      )}

      <Panel
        title="Readiness & runtime telemetry"
        actions={
          <Button
            variant="secondary"
            size="sm"
            disabled={healthQuery.isFetching}
            onClick={() => void healthQuery.refetch()}
          >
            {healthQuery.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-[12px]">
          <div className="p-[12px] rounded-[8px] border border-line bg-bg-alt space-y-[4px]">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              Database
            </div>
            <div className="flex items-center gap-[8px]">
              <StatusBadge tone={readiness.checks.database.ok ? 'success' : 'danger'}>
                {readiness.checks.database.ok ? 'Connected' : 'Unreachable'}
              </StatusBadge>
              <span className="text-[13px] font-medium text-ink tabular-nums">
                {readiness.checks.database.latencyMs !== null
                  ? `${readiness.checks.database.latencyMs} ms`
                  : '—'}
              </span>
            </div>
            <div className="text-[12px] text-ink-3">
              Overall:{' '}
              <StatusBadge tone={READINESS_TONE[readiness.status]}>{readiness.status}</StatusBadge>
            </div>
          </div>

          <div className="p-[12px] rounded-[8px] border border-line bg-bg-alt space-y-[4px]">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              Background worker
            </div>
            <div className="flex items-center gap-[8px]">
              <StatusBadge
                tone={
                  readiness.checks.worker.state === 'active'
                    ? 'success'
                    : readiness.checks.worker.state === 'stale'
                      ? 'danger'
                      : 'neutral'
                }
              >
                {readiness.checks.worker.state === 'active'
                  ? `${formatNumber(readiness.checks.worker.activeWorkers)} active`
                  : readiness.checks.worker.state === 'stale'
                    ? 'Stale heartbeat'
                    : 'Idle'}
              </StatusBadge>
            </div>
            <div className="text-[12px] text-ink-3 tabular-nums">
              Last pulse: {formatDurationShort(readiness.checks.worker.lastHeartbeatSecondsAgo)}
            </div>
          </div>

          <div className="p-[12px] rounded-[8px] border border-line bg-bg-alt space-y-[4px]">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              Outbox queue
            </div>
            <div className="flex items-center gap-[8px]">
              <StatusBadge tone={readiness.checks.outbox.ok ? 'success' : 'warning'}>
                {formatNumber(queues.outboxPending)} pending
              </StatusBadge>
              {queues.outboxDeadLetter > 0 && (
                <StatusBadge tone="danger">
                  {formatNumber(queues.outboxDeadLetter)} dead letter
                </StatusBadge>
              )}
            </div>
            <div className="text-[12px] text-ink-3 tabular-nums">
              24h processed: {formatNumber(queues.outboxProcessed24h)} · Oldest:{' '}
              {formatDurationShort(queues.oldestPendingSeconds)}
            </div>
          </div>

          <div className="p-[12px] rounded-[8px] border border-line bg-bg-alt space-y-[4px]">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              Backups & drills
            </div>
            <div>
              <StatusBadge
                tone={
                  readiness.checks.backups.state === 'ok'
                    ? 'success'
                    : readiness.checks.backups.state === 'stale'
                      ? 'danger'
                      : 'neutral'
                }
              >
                {readiness.checks.backups.state === 'ok'
                  ? 'Current (<26h)'
                  : readiness.checks.backups.state === 'stale'
                    ? 'Overdue (>26h)'
                    : 'No run recorded'}
              </StatusBadge>
            </div>
            <div className="text-[12px] text-ink-3 tabular-nums">
              Last backup:{' '}
              {readiness.checks.backups.lastBackupHoursAgo !== null
                ? `${readiness.checks.backups.lastBackupHoursAgo}h ago`
                : '—'}
            </div>
          </div>

          <div className="p-[12px] rounded-[8px] border border-line bg-bg-alt space-y-[4px]">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              API runtime
            </div>
            <div className="text-[14px] font-semibold text-ink tabular-nums">
              {formatBytesMb(proc.rssBytes)} RSS
            </div>
            <div className="text-[12px] text-ink-3 tabular-nums">
              Uptime: {formatDurationShort(proc.uptimeSeconds)} · {proc.nodeVersion}
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        title={`Dead-letter outbox queue (${formatNumber(deadLetters.length)})`}
        actions={
          deadLetters.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={retryAllMutation.isPending}
              onClick={() => retryAllMutation.mutate()}
            >
              {retryAllMutation.isPending ? 'Retrying…' : 'Retry all'}
            </Button>
          ) : undefined
        }
      >
        {deadLetters.length === 0 ? (
          <EmptyState
            title="No dead-letter events"
            description="Events that exhaust automatic background retries appear here so administrators can inspect, re-queue, or dismiss them."
          />
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Dead-letter outbox events"
          >
            <table className={tableClass}>
              <thead>
                <tr className={theadRowClass}>
                  <th className={thClass}>Event</th>
                  <th className={thClass}>Aggregate</th>
                  <th className={thClass}>Attempts</th>
                  <th className={thClass}>Last error</th>
                  <th className={thClass}>Created</th>
                  <th className={`${thClass} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {deadLetters.map((ev) => (
                  <tr key={ev.id}>
                    <td className="px-[14px] py-[10px]">
                      <div className="font-semibold text-[13px] text-ink">{ev.event_type}</div>
                      <div className="text-[11px] font-mono text-ink-3">{ev.id}</div>
                    </td>
                    <td className="px-[14px] py-[10px] text-[12px] text-ink-2">
                      <div>{ev.aggregate_type}</div>
                      <div className="font-mono text-[11px] text-ink-3">{ev.aggregate_id}</div>
                    </td>
                    <td className="px-[14px] py-[10px] text-[13px] tabular-nums text-ink">
                      {formatNumber(ev.attempts)}
                      {ev.retry_count > 0 && (
                        <span className="text-[11px] text-ink-3 block">
                          {formatNumber(ev.retry_count)} manual retr
                          {ev.retry_count === 1 ? 'y' : 'ies'}
                        </span>
                      )}
                    </td>
                    <td className="px-[14px] py-[10px] text-[12px] text-danger font-mono">
                      {ev.last_error ?? 'Unknown error'}
                    </td>
                    <td className="px-[14px] py-[10px] text-[12px] text-ink-3 tabular-nums">
                      {formatDateTime(ev.created_at, timeZone)}
                    </td>
                    <td className="px-[14px] py-[10px] text-right">
                      <div className="inline-flex flex-wrap justify-end gap-[6px]">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={retryOneMutation.isPending}
                          onClick={() => retryOneMutation.mutate(ev.id)}
                        >
                          Retry
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setPurgingEvent(ev)}>
                          Dismiss
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(retryOneMutation.isError || retryAllMutation.isError) && (
          <p role="alert" className="mt-[8px] mb-0 text-[13px] text-danger">
            {errorMessage(retryOneMutation.error ?? retryAllMutation.error)}
          </p>
        )}
      </Panel>

      <Panel title="Worker processes">
        {workers.length === 0 ? (
          <EmptyState
            title="No worker heartbeats recorded yet"
            description="Start the background worker process to see live heartbeat pulses, active job counts, and outbox dispatch timestamps."
          />
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Background worker processes"
          >
            <table className={tableClass}>
              <thead>
                <tr className={theadRowClass}>
                  <th className={thClass}>Worker</th>
                  <th className={thClass}>Host · PID</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Active jobs</th>
                  <th className={thClass}>Last job</th>
                  <th className={thClass}>Last heartbeat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {workers.map((w) => (
                  <tr key={w.worker_id}>
                    <td className="px-[14px] py-[10px] text-[12px] font-mono text-ink">
                      {w.worker_id}
                    </td>
                    <td className="px-[14px] py-[10px] text-[13px] text-ink-2">
                      {w.hostname} · PID {w.pid}
                    </td>
                    <td className="px-[14px] py-[10px]">
                      <StatusBadge tone={WORKER_STATUS_TONE[w.status] ?? 'neutral'}>
                        {w.status}
                      </StatusBadge>
                    </td>
                    <td className="px-[14px] py-[10px] text-[13px] tabular-nums text-ink">
                      {formatNumber(w.active_jobs)}
                    </td>
                    <td className="px-[14px] py-[10px] text-[12px] text-ink-2">
                      {w.last_job_name ? (
                        <>
                          <span className="font-mono">{w.last_job_name}</span>
                          {w.last_job_at && (
                            <span className="block text-[11px] text-ink-3 tabular-nums">
                              {formatDateTime(w.last_job_at, timeZone)}
                            </span>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-[14px] py-[10px] text-[12px] text-ink-3 tabular-nums">
                      {formatDateTime(w.last_heartbeat_at, timeZone)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Recent backups & restore drills">
        {backups.length === 0 ? (
          <EmptyState
            title="No backup runs recorded yet"
            description="Encrypted nightly database dumps and monthly restore drills report their status, size, and off-site sync state here."
          />
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Recent backup and restore drill runs"
          >
            <table className={tableClass}>
              <thead>
                <tr className={theadRowClass}>
                  <th className={thClass}>Type</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Size</th>
                  <th className={thClass}>Protection</th>
                  <th className={thClass}>Completed</th>
                  <th className={thClass}>Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {backups.map((b) => (
                  <tr key={b.id}>
                    <td className="px-[14px] py-[10px] text-[13px] font-medium text-ink">
                      {BACKUP_KIND_LABEL[b.kind] ?? b.kind}
                    </td>
                    <td className="px-[14px] py-[10px]">
                      <StatusBadge tone={BACKUP_STATUS_TONE[b.status] ?? 'neutral'}>
                        {b.status}
                      </StatusBadge>
                    </td>
                    <td className="px-[14px] py-[10px] text-[13px] tabular-nums text-ink-2">
                      {formatBytesMb(b.size_bytes)}
                    </td>
                    <td className="px-[14px] py-[10px] text-[12px] text-ink-2">
                      {b.encrypted ? 'Encrypted' : 'Plain'}
                      {b.offsite_synced ? ' · Off-site synced' : ''}
                    </td>
                    <td className="px-[14px] py-[10px] text-[12px] text-ink-3 tabular-nums">
                      {b.completed_at ? formatDateTime(b.completed_at, timeZone) : 'In progress'}
                    </td>
                    <td className="px-[14px] py-[10px] text-[12px] text-ink-3 tabular-nums">
                      {b.duration_ms !== null
                        ? `${(b.duration_ms / 1000).toFixed(1)}s`
                        : (b.error_code ?? '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <ConfirmDialog
        open={Boolean(purgingEvent)}
        title="Dismiss dead-letter event"
        tone="danger"
        confirmLabel="Dismiss event"
        pending={purgeMutation.isPending}
        error={purgeMutation.isError ? errorMessage(purgeMutation.error) : null}
        onCancel={() => setPurgingEvent(null)}
        onConfirm={() => {
          if (purgingEvent) purgeMutation.mutate(purgingEvent.id);
        }}
        body={
          <p className="m-0">
            Permanently remove dead-letter event <code>{purgingEvent?.event_type ?? 'outbox'}</code>{' '}
            ({purgingEvent?.id ?? ''}) without running its background handlers? This action is
            recorded in the audit log.
          </p>
        }
      />
    </div>
  );
}
