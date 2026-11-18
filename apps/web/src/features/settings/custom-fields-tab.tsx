import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import {
  CUSTOM_FIELD_TYPES,
  CreateCustomFieldInputSchema,
  UpdateCustomFieldInputSchema,
  type CreateCustomFieldInput,
  type CustomFieldDefinitionView,
  type CustomFieldType,
  type UpdateCustomFieldInput,
} from '@adas/shared';
import { StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Panel } from '@/components/ui/panel.js';
import { Select } from '@/components/ui/select.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type EntityType } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';
import {
  EditDrawer,
  formError,
  issuesOf,
  serverFieldErrors,
  useDraft,
} from '@/features/records/record-form.js';
import { FormRow } from './settings-kit.js';

const ENTITIES: { id: EntityType; label: string }[] = [
  { id: 'lead', label: 'Leads' },
  { id: 'contact', label: 'Contacts' },
  { id: 'company', label: 'Companies' },
  { id: 'deal', label: 'Deals' },
];

const TYPE_LABEL: Record<CustomFieldType, string> = {
  text: 'Text',
  number: 'Number',
  select: 'Single select',
  multi_select: 'Multi-select',
  boolean: 'Yes / No',
  date: 'Date',
  money: 'Money (USD / CAD)',
  url: 'Website link',
};

function slugifyFieldKey(label: string): string {
  const cleaned = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!cleaned) return '';
  return /^[a-z]/.test(cleaned) ? cleaned : `f_${cleaned}`.slice(0, 40);
}

/**
 * Settings → Custom fields (PRD 4.17, 6.8): manage custom field definitions across
 * Leads, Contacts, Companies and Deals.
 */
