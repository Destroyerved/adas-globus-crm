import { useId, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DUPLICATE_POLICIES,
  IMPORT_FIELDS,
  ImportMappingInputSchema,
  suggestImportMapping,
  type DuplicatePolicy,
  type ImportBatchView,
  type ImportEntity,
  type Market,
} from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Panel } from '@/components/ui/panel.js';
import { Select } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { useMe, useReferenceLists, UserSelect } from '@/features/shared/list-kit.js';
import {
  errorMessage,
  fieldError,
  tableClass,
  tdClass,
  thClass,
  theadRowClass,
} from '@/features/shared/live-kit.js';
import { api } from '@/lib/api.js';

/**
 * Column mapping (PRD 4.9; DESIGN 6.2: large editors get a full page): which CRM field each
 * column fills, what to do when a record already exists, the source, owner and tags. Saving
 * starts a dry run straight away.
 */

const POLICY_LABELS: Record<DuplicatePolicy, { label: string; help: string }> = {
  fill_blanks: {
    label: 'Fill in blank fields',
    help: 'Existing records keep their values; only empty fields are filled from the file.',
  },
  overwrite: {
    label: 'Replace with the file’s values',
    help: 'Values in the file replace the CRM’s. Blank cells never clear a field.',
  },
  skip: { label: 'Leave unchanged', help: 'Existing records are not touched.' },
};

function sampleOf(batch: ImportBatchView, index: number): string {
  const values = batch.sample.map((row) => row[index] ?? '').filter((v) => v !== '');
  return values.slice(0, 2).join(', ');
}

