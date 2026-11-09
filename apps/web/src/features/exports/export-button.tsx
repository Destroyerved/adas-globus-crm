import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import {
  EXPORT_KEEP_DAYS,
  EXPORT_LARGE_ROWS,
  EXPORT_SYNC_MAX_ROWS,
  formatCount,
  formatNumber,
  type ExportEntity,
} from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Callout } from '@/components/ui/panel.js';
import { useToast } from '@/components/ui/toast.js';
import { can, useMe } from '@/features/shared/list-kit.js';
import { errorMessage } from '@/features/shared/live-kit.js';
import { api, type Filter } from '@/lib/api.js';
import { saveExport } from './export-kit.js';

const NOUNS: Record<ExportEntity, [string, string]> = {
  lead: ['lead', 'leads'],
  contact: ['contact', 'contacts'],
  company: ['company', 'companies'],
  deal: ['deal', 'deals'],
};

/**
 * "Export" on a list (PRD 4.9): the rows of the current view, with its search, filters and
 * sort, as a CSV file. Up to 5,000 rows download at once; larger exports are prepared in the
 * background and the notification bell offers the file. The API checks every rule again.
 */
export function ExportButton({
  entity,
  q,
  sort,
  filter,
  total,
}: {
  entity: ExportEntity;
  q: string;
  sort: string;
  filter: Filter | null;
  /** Rows in the view; undefined while the list loads. */
  total: number | undefined;
}) {
  const me = useMe();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [singular, plural] = NOUNS[entity];
  const create = useMutation({
    mutationFn: async () => {
      const result = await api.createExport({ entity, q, sort, filter: filter ?? undefined });
      if (result.status === 'ready') await saveExport(result.id);
      return result;
    },
    onSuccess: (result) => {
      setOpen(false);
      if (result.status === 'ready') {
        toast(`Exported ${formatCount(result.rowCount, singular, plural)}.`, 'success');
      } else {
        toast('Preparing your export. You’ll get a notification when the file is ready.', 'info');
      }
    },
  });

  if (!can(me, 'exports.run')) return null;
  const count = total ?? 0;
  const tooMany = count > EXPORT_LARGE_ROWS && me?.capabilities?.['exports.run'] !== 'all';

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          create.reset();
          setOpen(true);
        }}
        disabled={count === 0}
      >
        <Download size={16} strokeWidth={1.6} aria-hidden="true" />
        <span>Export</span>
      </Button>
      <ConfirmDialog
        open={open}
        tone="primary"
        title={`Export ${formatCount(count, singular, plural)}?`}
        body={
          <div className="space-y-[10px]">
            <p className="m-0">
              The CSV file has the {plural} in this view, with its search, filters and sort. Dates
              are in your time zone{me?.timezone ? ` (${me.timezone})` : ''}. The file is kept for{' '}
              {EXPORT_KEEP_DAYS} days.
            </p>
            {tooMany ? (
              <Callout tone="warning">
                You can export up to {formatNumber(EXPORT_LARGE_ROWS)} {plural} at a time. Narrow
                the filters to export these.
              </Callout>
            ) : (
              <>
                {count > EXPORT_SYNC_MAX_ROWS && (
                  <p className="m-0">
                    This is a large export, so it&rsquo;s prepared in the background. You&rsquo;ll
                    get a notification when the file is ready.
                  </p>
                )}
                {count > EXPORT_LARGE_ROWS && (
                  <p className="m-0">
                    Admins are told about exports of more than {formatNumber(EXPORT_LARGE_ROWS)}{' '}
                    rows.
                  </p>
                )}
              </>
            )}
          </div>
        }
        confirmLabel="Export CSV"
        confirmDisabled={tooMany}
        pending={create.isPending}
        error={create.error ? errorMessage(create.error) : null}
        onConfirm={() => create.mutate()}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