export function CustomFieldsTab() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [entity, setEntity] = useState<EntityType>('lead');
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CustomFieldDefinitionView | null>(null);

  const fieldsQuery = useQuery({
    queryKey: ['admin', 'custom-fields', entity, showArchived],
    queryFn: () => api.listCustomFields(entity, showArchived),
  });

  const archiveMutation = useMutation({
    mutationFn: ({ def, archived }: { def: CustomFieldDefinitionView; archived: boolean }) =>
      api.updateCustomField(def.id, { version: def.version, archived }),
    onSuccess: async (_res, vars) => {
      toast(vars.archived ? `Archived "${vars.def.label}".` : `Restored "${vars.def.label}".`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'custom-fields'] }),
        queryClient.invalidateQueries({ queryKey: ['custom-fields'] }),
      ]);
    },
  });

  return (
    <div className="space-y-[16px]" data-testid="settings-custom-fields-tab">
      <div className="flex flex-wrap items-center justify-between gap-[10px]">
        <div className="flex flex-wrap items-center gap-[8px]">
          <div
            role="group"
            aria-label="Record type"
            className="inline-flex flex-wrap gap-[4px] bg-bg-alt p-[4px] rounded-pill"
          >
            {ENTITIES.map((item) => {
              const active = entity === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setEntity(item.id)}
                  className={`h-[30px] px-[12px] rounded-pill text-[13px] font-semibold border-0 cursor-pointer ${
                    active
                      ? 'bg-surface text-ink shadow-xs'
                      : 'bg-transparent text-ink-2 hover:text-ink'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          <label className="inline-flex items-center gap-[6px] text-[13px] text-ink-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="accent-[var(--primary)]"
            />
            Show archived
          </label>
        </div>

        <Button variant="primary" onClick={() => setCreating(true)}>
          Add custom field
        </Button>
      </div>

      {fieldsQuery.isPending ? (
        <LoadingState rows={4} />
      ) : fieldsQuery.isError ? (
        <ErrorState
          message={errorMessage(fieldsQuery.error)}
          onRetry={() => void fieldsQuery.refetch()}
        />
      ) : fieldsQuery.data.length === 0 ? (
        <Panel padded={false}>
          <EmptyState
            title={`No custom fields on ${entity === 'company' ? 'companies' : `${entity}s`}`}
            description="Create typed fields for firm specifics, tax season capacity, or partner preferences. Values are indexed for fast filtering."
            actionLabel="Add custom field"
            onAction={() => setCreating(true)}
          />
        </Panel>
      ) : (
        <Panel title={`Custom fields (${fieldsQuery.data.length})`} padded={false}>
          <ul className="m-0 p-0 list-none divide-y divide-line">
            {fieldsQuery.data.map((def) => {
              const isArchived = def.archivedAt !== null;
              return (
                <li
                  key={def.id}
                  className="px-[16px] py-[12px] flex flex-wrap items-start justify-between gap-[10px]"
                >
                  <div className="min-w-0 space-y-[4px]">
                    <div className="flex flex-wrap items-center gap-[8px]">
                      <span className="font-semibold text-ink break-words">{def.label}</span>
                      <StatusBadge tone="neutral">{TYPE_LABEL[def.fieldType]}</StatusBadge>
                      {def.isRequired && <StatusBadge tone="brand">Required</StatusBadge>}
                      {isArchived && <StatusBadge tone="warning">Archived</StatusBadge>}
                    </div>
                    <div className="text-[12.5px] text-ink-2 break-all">
                      Key: <code>custom.{def.fieldKey}</code>
                      {def.options.length > 0 && ` · Options: ${def.options.join(', ')}`}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-[6px]">
                    <Button variant="secondary" size="sm" onClick={() => setEditing(def)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={archiveMutation.isPending}
                      onClick={() => archiveMutation.mutate({ def, archived: !isArchived })}
                    >
                      {isArchived ? 'Restore' : 'Archive'}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {archiveMutation.isError && (
        <p role="alert" className="m-0 text-[13px] text-danger">
          {errorMessage(archiveMutation.error)}
        </p>
      )}

      {creating && (
        <CreateCustomFieldDrawer
          defaultEntity={entity}
          onClose={() => setCreating(false)}
          onSaved={async (created) => {
            setCreating(false);
            setEntity(created.entityType);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['admin', 'custom-fields'] }),
              queryClient.invalidateQueries({ queryKey: ['custom-fields'] }),
            ]);
          }}
        />
      )}

      {editing && (
        <EditCustomFieldDrawer
          def={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['admin', 'custom-fields'] }),
              queryClient.invalidateQueries({ queryKey: ['custom-fields'] }),
            ]);
          }}
        />
      )}
    </div>
  );
}

function OptionsListEditor({
  options,
  onChange,
  error,
}: {
  options: string[];
  onChange: (next: string[]) => void;
  error?: string;
}) {
  const [adding, setAdding] = useState('');
  const add = (event: FormEvent) => {
    event.preventDefault();
    const clean = adding.trim();
    if (!clean) return;
    if (!options.some((o) => o.toLowerCase() === clean.toLowerCase())) {
      onChange([...options, clean]);
    }
    setAdding('');
  };

  return (
    <div className="space-y-[8px]">
      <div className="text-label text-ink">Choices</div>
      {options.length > 0 && (
        <ul className="m-0 p-0 list-none flex flex-wrap gap-[6px]">
          {options.map((opt) => (
            <li
              key={opt}
              className="inline-flex items-center gap-[4px] h-[28px] pl-[10px] pr-[4px] rounded-pill border border-line-strong bg-surface text-[13px] text-ink"
            >
              {opt}
              <button
                type="button"
                aria-label={`Remove option ${opt}`}
                onClick={() => onChange(options.filter((x) => x !== opt))}
                className="h-[22px] w-[22px] grid place-items-center rounded-pill bg-transparent border-0 text-ink-3 hover:bg-bg-alt hover:text-ink cursor-pointer"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-[8px]">
        <label htmlFor="cf-add-option" className="sr-only">
          Option value
        </label>
        <Input
          id="cf-add-option"
          value={adding}
          placeholder="Type an option and click Add"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(e);
            }
          }}
        />
        <Button variant="secondary" onClick={add}>
          Add
        </Button>
      </div>
      {error && (
        <p role="alert" className="m-0 text-[12.5px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function CreateCustomFieldDrawer({
  defaultEntity,
  onClose,
  onSaved,
}: {
  defaultEntity: EntityType;
  onClose: () => void;
  onSaved: (created: CustomFieldDefinitionView) => void;
}) {
  const toast = useToast();
  const [keyEditedByHand, setKeyEditedByHand] = useState(false);
  const { values, set } = useDraft({
    entityType: defaultEntity,
    label: '',
    fieldKey: '',
    fieldType: 'text' as CustomFieldType,
    options: [] as string[],
    isRequired: false,
    sortOrder: '0',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const needsOptions = values.fieldType === 'select' || values.fieldType === 'multi_select';

  const create = useMutation({
    mutationFn: (payload: CreateCustomFieldInput) => api.createCustomField(payload),
    onSuccess: (created) => {
      toast(`Created "${created.label}".`);
      onSaved(created);
    },
    onError: (err) => setErrors(serverFieldErrors(err)),
  });

  const submit = () => {
    const payload: CreateCustomFieldInput = {
      entityType: values.entityType,
      label: values.label.trim(),
      fieldKey: values.fieldKey.trim().toLowerCase(),
      fieldType: values.fieldType,
      options: needsOptions ? values.options : [],
      isRequired: values.isRequired,
      sortOrder: Number(values.sortOrder) || 0,
    };
    const issues = issuesOf(CreateCustomFieldInputSchema, payload);
    setErrors(issues);
    if (Object.keys(issues).length === 0) {
      create.mutate(payload);
    }
  };

  return (
    <EditDrawer
      title="Add custom field"
      description="Custom fields appear on record pages and can be queried in filters and saved views."
      formId="create-custom-field-form"
      pending={create.isPending}
      error={create.isError && Object.keys(errors).length === 0 ? formError(create.error) : null}
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Create field"
    >
      <FormRow id="cf-entity" label="Record type" error={errors['entityType']}>
        <Select
          id="cf-entity"
          value={values.entityType}
          onChange={(e) => set('entityType', e.target.value as EntityType)}
        >
          {ENTITIES.map((ent) => (
            <option key={ent.id} value={ent.id}>
              {ent.label}
            </option>
          ))}
        </Select>
      </FormRow>

      <FormRow id="cf-label" label="Label" error={errors['label']}>
        <Input
          id="cf-label"
          value={values.label}
          invalid={Boolean(errors['label'])}
          placeholder="Tax season volume"
          onChange={(e) => {
            const nextLabel = e.target.value;
            set('label', nextLabel);
            if (!keyEditedByHand) {
              set('fieldKey', slugifyFieldKey(nextLabel));
            }
          }}
        />
      </FormRow>

      <FormRow
        id="cf-key"
        label="Field key"
        hint="Used in filters as custom.<key>. Cannot be changed after creation."
        error={errors['fieldKey']}
      >
        <Input
          id="cf-key"
          value={values.fieldKey}
          invalid={Boolean(errors['fieldKey'])}
          placeholder="tax_season_volume"
          onChange={(e) => {
            setKeyEditedByHand(true);
            set('fieldKey', e.target.value);
          }}
        />
      </FormRow>

      <div className="grid gap-[12px] sm:grid-cols-2">
        <FormRow id="cf-type" label="Field type" error={errors['fieldType']}>
          <Select
            id="cf-type"
            value={values.fieldType}
            onChange={(e) => set('fieldType', e.target.value as CustomFieldType)}
          >
            {CUSTOM_FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </FormRow>

        <FormRow id="cf-order" label="Display order" error={errors['sortOrder']}>
          <Input
            id="cf-order"
            type="number"
            min={0}
            max={1000}
            value={values.sortOrder}
            onChange={(e) => set('sortOrder', e.target.value)}
          />
        </FormRow>
      </div>

      {needsOptions && (
        <OptionsListEditor
          options={values.options}
          onChange={(next) => set('options', next)}
          error={errors['options']}
        />
      )}

      <label className="flex items-center gap-[8px] text-[13.5px] text-ink cursor-pointer">
        <input
          type="checkbox"
          checked={values.isRequired}
          onChange={(e) => set('isRequired', e.target.checked)}
          className="accent-[var(--primary)]"
        />
        <span>Require a value when editing custom fields on this record type</span>
      </label>
    </EditDrawer>
  );
}

function EditCustomFieldDrawer({
  def,
  onClose,
  onSaved,
}: {
  def: CustomFieldDefinitionView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { values, set } = useDraft({
    label: def.label,
    options: def.options,
    isRequired: def.isRequired,
    sortOrder: String(def.sortOrder),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const needsOptions = def.fieldType === 'select' || def.fieldType === 'multi_select';

  const save = useMutation({
    mutationFn: (payload: UpdateCustomFieldInput) => api.updateCustomField(def.id, payload),
    onSuccess: (updated) => {
      toast(`Saved "${updated.label}".`);
      onSaved();
    },
    onError: (err) => setErrors(serverFieldErrors(err)),
  });

  const submit = () => {
    const payload: UpdateCustomFieldInput = {
      version: def.version,
      label: values.label.trim(),
      ...(needsOptions ? { options: values.options } : {}),
      isRequired: values.isRequired,
      sortOrder: Number(values.sortOrder) || 0,
    };
    const issues = issuesOf(UpdateCustomFieldInputSchema, payload);
    setErrors(issues);
    if (Object.keys(issues).length === 0) {
      save.mutate(payload);
    }
  };

  return (
    <EditDrawer
      title={`Edit ${def.label}`}
      description={`Key: custom.${def.fieldKey} · Type: ${TYPE_LABEL[def.fieldType]}`}
      formId="edit-custom-field-form"
      pending={save.isPending}
      error={save.isError && Object.keys(errors).length === 0 ? formError(save.error) : null}
      onClose={onClose}
      onSubmit={submit}
    >
      <FormRow id="cf-edit-label" label="Label" error={errors['label']}>
        <Input
          id="cf-edit-label"
          value={values.label}
          invalid={Boolean(errors['label'])}
          onChange={(e) => set('label', e.target.value)}
        />
      </FormRow>

      <FormRow id="cf-edit-order" label="Display order" error={errors['sortOrder']}>
        <Input
          id="cf-edit-order"
          type="number"
          min={0}
          max={1000}
          value={values.sortOrder}
          onChange={(e) => set('sortOrder', e.target.value)}
        />
      </FormRow>

      {needsOptions && (
        <OptionsListEditor
          options={values.options}
          onChange={(next) => set('options', next)}
          error={errors['options']}
        />
      )}

      <label className="flex items-center gap-[8px] text-[13.5px] text-ink cursor-pointer">
        <input
          type="checkbox"
          checked={values.isRequired}
          onChange={(e) => set('isRequired', e.target.checked)}
          className="accent-[var(--primary)]"
        />
        <span>Require a value when editing custom fields</span>
      </label>
    </EditDrawer>
  );
}