export function MappingStep({
  batch,
  onCancel,
}: {
  batch: ImportBatchView;
  onCancel?: () => void;
}) {
  const id = useId();
  const me = useMe();
  const lists = useReferenceLists();
  const toast = useToast();
  const queryClient = useQueryClient();
  const sources = lists.data?.['lead_sources'] ?? [];

  const hasMapping = Object.keys(batch.mapping).length > 0;
  const [entity, setEntity] = useState<ImportEntity>(batch.entity);
  const [mapping, setMapping] = useState<Record<string, string>>(() =>
    hasMapping ? batch.mapping : suggestImportMapping(batch.entity, batch.columns),
  );
  const [policy, setPolicy] = useState<DuplicatePolicy>(
    batch.options.duplicatePolicy ?? 'fill_blanks',
  );
  const [source, setSource] = useState(batch.options.source ?? 'Import');
  const [owner, setOwner] = useState(batch.options.ownerUserId ?? '');
  const [market, setMarket] = useState<Market>(batch.options.market ?? 'US');
  const [tags, setTags] = useState((batch.options.tags ?? []).join(', '));
  const [issues, setIssues] = useState<string[]>([]);
  const [templateName, setTemplateName] = useState('');

  const ownerId = owner || me?.id || '';
  const fields = IMPORT_FIELDS[entity];
  const templates = useQuery({
    queryKey: ['import-templates', entity],
    queryFn: () => api.importTemplates(entity),
  });

  const changeEntity = (next: ImportEntity) => {
    setEntity(next);
    setMapping(suggestImportMapping(next, batch.columns));
    setIssues([]);
  };

  const request = useMemo(
    () => ({
      entity,
      mapping,
      version: batch.version,
      options: {
        duplicatePolicy: policy,
        source,
        ownerUserId: ownerId,
        market,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      },
    }),
    [entity, mapping, batch.version, policy, source, ownerId, market, tags],
  );

  const check = useMutation({
    mutationFn: async () => {
      const mapped = await api.setImportMapping(batch.id, request);
      return api.checkImport(batch.id, mapped.version);
    },
    onSuccess: (next) => {
      queryClient.setQueryData(['imports', batch.id], next);
      void queryClient.invalidateQueries({ queryKey: ['imports'] });
    },
  });

  const save = useMutation({
    mutationFn: () => api.saveImportTemplate({ name: templateName.trim(), entity, mapping }),
    onSuccess: (template) => {
      setTemplateName('');
      void templates.refetch();
      toast(`Saved the mapping as “${template.name}”.`, 'success');
    },
  });

  const submit = () => {
    const parsed = ImportMappingInputSchema.safeParse(request);
    if (!parsed.success) {
      setIssues([...new Set(parsed.error.issues.map((i) => i.message))]);
      document.getElementById(`${id}-issues`)?.focus();
      return;
    }
    setIssues([]);
    check.mutate();
  };

  const serverIssue = check.error ? errorMessage(check.error) : null;

  return (
    <div className="space-y-[16px]">
      <Panel title="What’s in this file">
        <fieldset className="border-0 p-0 m-0">
          <legend className="text-label text-ink mb-[8px]">Each row is a</legend>
          <div className="flex flex-wrap gap-[16px] text-[14px]">
            {(['contact', 'company'] as const).map((e) => (
              <label key={e} className="inline-flex items-center gap-[8px] cursor-pointer">
                <input
                  type="radio"
                  name={`${id}-entity`}
                  value={e}
                  checked={entity === e}
                  onChange={() => changeEntity(e)}
                  className="h-[16px] w-[16px] accent-[var(--primary)]"
                />
                {e === 'contact' ? 'Contact (a person)' : 'Company (a firm)'}
              </label>
            ))}
          </div>
        </fieldset>
      </Panel>

      <Panel title="Match columns to CRM fields" padded={false}>
        <div className="px-[20px] py-[12px] flex flex-col sm:flex-row sm:items-end gap-[8px] border-b border-line">
          <label className="grid gap-[6px] text-label text-ink sm:w-[260px]">
            <span>
              Use a saved mapping <em className="not-italic font-normal text-ink-3">(optional)</em>
            </span>
            <Select
              value=""
              onChange={(e) => {
                const t = templates.data?.find((x) => x.id === e.target.value);
                if (!t) return;
                setMapping(
                  Object.fromEntries(
                    batch.columns.filter((c) => t.mapping[c]).map((c) => [c, t.mapping[c] ?? '']),
                  ),
                );
                setIssues([]);
              }}
            >
              <option value="">
                {templates.data && templates.data.length > 0 ? 'Choose…' : 'None saved yet'}
              </option>
              {(templates.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr className={theadRowClass}>
                <th scope="col" className={thClass}>
                  Column in the file
                </th>
                <th scope="col" className={`${thClass} hidden sm:table-cell`}>
                  Example values
                </th>
                <th scope="col" className={thClass}>
                  CRM field
                </th>
              </tr>
            </thead>
            <tbody>
              {batch.columns.map((column, i) => (
                <tr key={column} className="h-[48px] border-b border-line last:border-b-0">
                  <th
                    scope="row"
                    className={`${tdClass} font-semibold text-ink sm:whitespace-nowrap max-w-[160px] sm:max-w-none`}
                  >
                    <span className="block break-words">{column}</span>
                    {/* On a phone the examples sit under the column name, so the field fits. */}
                    <span className="block sm:hidden text-[13px] font-normal text-ink-3 truncate">
                      {sampleOf(batch, i) || '—'}
                    </span>
                  </th>
                  <td
                    className={`${tdClass} hidden sm:table-cell text-ink-2 max-w-[280px] truncate`}
                  >
                    {sampleOf(batch, i) || <span className="text-ink-3">—</span>}
                  </td>
                  <td className={`${tdClass} sm:min-w-[200px]`}>
                    <Select
                      aria-label={`CRM field for ${column}`}
                      value={mapping[column] ?? ''}
                      onChange={(e) => {
                        setMapping((m) => ({ ...m, [column]: e.target.value }));
                        setIssues([]);
                      }}
                    >
                      <option value="">Don’t import</option>
                      {fields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-[20px] py-[12px] border-t border-line flex flex-col sm:flex-row sm:items-end gap-[8px]">
          <label className="grid gap-[6px] text-label text-ink sm:w-[260px]">
            <span>
              Save this mapping as <em className="not-italic font-normal text-ink-3">(optional)</em>
            </span>
            <Input
              value={templateName}
              maxLength={80}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="For example, Apollo export"
            />
          </label>
          <Button
            variant="secondary"
            disabled={!templateName.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save mapping'}
          </Button>
          {save.error && (
            <p role="alert" className="m-0 text-[13px] text-danger">
              {errorMessage(save.error)}
            </p>
          )}
        </div>
      </Panel>

      <Panel title="How to import">
        <div className="grid gap-[16px] md:grid-cols-2">
          <fieldset className="border-0 p-0 m-0 md:col-span-2">
            <legend className="text-label text-ink mb-[8px]">
              When a{' '}
              {entity === 'contact'
                ? 'contact with the same email'
                : 'company with the same website'}{' '}
              is already in the CRM
            </legend>
            <div className="grid gap-[10px]">
              {DUPLICATE_POLICIES.map((p) => (
                <label key={p} className="flex items-start gap-[8px] cursor-pointer text-[14px]">
                  <input
                    type="radio"
                    name={`${id}-policy`}
                    value={p}
                    checked={policy === p}
                    onChange={() => setPolicy(p)}
                    className="mt-[3px] h-[16px] w-[16px] accent-[var(--primary)]"
                  />
                  <span>
                    <span className="text-ink font-medium">{POLICY_LABELS[p].label}</span>
                    <span className="block text-[13px] text-ink-3">{POLICY_LABELS[p].help}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="grid gap-[6px] text-label text-ink">
            <span>Source</span>
            <Select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              invalid={Boolean(fieldError(check.error, 'options.source'))}
            >
              {!sources.includes(source) && <option value={source}>{source}</option>}
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            <span className="text-[13px] font-normal text-ink-3">
              Every imported record keeps this source.
            </span>
          </label>
          <div className="grid gap-[6px] text-label text-ink">
            <label htmlFor={`${id}-owner`}>Owner of new records</label>
            <UserSelect
              id={`${id}-owner`}
              label="Owner of new records"
              value={ownerId}
              onChange={setOwner}
            />
            {fieldError(check.error, 'ownerUserId') && (
              <span className="text-[13px] font-normal text-danger">
                {fieldError(check.error, 'ownerUserId')}
              </span>
            )}
          </div>
          <label className="grid gap-[6px] text-label text-ink">
            <span>Country when the file doesn’t say</span>
            <Select value={market} onChange={(e) => setMarket(e.target.value as Market)}>
              <option value="US">United States</option>
              <option value="CA">Canada</option>
              <option value="OTHER">Other</option>
            </Select>
          </label>
          <label className="grid gap-[6px] text-label text-ink">
            <span>
              Tags <em className="not-italic font-normal text-ink-3">(optional)</em>
            </span>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="For example, spring list, conference"
            />
            <span className="text-[13px] font-normal text-ink-3">
              Separate tags with commas; up to 5.
            </span>
          </label>
        </div>
      </Panel>

      {(issues.length > 0 || serverIssue) && (
        <div
          id={`${id}-issues`}
          tabIndex={-1}
          role="alert"
          className="bg-danger-bg border-l-[3px] border-danger rounded-r-[10px] px-[16px] py-[12px] text-[14px] text-ink"
        >
          <p className="m-0 font-semibold">Fix these before checking the file:</p>
          <ul className="m-0 mt-[4px] pl-[18px]">
            {(issues.length > 0 ? issues : [serverIssue]).map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-[8px]">
        <Button variant="primary" onClick={submit} disabled={check.isPending}>
          {check.isPending ? 'Starting the check…' : 'Check the file'}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Keep the previous check
          </Button>
        )}
        <span className="text-[13px] text-ink-3">
          Checking reads every row and saves nothing. You’ll see what will happen before importing.
        </span>
      </div>
    </div>
  );
}
