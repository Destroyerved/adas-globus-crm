import { useRef, useState, type DragEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, FileSpreadsheet, Upload } from 'lucide-react';
import {
  IMPORT_MAX_BYTES,
  formatDateTime,
  formatNumber,
  type ImportBatchView,
  type ImportRowView,
} from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { Select } from '@/components/ui/select.js';
import { ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { KpiRow } from '@/features/dashboard/dashboard-kit.js';
import { useMe } from '@/features/shared/list-kit.js';
import {
  DataPanel,
  PageHeader,
  errorMessage,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadRowClass,
} from '@/features/shared/live-kit.js';
import { api } from '@/lib/api.js';
import {
  ImportProgress,
  ImportStatusBadge,
  countTiles,
  entityLabel,
  resultSummary,
  useImport,
} from './import-kit.js';
import { MappingStep } from './mapping-step.js';

/**
 * Imports (PRD 4.9): upload a CSV or Excel file, map its columns, check it with a dry run,
 * import it in the background with live progress, then review the results or undo it.
 */
export function ImportsScreen({
  importId,
  onOpen,
  onBack,
}: {
  importId: string | null;
  onOpen: (id: string) => void;
  onBack: () => void;
}) {
  return importId ? (
    <ImportDetail key={importId} importId={importId} onBack={onBack} />
  ) : (
    <ImportList onOpen={onOpen} />
  );
}

// ---------------------------------------------------------------------------
// List and upload
// ---------------------------------------------------------------------------

function ImportList({ onOpen }: { onOpen: (id: string) => void }) {
  const me = useMe();
  const tz = me?.timezone ?? 'UTC';
  const imports = useQuery({ queryKey: ['imports'], queryFn: api.listImports });
  const [uploading, setUploading] = useState(false);
  const items = imports.data ?? [];

  return (
    <div className="space-y-[16px]" data-testid="imports-screen">
      <PageHeader
        kicker="Data"
        title="Imports"
        count={imports.data ? items.length : undefined}
        actions={
          !uploading && (
            <Button variant="primary" onClick={() => setUploading(true)}>
              <Upload size={16} strokeWidth={1.8} aria-hidden="true" />
              Import a file
            </Button>
          )
        }
      />
      {uploading && <UploadPanel onUploaded={onOpen} onClose={() => setUploading(false)} />}
      <DataPanel
        query={imports}
        isEmpty={items.length === 0}
        emptyTitle="No imports yet"
        emptyDescription="Bring in contacts or companies from a CSV or Excel file. You can check a file before anything is saved."
        emptyActionLabel={uploading ? undefined : 'Import a file'}
        onEmptyAction={() => setUploading(true)}
      >
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <th scope="col" className={thClass}>
                File
              </th>
              <th scope="col" className={thClass}>
                Records
              </th>
              <th scope="col" className={thClass}>
                Status
              </th>
              <th scope="col" className={`${thClass} text-right`}>
                Rows
              </th>
              <th scope="col" className={thClass}>
                Result
              </th>
              <th scope="col" className={thClass}>
                Started by
              </th>
              <th scope="col" className={thClass}>
                Uploaded
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.id} className={rowClass}>
                <td className={`${tdClass} max-w-[280px]`}>
                  <button
                    type="button"
                    onClick={() => onOpen(b.id)}
                    className="font-semibold text-ink hover:underline cursor-pointer bg-transparent border-0 p-0 text-left truncate max-w-full"
                  >
                    {b.filename}
                  </button>
                </td>
                <td className={tdClass}>{entityLabel(b)}</td>
                <td className={tdClass}>
                  <ImportStatusBadge status={b.status} />
                </td>
                <td className={`${tdClass} text-right tabular-nums`}>{formatNumber(b.rowCount)}</td>
                <td className={`${tdClass} text-ink-2 whitespace-nowrap`}>
                  {resultSummary(b) || <span className="text-ink-3">—</span>}
                </td>
                <td className={`${tdClass} whitespace-nowrap`}>{b.createdBy.name}</td>
                <td className={`${tdClass} whitespace-nowrap text-ink-2`}>
                  {formatDateTime(b.createdAt, tz)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataPanel>
    </div>
  );
}

function UploadPanel({
  onUploaded,
  onClose,
}: {
  onUploaded: (id: string) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const upload = useMutation({
    mutationFn: api.uploadImport,
    onSuccess: ({ batch }) => {
      queryClient.setQueryData(['imports', batch.id], batch);
      void queryClient.invalidateQueries({ queryKey: ['imports'], exact: true });
      onUploaded(batch.id);
    },
  });

  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!/\.(csv|xlsx)$/i.test(file.name)) {
      setProblem('Choose a .csv file or an Excel workbook (.xlsx).');
      return;
    }
    if (file.size > IMPORT_MAX_BYTES) {
      setProblem('Files can be up to 50 MB. Split the file and import each part.');
      return;
    }
    setProblem(null);
    upload.mutate(file);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files[0]);
  };

  const message = problem ?? (upload.error ? errorMessage(upload.error) : null);

  return (
    <Panel
      title="Import a file"
      actions={
        <Button variant="ghost" size="sm" onClick={onClose} disabled={upload.isPending}>
          Cancel
        </Button>
      }
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-[10px] border border-dashed px-[20px] py-[28px] text-center transition-colors ${dragging ? 'border-primary bg-tint' : 'border-line-strong bg-bg-alt'}`}
      >
        <FileSpreadsheet
          size={28}
          strokeWidth={1.4}
          aria-hidden="true"
          className="mx-auto text-primary-ink"
        />
        <p className="text-[14px] text-ink mt-[8px] mb-[4px]">
          Drag a CSV or Excel file here, or choose one.
        </p>
        <p className="text-[13px] text-ink-3 m-0">
          The first row must name the columns. Up to 50 MB and 100,000 rows.
        </p>
        <input
          ref={input}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          aria-label="File to import"
          data-testid="import-file-input"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <div className="mt-[14px]">
          <Button
            variant="outline"
            onClick={() => input.current?.click()}
            disabled={upload.isPending}
          >
            {upload.isPending ? 'Uploading…' : 'Choose a file'}
          </Button>
        </div>
      </div>
      {message && (
        <p role="alert" className="m-0 mt-[12px] text-[13px] text-danger">
          {message}
        </p>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// One import, step by step
// ---------------------------------------------------------------------------

function ImportDetail({ importId, onBack }: { importId: string; onBack: () => void }) {
  const me = useMe();
  const tz = me?.timezone ?? 'UTC';
  const batch = useImport(importId);
  const [remapping, setRemapping] = useState(false);

  const back = (
    <Button variant="ghost" size="sm" onClick={onBack}>
      <ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true" />
      All imports
    </Button>
  );

  if (batch.isPending) {
    return (
      <div className="space-y-[16px]">
        {back}
        <div className="bg-surface border border-line rounded-[10px]">
          <LoadingState rows={6} />
        </div>
      </div>
    );
  }
  if (batch.isError) {
    return (
      <div className="space-y-[16px]">
        {back}
        <div className="bg-surface border border-line rounded-[10px]">
          <ErrorState message={errorMessage(batch.error)} onRetry={() => void batch.refetch()} />
        </div>
      </div>
    );
  }

  const b = batch.data;
  const notStarted = !b.startedAt;
  const showMapping =
    b.status === 'uploaded' ||
    b.status === 'mapped' ||
    (b.status === 'failed' && notStarted) ||
    (b.status === 'checked' && remapping);

  return (
    <div className="space-y-[16px]" data-testid="import-detail">
      {back}
      <div className="flex flex-col items-start sm:flex-row sm:items-end justify-between gap-[12px]">
        <div className="min-w-0">
          <div className="kicker mb-[4px]">Import · {entityLabel(b)}</div>
          <h1 className="text-title-lg text-ink m-0 break-words">{b.filename}</h1>
          <p className="m-0 mt-[4px] text-[14px] text-ink-2">
            {formatNumber(b.rowCount)} rows · uploaded by {b.createdBy.name} on{' '}
            {formatDateTime(b.createdAt, tz)}
          </p>
        </div>
        <ImportStatusBadge status={b.status} />
      </div>

      {b.failureReason && <Callout tone="danger">{b.failureReason}</Callout>}

      {showMapping && (
        <MappingStep
          batch={b}
          onCancel={b.status === 'checked' ? () => setRemapping(false) : undefined}
        />
      )}

      {b.status === 'checking' && (
        <Panel>
          <ImportProgress label="Checking the file" done={b.processedRows} total={b.rowCount} />
          <p className="m-0 mt-[12px] text-[13px] text-ink-3">
            Nothing is saved while checking. You can leave this page; the check carries on.
          </p>
        </Panel>
      )}

      {b.status === 'checked' && !remapping && (
        <CheckedStep batch={b} onRemap={() => setRemapping(true)} />
      )}

      {(b.status === 'queued' || b.status === 'running') && (
        <Panel>
          <ImportProgress label="Importing" done={b.processedRows} total={b.rowCount} />
          <p className="m-0 mt-[12px] text-[13px] text-ink-3">
            The import runs in the background. You can leave this page; you’ll get a notification
            when it finishes.
          </p>
        </Panel>
      )}

      {(b.status === 'completed' || (b.status === 'failed' && !notStarted)) && (
        <ResultStep batch={b} timeZone={tz} />
      )}

      {b.status === 'rolling_back' && (
        <Panel>
          <p className="m-0 text-[14px] text-ink font-semibold">Undoing this import…</p>
          <p className="m-0 mt-[6px] text-[13px] text-ink-3">
            Records it added are being removed and its changes reverted.
          </p>
        </Panel>
      )}

      {b.status === 'rolled_back' && <UndoneStep batch={b} timeZone={tz} />}
    </div>
  );
}

function CheckedStep({ batch, onRemap }: { batch: ImportBatchView; onRemap: () => void }) {
  const queryClient = useQueryClient();
  const counts = batch.dryRunCounts ?? {};
  const run = useMutation({
    mutationFn: () => api.runImport(batch.id, batch.version),
    onSuccess: (next) => {
      queryClient.setQueryData(['imports', batch.id], next);
      void queryClient.invalidateQueries({ queryKey: ['imports'], exact: true });
    },
  });
  const willChange = (counts.created ?? 0) + (counts.updated ?? 0);
  return (
    <>
      <Panel title="What will happen">
        <KpiRow items={countTiles(counts, batch.entity, false)} />
        {(counts.probable ?? 0) > 0 && (
          <Callout className="mt-[16px]">
            Possible duplicates are still added, then wait in the duplicate review queue so someone
            can merge or keep them.
          </Callout>
        )}
      </Panel>
      <RowsPanel batch={batch} initialStatus={(counts.error ?? 0) > 0 ? 'error' : ''} />
      {run.error && (
        <p role="alert" className="m-0 text-[13px] text-danger">
          {errorMessage(run.error)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-[8px]">
        <Button
          variant="primary"
          onClick={() => run.mutate()}
          disabled={run.isPending || willChange === 0}
        >
          {run.isPending
            ? 'Starting…'
            : `Import ${formatNumber(willChange)} ${willChange === 1 ? 'record' : 'records'}`}
        </Button>
        <Button variant="secondary" onClick={onRemap}>
          Change mapping
        </Button>
        {(counts.error ?? 0) > 0 && (
          <span className="text-[13px] text-ink-3">Rows with errors are skipped.</span>
        )}
      </div>
    </>
  );
}

function ResultStep({ batch, timeZone }: { batch: ImportBatchView; timeZone: string }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const undo = useMutation({
    mutationFn: () => api.undoImport(batch.id, batch.version),
    onSuccess: (next) => {
      setConfirming(false);
      queryClient.setQueryData(['imports', batch.id], next);
      void queryClient.invalidateQueries({ queryKey: ['imports'], exact: true });
    },
  });
  const c = batch.counts;
  const undoOpen = batch.undoUntil !== null && new Date(batch.undoUntil).getTime() > Date.now();
  const what = batch.entity === 'company' ? 'companies' : 'contacts';
  return (
    <>
      <Panel
        title={batch.status === 'completed' ? 'Import finished' : 'Rows imported before it stopped'}
      >
        <KpiRow items={countTiles(c, batch.entity, true)} />
      </Panel>
      <RowsPanel batch={batch} initialStatus={(c.error ?? 0) > 0 ? 'error' : ''} />
      {undoOpen && batch.undoUntil && (
        <div className="flex flex-wrap items-center gap-[12px]">
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Undo import
          </Button>
          <span className="text-[13px] text-ink-3">
            You can undo this import until {formatDateTime(batch.undoUntil, timeZone)}.
          </span>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title="Undo this import?"
        body={
          <>
            {formatNumber(c.created ?? 0)} {what} it added will be removed and{' '}
            {formatNumber(c.updated ?? 0)} updates reverted. Records someone has edited since are
            left alone and listed.
          </>
        }
        confirmLabel="Undo import"
        pending={undo.isPending}
        error={undo.error ? errorMessage(undo.error) : null}
        onConfirm={() => undo.mutate()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

function UndoneStep({ batch, timeZone }: { batch: ImportBatchView; timeZone: string }) {
  const u = batch.undoCounts;
  return (
    <>
      <Panel title="Import undone">
        {batch.rolledBackAt && (
          <p className="m-0 mb-[12px] text-[14px] text-ink-2">
            Undone on {formatDateTime(batch.rolledBackAt, timeZone)}.
          </p>
        )}
        {u && (
          <KpiRow
            items={[
              { label: 'Records removed', value: formatNumber(u.removed) },
              { label: 'Updates reverted', value: formatNumber(u.reverted) },
              {
                label: 'Edited since, left alone',
                value: formatNumber(u.kept),
                tone: u.kept > 0 ? 'warning' : undefined,
              },
              ...(batch.entity === 'contact'
                ? [
                    { label: 'New companies removed', value: formatNumber(u.companiesRemoved) },
                    { label: 'New companies kept (in use)', value: formatNumber(u.companiesKept) },
                  ]
                : []),
            ]}
          />
        )}
      </Panel>
      {u && u.kept > 0 && <RowsPanel batch={batch} initialStatus="" keptOnly />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Row results
// ---------------------------------------------------------------------------

const ROW_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All rows' },
  { value: 'error', label: 'Rows with errors' },
  { value: 'created', label: 'New' },
  { value: 'updated', label: 'Updated' },
  { value: 'skipped', label: 'Left unchanged' },
  { value: 'duplicate', label: 'Repeated in the file' },
];

const ROW_STATUS: Record<ImportRowView['status'], string> = {
  created: 'New',
  updated: 'Updated',
  skipped: 'Left unchanged',
  duplicate: 'Repeated',
  error: 'Error',
};

function RowsPanel({
  batch,
  initialStatus,
  keptOnly = false,
}: {
  batch: ImportBatchView;
  initialStatus: string;
  keptOnly?: boolean;
}) {
  const [status, setStatus] = useState(initialStatus);
  const rows = useInfiniteQuery({
    queryKey: ['imports', batch.id, 'rows', keptOnly ? 'kept' : status, batch.version],
    queryFn: ({ pageParam }) =>
      api.importRows(batch.id, {
        status: keptOnly ? undefined : status || undefined,
        undo: keptOnly ? 'kept' : undefined,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = rows.data?.pages.flatMap((p) => p.items) ?? [];
  const errors = (batch.startedAt ? batch.counts.error : batch.dryRunCounts?.error) ?? 0;
  // Show the mapped columns first, so a row is easy to recognise.
  const mappedIndexes = batch.columns
    .map((c, i) => (batch.mapping[c] ? i : -1))
    .filter((i) => i >= 0)
    .slice(0, 2);

  return (
    <Panel
      padded={false}
      title={keptOnly ? 'Edited since the import, left alone' : 'Rows'}
      actions={
        <div className="flex flex-wrap items-center gap-[8px]">
          {!keptOnly && (
            <Select
              aria-label="Show rows"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="sm:w-[200px]"
            >
              {ROW_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
          )}
          {!keptOnly && errors > 0 && (
            <a
              href={api.importErrorsUrl(batch.id)}
              download
              className="inline-flex items-center gap-[6px] h-[32px] px-[12px] rounded-pill text-[13px] font-semibold text-primary-ink hover:bg-bg-alt"
            >
              <Download size={15} strokeWidth={1.8} aria-hidden="true" />
              Rows with errors (CSV)
            </a>
          )}
        </div>
      }
    >
      {rows.isPending && <LoadingState rows={4} />}
      {rows.isError && (
        <ErrorState message={errorMessage(rows.error)} onRetry={() => void rows.refetch()} />
      )}
      {rows.isSuccess && items.length === 0 && (
        <p className="m-0 px-[20px] py-[24px] text-[14px] text-ink-2">No rows match this filter.</p>
      )}
      {rows.isSuccess && items.length > 0 && (
        // Focusable so keyboard users can scroll the table sideways on a phone.
        <div
          className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-primary"
          tabIndex={0}
          role="region"
          aria-label={keptOnly ? 'Records left alone' : 'Row results'}
        >
          <table className={tableClass}>
            <thead>
              <tr className={theadRowClass}>
                <th scope="col" className={`${thClass} text-right`}>
                  Row
                </th>
                <th scope="col" className={thClass}>
                  Record
                </th>
                <th scope="col" className={thClass}>
                  Result
                </th>
                <th scope="col" className={thClass}>
                  Details
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.rowNumber} className={rowClass}>
                  <td className={`${tdClass} text-right tabular-nums text-ink-2`}>{r.rowNumber}</td>
                  <td className={`${tdClass} max-w-[260px] truncate`}>
                    {mappedIndexes
                      .map((i) => r.cells[i])
                      .filter(Boolean)
                      .join(' · ') || <span className="text-ink-3">—</span>}
                  </td>
                  <td
                    className={`${tdClass} whitespace-nowrap ${r.status === 'error' ? 'text-danger font-semibold' : 'text-ink'}`}
                  >
                    {ROW_STATUS[r.status]}
                  </td>
                  <td className={`${tdClass} text-ink-2 min-w-[240px]`}>
                    {r.messages.join(' ') || <span className="text-ink-3">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.hasNextPage && (
        <div className="px-[20px] py-[12px] border-t border-line">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void rows.fetchNextPage()}
            disabled={rows.isFetchingNextPage}
          >
            {rows.isFetchingNextPage ? 'Loading…' : 'Show more rows'}
          </Button>
        </div>
      )}
    </Panel>
  );
}
